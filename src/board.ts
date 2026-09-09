/*
 * board.ts — glue between the *rules engine* and the *view*.
 *
 * The pattern here is Model-View separation:
 *   Model: `chess.js` knows the rules. It answers "is this move legal?",
 *          "whose turn is it?", "is this checkmate?", and exports PGN/FEN.
 *   View:  `chessground` draws the board and handles pointer/touch input.
 *
 * Three modes:
 *   play   — chess.js is the source of truth; chessground only offers legal moves.
 *            Moves append to the recorded game.
 *   setup  — chessground is the source of truth; pieces can sit anywhere, no turns.
 *   review — recorded game is frozen. A ply cursor + throwaway variation drive
 *            the board. Stockfish scores the displayed position and, for a try
 *            this turn, whether it is better or worse than the recorded move.
 */

import { Chess, type Square } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Config as CgConfig } from 'chessground/config';
import type { Key, Color, Dests, Role, Piece as CgPiece } from 'chessground/types';
import {
  START_FEN,
  EMPTY_PLACEMENT,
  DEFAULT_FLAGS,
  type FenFlags,
  buildFen,
  parseFen,
  normalizeCastling,
  playabilityError,
  importInto,
  isFenLike,
  normalizeFen,
} from './position';
import {
  type ReplayMove,
  mainlineOf,
  rootFenFromGame,
  replay,
  lastReplayMove,
  matchesNextMainline,
  moveListCells,
  previewText,
  sameReplayMove,
  toReplayMove,
  tryReplaceLastPreview,
} from './review';
import {
  type EngineDepth,
  type EngineInfo,
  type Score,
  DEFAULT_DEPTH,
  ENGINE_DEPTHS,
  analyze,
  barPercent,
  ensureEngine,
  formatMoveComparison,
  formatScore,
  onEngineDone,
  onEngineInfo,
  parseUci,
  readStoredDepth,
  stopAnalysis,
  storeDepth,
  whiteScore,
} from './engine';

type PosEval = { white: Score; depth: number; best?: { orig: Key; dest: Key } };

type Mode = 'play' | 'setup' | 'review';
type Spare = CgPiece | 'erase';

const ROLES: Role[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const COLORS: Color[] = ['white', 'black'];
const CASTLE_FLAGS = ['K', 'Q', 'k', 'q'] as const;

const game = new Chess();

let ground: CgApi;
let mode: Mode = 'play';
let setupFlags: FenFlags = { ...DEFAULT_FLAGS };
let selectedSpare: Spare | null = null;

let rootFen = START_FEN;
/** Main-line ply currently in focus (0 = start). The recorded move is `mainline[ply-1]`. */
let ply = 0;
let variation: ReplayMove[] = [];
/** Main-line prefix length the preview is played from. */
let variationBasePly = 0;
let engineDepth: EngineDepth = DEFAULT_DEPTH;
let lastEval: PosEval | null = null;
let showBestMove = false;

let displayJobId = 0;
let displayFen = '';
let baselineJobId = 0;
let baselineFen = '';
let baselineTurn: 'w' | 'b' = 'w';
let baselineEval: PosEval | null = null;
/** Eval after the first alternative ply, kept if the preview continues. */
let branchEval: PosEval | null = null;
const evalCache = new Map<string, PosEval>();

function replayPly(): number {
  return variation.length ? variationBasePly : ply;
}

/** Recorded main-line move this turn — the one alternatives are compared against. */
function nextRecordedMove(): ReplayMove | undefined {
  return mainlineOf(game)[replayPly()];
}

function isExploring(): boolean {
  return variation.length > 0;
}

function analysisShapes(): { orig: Key; dest: Key; brush: string }[] {
  if (showBestMove && lastEval?.best) {
    return [{ orig: lastEval.best.orig, dest: lastEval.best.dest, brush: 'green' }];
  }
  return [];
}

function paintShapes(): void {
  if (mode !== 'review') return;
  ground.set({ drawable: { autoShapes: analysisShapes() } });
}

function destsOf(chess: Chess): Dests {
  const dests = new Map<Key, Key[]>();
  for (const move of chess.moves({ verbose: true })) {
    const from = move.from as Key;
    const to = move.to as Key;
    const arr = dests.get(from) ?? [];
    arr.push(to);
    dests.set(from, arr);
  }
  return dests;
}

/** Last ply you can swap out: the preview, or the recorded move of this turn. */
function replaceableLast(): { base: number; prefix: ReplayMove[]; last: ReplayMove } | undefined {
  const line = mainlineOf(game);
  if (variation.length) {
    return { base: variationBasePly, prefix: variation.slice(0, -1), last: variation[variation.length - 1] };
  }
  if (ply > 0) return { base: ply - 1, prefix: [], last: line[ply - 1] };
  return undefined;
}

/** Current-position dests, plus dests to replace this turn (or the last preview ply). */
function reviewDests(view: Chess): Dests {
  const dests = destsOf(view);
  const rep = replaceableLast();
  if (!rep) return dests;

  const before = replay(rootFen, mainlineOf(game), rep.base, rep.prefix);
  const pre = destsOf(before);
  const lastFrom = rep.last.from as Key;
  const lastTo = rep.last.to as Key;
  for (const [from, tos] of pre) {
    if (from === lastFrom) continue;
    dests.set(from, tos);
  }
  const alts = new Set<Key>(pre.get(lastFrom) ?? []);
  alts.add(lastFrom);
  alts.delete(lastTo);
  dests.set(lastTo, [...alts]);
  return dests;
}

function reviewMovableColor(view: Chess): Color | 'both' {
  if (variation.length || ply > 0) return 'both';
  return view.turn() === 'w' ? 'white' : 'black';
}

function legalDests(): Dests {
  return destsOf(game);
}

function turnColor(): Color {
  return game.turn() === 'w' ? 'white' : 'black';
}

function displayedChess(): Chess {
  if (mode === 'review') return replay(rootFen, mainlineOf(game), replayPly(), variation);
  return game;
}

function currentFen(): string {
  if (mode === 'setup') return buildFen(ground.getFen(), setupFlags);
  if (mode === 'review') return displayedChess().fen();
  return game.fen();
}

function onUserMove(orig: Key, dest: Key): void {
  const move = game.move({ from: orig as Square, to: dest as Square, promotion: 'q' });
  if (!move) {
    syncGroundFromGame();
    return;
  }
  ply = game.history().length;
  syncGroundFromGame();
  renderSidePanels();
}

function onReviewMove(orig: Key, dest: Key): void {
  const line = mainlineOf(game);
  const promo = 'q';

  if (variation.length) {
    const replaced = tryReplaceLastPreview(
      rootFen,
      line,
      variationBasePly,
      variation,
      orig as Square,
      dest as Square,
      promo,
    );
    if (replaced) {
      acceptVariation(line, replaced);
      return;
    }
  } else if (ply > 0) {
    const replaced = tryReplaceLastPreview(
      rootFen,
      line,
      ply - 1,
      [line[ply - 1]],
      orig as Square,
      dest as Square,
      promo,
    );
    if (replaced) {
      if (!replaced.length) {
        ply -= 1;
        clearVariation();
        syncReview();
        return;
      }
      variationBasePly = ply - 1;
      acceptVariation(line, replaced);
      return;
    }
  }

  if (!variation.length && matchesNextMainline(line, ply, orig, dest, promo)) {
    ply += 1;
    clearVariation();
    syncReview();
    return;
  }

  const view = displayedChess();
  const move = view.move({ from: orig as Square, to: dest as Square, promotion: promo });
  if (!move) {
    syncReview();
    return;
  }
  if (!variation.length) variationBasePly = ply;
  acceptVariation(line, [...variation, toReplayMove(move)]);
}

function clearVariation(): void {
  variation = [];
  baselineEval = null;
  baselineFen = '';
  baselineJobId = 0;
  branchEval = null;
}

/** Play the original move if the try matches it; otherwise keep the preview. */
function acceptVariation(line: ReplayMove[], next: ReplayMove[]): void {
  if (next.length === 0) {
    clearVariation();
    syncReview();
    return;
  }
  const recorded = line[variationBasePly];
  if (next.length === 1 && recorded && sameReplayMove(recorded, next[0])) {
    ply = variationBasePly + 1;
    clearVariation();
    syncReview();
    return;
  }
  variation = next;
  if (next.length === 1) branchEval = null;
  const recordedFen = fenAfterNextRecorded();
  if (recordedFen) {
    if (baselineFen !== recordedFen) {
      baselineFen = recordedFen;
      baselineEval = evalCache.get(recordedFen) ?? null;
    }
  } else {
    baselineEval = null;
    baselineFen = '';
  }
  syncReview();
}

function fenAfterNextRecorded(): string | undefined {
  const line = mainlineOf(game);
  const idx = replayPly();
  if (!line[idx]) return undefined;
  return replay(rootFen, line, idx + 1, []).fen();
}

function onSetupChanged(): void {
  if (mode !== 'setup') return;
  // Free moves flip chessground's turnColor; pin it to the editor's side-to-move.
  ground.set({ turnColor: setupFlags.turn === 'w' ? 'white' : 'black', lastMove: undefined });
  // Piece edits invalidate en passant (that flag describes the previous move).
  setupFlags = { ...setupFlags, ep: '-', halfmove: '0', fullmove: '1' };
  renderSidePanels();
}

function lastMoveKeys(fromReview: boolean): [Key, Key] | undefined {
  if (fromReview) {
    if (variation.length) {
      const last = variation[variation.length - 1];
      return [last.from as Key, last.to as Key];
    }
    const last = lastReplayMove(mainlineOf(game), ply, []);
    return last ? [last.from as Key, last.to as Key] : undefined;
  }
  const history = game.history({ verbose: true });
  const last = history[history.length - 1];
  return last ? [last.from as Key, last.to as Key] : undefined;
}

function syncGroundFromGame(): void {
  ground.set({
    fen: game.fen(),
    turnColor: turnColor(),
    check: game.inCheck(),
    lastMove: lastMoveKeys(false),
    movable: {
      color: turnColor(),
      dests: legalDests(),
    },
  });
}

function syncGroundFromView(): void {
  const view = displayedChess();
  const turn: Color = view.turn() === 'w' ? 'white' : 'black';
  ground.set({
    fen: view.fen(),
    turnColor: turn,
    check: view.inCheck(),
    lastMove: lastMoveKeys(true),
    movable: {
      color: reviewMovableColor(view),
      dests: reviewDests(view),
    },
    drawable: { autoShapes: analysisShapes() },
  });
}

function applyModeToGround(fenForView?: string): void {
  if (mode === 'setup') {
    ground.set({
      fen: fenForView ?? currentFen(),
      turnColor: setupFlags.turn === 'w' ? 'white' : 'black',
      check: false,
      lastMove: undefined,
      autoCastle: false,
      movable: {
        free: true,
        color: 'both',
        dests: undefined,
        showDests: false,
        events: { after: () => onSetupChanged() },
      },
      draggable: { showGhost: true, deleteOnDropOff: true },
      highlight: { lastMove: false, check: false },
      drawable: { autoShapes: [] },
    });
    return;
  }

  if (mode === 'review') {
    const view = displayedChess();
    ground.set({
      autoCastle: true,
      movable: {
        free: false,
        color: reviewMovableColor(view),
        dests: reviewDests(view),
        showDests: true,
        events: { after: onReviewMove },
      },
      draggable: { showGhost: true, deleteOnDropOff: false },
      highlight: { lastMove: true, check: true },
      drawable: { autoShapes: analysisShapes() },
    });
    syncGroundFromView();
    return;
  }

  ground.set({
    autoCastle: true,
    movable: {
      free: false,
      color: turnColor(),
      dests: legalDests(),
      showDests: true,
      events: { after: onUserMove },
    },
    draggable: { showGhost: true, deleteOnDropOff: false },
    highlight: { lastMove: true, check: true },
    drawable: { autoShapes: [] },
  });
  syncGroundFromGame();
}

function renderMoveList(): void {
  const movesEl = document.getElementById('moves');
  if (!movesEl) return;

  if (mode === 'setup') {
    movesEl.replaceChildren();
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = '(setup — no move list until you switch to Play)';
    movesEl.appendChild(empty);
    return;
  }

  const cells = moveListCells(rootFen, mainlineOf(game));
  movesEl.replaceChildren();
  if (!cells.length) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = '(no moves yet)';
    movesEl.appendChild(empty);
    return;
  }

  const replacedPly = variation.length ? variationBasePly + 1 : 0;
  const currentPly = mode === 'play' ? cells.length : ply;
  for (const cell of cells) {
    if (cell.showNumber) {
      const num = document.createElement('span');
      num.className = 'move-no';
      num.textContent = cell.black ? `${cell.number}...` : `${cell.number}.`;
      movesEl.appendChild(num);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'san';
    btn.textContent = cell.san;
    btn.dataset.ply = String(cell.ply);
    if (cell.ply === currentPly) btn.classList.add('current');
    if (mode === 'review' && replacedPly > 0 && cell.ply === replacedPly) {
      btn.classList.add(variation.length ? 'replaced' : 'original');
    }
    if (mode === 'review' && variation.length && cell.ply > variationBasePly + 1) {
      btn.classList.add('muted');
    }
    btn.addEventListener('click', () => jumpToPly(cell.ply));
    movesEl.appendChild(btn);
  }
}

function moveComparison(): ReturnType<typeof formatMoveComparison> | null {
  const played = nextRecordedMove();
  const alt = variation.length === 1 ? lastEval : branchEval;
  if (!played || !variation.length || !alt || !baselineEval) return null;
  const mover = replay(rootFen, mainlineOf(game), variationBasePly, []).turn();
  return formatMoveComparison(baselineEval.white, alt.white, mover, played.san);
}

function renderCmpValue(inPreview: boolean): void {
  const badge = document.getElementById('cmp-value');
  if (!badge) return;
  if (!inPreview) {
    badge.hidden = true;
    badge.replaceChildren();
    badge.className = 'cmp-value';
    return;
  }
  const cmp = moveComparison();
  badge.hidden = false;
  badge.className = `cmp-value ${cmp ? `cmp-${cmp.kind}` : 'is-pending'}`;
  badge.textContent = cmp ? cmp.value : '…';
  badge.title = cmp ? cmp.text : 'Comparing to the recorded move';
}

function renderPreview(): void {
  const lineEl = document.getElementById('preview-line');
  const exitBtn = document.getElementById('btn-exit-preview') as HTMLButtonElement | null;
  const inPreview = mode === 'review' && variation.length > 0;
  if (exitBtn) exitBtn.hidden = !inPreview;
  renderCmpValue(inPreview);
  if (!lineEl) return;
  if (!inPreview) {
    lineEl.hidden = true;
    lineEl.replaceChildren();
    return;
  }

  lineEl.hidden = false;
  lineEl.replaceChildren();
  lineEl.append(`Preview: ${previewText(rootFen, variationBasePly, variation)}`);
  const original = nextRecordedMove()?.san;
  if (!original) return;
  const cmp = moveComparison();
  lineEl.append('  vs ');
  lineEl.append(original);
  if (cmp) {
    const val = document.createElement('span');
    val.className = `cmp-value cmp-${cmp.kind}`;
    val.textContent = cmp.value;
    lineEl.append('  ');
    lineEl.appendChild(val);
    const why = document.createElement('span');
    why.className = `cmp-${cmp.kind}`;
    why.textContent = ` ${cmp.text}`;
    lineEl.appendChild(why);
  } else {
    lineEl.append('  (comparing…)');
  }
}

function renderSidePanels(): void {
  renderMoveList();
  renderPreview();

  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = statusText();

  const fenEl = document.getElementById('fen') as HTMLTextAreaElement | null;
  if (fenEl && document.activeElement !== fenEl) fenEl.value = currentFen();

  const modeBtn = document.getElementById('btn-mode');
  if (modeBtn) {
    modeBtn.textContent = mode === 'setup' ? 'Play' : 'Setup';
    modeBtn.setAttribute('aria-pressed', mode === 'setup' ? 'true' : 'false');
  }

  const reviewBtn = document.getElementById('btn-review') as HTMLButtonElement | null;
  if (reviewBtn) {
    reviewBtn.disabled = mode === 'setup';
    reviewBtn.setAttribute('aria-pressed', mode === 'review' ? 'true' : 'false');
  }

  const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement | null;
  if (undoBtn) undoBtn.disabled = mode !== 'play';

  const prevBtn = document.getElementById('btn-prev') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('btn-next') as HTMLButtonElement | null;
  const depthWrap = document.getElementById('depth-wrap');
  const inSetup = mode === 'setup';
  prevBtn?.toggleAttribute('hidden', inSetup);
  nextBtn?.toggleAttribute('hidden', inSetup);
  depthWrap?.toggleAttribute('hidden', mode !== 'review');

  renderBestButton();

  const exploring = mode === 'review' && isExploring();
  if (prevBtn) {
    prevBtn.disabled = mode === 'review' && !exploring && ply === 0;
    prevBtn.title = exploring ? 'Restore the recorded move' : 'Previous move';
  }
  if (nextBtn) {
    nextBtn.disabled = mode === 'review' && !exploring && ply === game.history().length;
    nextBtn.title = exploring ? 'Restore the recorded move' : 'Next move';
  }

  const resetBtn = document.getElementById('btn-reset') as HTMLButtonElement | null;
  if (resetBtn) {
    resetBtn.title =
      mode === 'review' && isExploring()
        ? 'Restore the recorded move from the PGN'
        : mode === 'review'
          ? 'Jump to the start of the recorded game'
          : 'Reset to the starting position';
  }

  document.getElementById('setup-panel')?.toggleAttribute('hidden', mode !== 'setup');
  document.getElementById('app')?.classList.toggle('is-setup', mode === 'setup');
  document.getElementById('app')?.classList.toggle('is-review', mode === 'review');

  const evalBar = document.getElementById('eval-bar');
  const evalMeta = document.getElementById('eval-meta');
  evalBar?.toggleAttribute('hidden', mode !== 'review');
  evalMeta?.toggleAttribute('hidden', mode !== 'review');

  syncSetupForm();
  highlightSpare();
  paintEvalBar();
}

function statusText(): string {
  if (mode === 'setup') {
    const err = playabilityError(currentFen());
    if (err) return `Setup — ${err.replace(/^Invalid FEN:\s*/i, '')}`;
    return 'Setup — pick a piece, tap a square. Drag off the board to delete.';
  }
  if (mode === 'review') {
    const view = displayedChess();
    const moveNo = parseFen(view.fen()).fullmove;
    const side = view.turn() === 'w' ? 'White' : 'Black';
    const original = nextRecordedMove()?.san;
    const extra = variation.length
      ? ` · preview${original ? ` vs ${original}` : ''}`
      : '';
    return `Review — move ${moveNo} (${side})${extra}`;
  }
  if (game.isCheckmate()) return `Checkmate — ${turnColor() === 'white' ? 'Black' : 'White'} wins`;
  if (game.isStalemate()) return 'Stalemate';
  if (game.isDraw()) return 'Draw';
  if (game.inCheck()) return `${turnColor()} to move (check)`;
  return `${turnColor()} to move`;
}

function syncSetupForm(): void {
  const turnEl = document.getElementById('setup-turn') as HTMLSelectElement | null;
  if (turnEl) turnEl.value = setupFlags.turn;

  for (const flag of CASTLE_FLAGS) {
    const el = document.getElementById(`castle-${flag}`) as HTMLInputElement | null;
    if (el) el.checked = setupFlags.castling.includes(flag);
  }
}

function readSetupForm(): void {
  const turnEl = document.getElementById('setup-turn') as HTMLSelectElement | null;
  const castling = CASTLE_FLAGS.filter((flag) => {
    const el = document.getElementById(`castle-${flag}`) as HTMLInputElement | null;
    return el?.checked;
  }).join('');
  setupFlags = {
    ...setupFlags,
    turn: turnEl?.value === 'b' ? 'b' : 'w',
    castling: normalizeCastling(castling),
  };
}

function setSpare(next: Spare | null): void {
  selectedSpare = next;
  highlightSpare();
}

function highlightSpare(): void {
  document.querySelectorAll<HTMLElement>('#palette .spare').forEach((btn) => {
    const erase = btn.dataset.erase === '1';
    const selected = erase
      ? selectedSpare === 'erase'
      : !!selectedSpare &&
        selectedSpare !== 'erase' &&
        selectedSpare.color === btn.dataset.color &&
        selectedSpare.role === btn.dataset.role;
    btn.classList.toggle('selected', selected);
  });
}

function placeOn(key: Key): void {
  if (!selectedSpare) return;
  if (selectedSpare === 'erase') {
    ground.setPieces(new Map([[key, undefined]]));
  } else {
    const existing = ground.state.pieces.get(key);
    const same =
      existing && existing.role === selectedSpare.role && existing.color === selectedSpare.color;
    ground.setPieces(new Map([[key, same ? undefined : selectedSpare]]));
  }
  onSetupChanged();
}

function pointerPos(e: Event): [number, number] | undefined {
  if ('touches' in e) {
    const t = (e as TouchEvent).touches[0];
    if (!t) return undefined;
    return [t.clientX, t.clientY];
  }
  const m = e as MouseEvent;
  if (typeof m.clientX !== 'number') return undefined;
  return [m.clientX, m.clientY];
}

function onBoardPointerDown(e: Event): void {
  if (mode !== 'setup' || !selectedSpare) return;
  if ('button' in e && (e as MouseEvent).button !== 0) return;
  const pos = pointerPos(e);
  if (!pos) return;
  const key = ground.getKeyAtDomPos(pos);
  if (!key) return;
  e.preventDefault();
  e.stopPropagation();
  placeOn(key);
}

function enterSetup(): void {
  const fen = mode === 'review' ? displayedChess().fen() : game.fen();
  const parsed = parseFen(fen);
  setupFlags = {
    turn: parsed.turn,
    castling: parsed.castling,
    ep: parsed.ep,
    halfmove: parsed.halfmove,
    fullmove: parsed.fullmove,
  };
  if (mode === 'review') {
    clearVariation();
    stopAnalysis();
    lastEval = null;
  }
  mode = 'setup';
  setSpare(null);
  applyModeToGround(fen);
  renderSidePanels();
}

function enterPlay(): boolean {
  const fen = currentFen();
  const err = playabilityError(fen);
  if (err) {
    setIoMsg(err.replace(/^Invalid FEN:\s*/i, ''));
    return false;
  }
  game.load(fen);
  rootFen = fen;
  ply = 0;
  clearVariation();
  mode = 'play';
  setSpare(null);
  applyModeToGround();
  renderSidePanels();
  setIoMsg('');
  return true;
}

function enterReview(nextPly?: number): void {
  if (mode === 'setup') return;
  clearVariation();
  ply = nextPly ?? game.history().length;
  mode = 'review';
  lastEval = null;
  applyModeToGround();
  renderSidePanels();
  void startAnalysis();
}

function exitReview(): void {
  clearVariation();
  ply = game.history().length;
  mode = 'play';
  stopAnalysis();
  lastEval = null;
  applyModeToGround();
  renderSidePanels();
}

function toggleMode(): void {
  if (mode === 'setup') enterPlay();
  else enterSetup();
}

function toggleReview(): void {
  if (mode === 'setup') return;
  if (mode === 'review') exitReview();
  else enterReview();
}

function jumpToPly(next: number): void {
  if (mode === 'setup') return;
  const max = game.history().length;
  const target = Math.max(0, Math.min(max, next));
  if (mode !== 'review') {
    enterReview(target);
    return;
  }
  clearVariation();
  ply = target;
  syncReview();
}

function restoreRecordedMove(): void {
  if (mode !== 'review' || !variation.length) return;
  clearVariation();
  syncReview();
}

function stepBack(): void {
  if (mode === 'setup') return;
  if (mode === 'play') {
    const n = game.history().length;
    enterReview(n > 0 ? n - 1 : 0);
    return;
  }
  if (isExploring()) {
    restoreRecordedMove();
    return;
  }
  if (ply === 0) return;
  ply -= 1;
  syncReview();
}

function stepForward(): void {
  if (mode === 'setup') return;
  if (mode === 'play') {
    enterReview(game.history().length);
    return;
  }
  if (isExploring()) {
    restoreRecordedMove();
    return;
  }
  if (ply === game.history().length) return;
  ply += 1;
  syncReview();
}

function clearPreview(): void {
  restoreRecordedMove();
}

function syncReview(): void {
  applyModeToGround();
  renderSidePanels();
  void startAnalysis();
}

function resetPosition(): void {
  if (mode === 'review') {
    if (isExploring()) {
      restoreRecordedMove();
      return;
    }
    ply = 0;
    clearVariation();
    evalCache.clear();
    syncReview();
    return;
  }
  game.load(START_FEN);
  rootFen = START_FEN;
  setupFlags = { ...DEFAULT_FLAGS };
  ply = 0;
  clearVariation();
  evalCache.clear();
  if (mode === 'setup') applyModeToGround(START_FEN);
  else applyModeToGround();
  renderSidePanels();
}

function clearBoard(): void {
  setupFlags = { ...setupFlags, castling: '-', ep: '-', halfmove: '0', fullmove: '1' };
  applyModeToGround(EMPTY_PLACEMENT);
  renderSidePanels();
}

function loadFromText(raw: string): void {
  let result = importInto(game, raw, mode === 'setup');
  // An illegal FEN is still a valid *example* — open it in Setup instead of
  // failing just because we were in Play.
  if (!result.ok && mode !== 'setup' && isFenLike(raw)) {
    result = importInto(game, raw, true);
    if (result.ok) mode = 'setup';
  }
  if (!result.ok) {
    setIoMsg(result.error);
    return;
  }
  if (result.kind === 'pgn' && mode === 'setup') {
    mode = 'play';
    setSpare(null);
  }
  const parsed = result.kind === 'fen' ? parseFen(normalizeFen(raw)) : parseFen(game.fen());
  setupFlags = {
    turn: parsed.turn,
    castling: parsed.castling,
    ep: parsed.ep,
    halfmove: parsed.halfmove,
    fullmove: parsed.fullmove,
  };
  if (mode === 'play' && playabilityError(game.fen())) {
    mode = 'setup';
  }
  if (mode === 'setup') setSpare(null);
  rootFen = rootFenFromGame(game);
  ply = game.history().length;
  clearVariation();
  evalCache.clear();
  if (mode === 'review') {
    lastEval = null;
  }
  // Prefer the pasted placement so chess.js cannot strip extra kings etc.
  const viewFen = result.kind === 'fen' ? normalizeFen(raw) : game.fen();
  applyModeToGround(viewFen);
  renderSidePanels();
  setIoMsg(result.kind === 'pgn' ? 'Loaded PGN' : 'Loaded FEN');
  if (mode === 'review') void startAnalysis();
}

function exportPgn(): string {
  if (mode === 'setup') {
    return `[SetUp "1"]\n[FEN "${currentFen()}"]\n\n*`;
  }
  return game.pgn() || `[SetUp "1"]\n[FEN "${game.fen()}"]\n\n*`;
}

function downloadText(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function setIoMsg(text: string): void {
  const el = document.getElementById('io-msg');
  if (el) el.textContent = text;
}

async function copyFen(): Promise<void> {
  const fen = currentFen();
  const area = document.getElementById('fen') as HTMLTextAreaElement | null;
  if (area) area.value = fen;
  try {
    await navigator.clipboard.writeText(fen);
    setIoMsg('FEN copied');
  } catch {
    area?.select();
    setIoMsg('Copy the FEN from the text field');
  }
}

function renderBestButton(): void {
  const bestBtn = document.getElementById('btn-best') as HTMLButtonElement | null;
  if (!bestBtn) return;
  const available = mode === 'review' && !isExploring();
  bestBtn.hidden = !available;
  bestBtn.disabled = !available || !lastEval?.best;
  bestBtn.setAttribute('aria-pressed', available && showBestMove ? 'true' : 'false');
}

function paintEvalBar(): void {
  const bar = document.getElementById('eval-bar');
  const fill = bar?.querySelector<HTMLElement>('.eval-white');
  const caption = document.getElementById('eval-caption');
  if (!bar || !fill || !caption) return;
  if (mode !== 'review') return;

  bar.classList.toggle('is-flipped', ground.state.orientation === 'black');

  if (!lastEval) {
    fill.style.height = '50%';
    caption.textContent = `… · d${engineDepth}`;
    return;
  }
  fill.style.height = `${barPercent(lastEval.white)}%`;
  caption.textContent = `${formatScore(lastEval.white)} · d${lastEval.depth}`;
}

function rememberEval(fen: string, ev: PosEval): void {
  const prev = evalCache.get(fen);
  if (!prev || prev.depth <= ev.depth) evalCache.set(fen, ev);
}

function finishedEval(view: Chess): PosEval | null {
  if (view.isCheckmate()) {
    const whiteWins = view.turn() === 'b';
    return { white: { type: 'mate', value: whiteWins ? 1 : -1 }, depth: engineDepth };
  }
  if (view.isStalemate() || view.isDraw()) {
    return { white: { type: 'cp', value: 0 }, depth: engineDepth };
  }
  return null;
}

function applyEngineInfo(info: EngineInfo): void {
  if (mode !== 'review') return;
  const parsed = info.pv[0] ? parseUci(info.pv[0]) : null;
  const best = parsed ? { orig: parsed.orig as Key, dest: parsed.dest as Key } : undefined;
  if (info.id === baselineJobId) {
    baselineEval = {
      white: whiteScore(info.score, baselineTurn),
      depth: info.depth,
      best,
    };
    rememberEval(baselineFen, baselineEval);
    paintEvalBar();
    renderPreview();
    return;
  }
  if (info.id !== displayJobId) return;
  lastEval = {
    white: whiteScore(info.score, displayedChess().turn()),
    depth: info.depth,
    best,
  };
  rememberEval(displayFen, lastEval);
  if (variation.length === 1) branchEval = lastEval;
  paintEvalBar();
  if (showBestMove) paintShapes();
  renderBestButton();
  renderPreview();
}

function onAnalysisDone(id: number): void {
  if (mode !== 'review') return;
  if (id === displayJobId) startBaselineIfNeeded();
}

function startBaselineIfNeeded(): void {
  if (mode !== 'review' || !variation.length) return;
  const fen = fenAfterNextRecorded();
  if (!fen) {
    renderPreview();
    return;
  }
  const pos = replay(rootFen, mainlineOf(game), variationBasePly + 1, []);
  baselineFen = fen;
  baselineTurn = pos.turn();

  const cached = evalCache.get(fen);
  if (cached && cached.depth >= engineDepth) {
    baselineEval = cached;
    paintEvalBar();
    renderPreview();
    return;
  }
  if (cached) {
    baselineEval = cached;
    paintEvalBar();
    renderPreview();
  }

  const terminal = finishedEval(pos);
  if (terminal) {
    baselineEval = terminal;
    rememberEval(fen, terminal);
    paintEvalBar();
    renderPreview();
    return;
  }

  baselineJobId = analyze(fen, engineDepth);
}

async function startAnalysis(): Promise<void> {
  if (mode !== 'review') return;
  lastEval = null;
  showBestMove = false;
  displayJobId = 0;
  baselineJobId = 0;
  paintEvalBar();
  paintShapes();
  renderBestButton();
  renderPreview();

  const view = displayedChess();
  displayFen = view.fen();

  const recordedFen = fenAfterNextRecorded();
  if (variation.length && recordedFen) {
    if (baselineFen !== recordedFen) {
      baselineFen = recordedFen;
      baselineEval = evalCache.get(recordedFen) ?? null;
    }
  } else if (!variation.length) {
    baselineEval = null;
    baselineFen = '';
  }

  const cached = evalCache.get(displayFen);
  if (cached && cached.depth >= engineDepth) {
    lastEval = cached;
    if (variation.length === 1) branchEval = cached;
    paintEvalBar();
    renderBestButton();
    renderPreview();
    startBaselineIfNeeded();
    return;
  }

  const terminal = finishedEval(view);
  if (terminal) {
    stopAnalysis();
    lastEval = terminal;
    rememberEval(displayFen, terminal);
    if (variation.length === 1) branchEval = terminal;
    paintEvalBar();
    renderPreview();
    startBaselineIfNeeded();
    return;
  }

  try {
    await ensureEngine();
  } catch {
    const caption = document.getElementById('eval-caption');
    if (caption) caption.textContent = 'Engine failed to load';
    return;
  }
  if (mode !== 'review') return;
  if (displayedChess().fen() !== displayFen) return;
  displayJobId = analyze(displayFen, engineDepth);
}

function buildPalette(container: HTMLElement): void {
  container.replaceChildren();
  for (const color of COLORS) {
    const row = document.createElement('div');
    row.className = 'palette-row';
    for (const role of ROLES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'spare';
      btn.dataset.color = color;
      btn.dataset.role = role;
      btn.setAttribute('aria-label', `${color} ${role}`);
      const piece = document.createElement('piece');
      piece.className = `${color} ${role}`;
      btn.appendChild(piece);
      btn.addEventListener('click', () => {
        const already =
          selectedSpare &&
          selectedSpare !== 'erase' &&
          selectedSpare.color === color &&
          selectedSpare.role === role;
        setSpare(already ? null : { color, role });
      });
      row.appendChild(btn);
    }
    container.appendChild(row);
  }
  const erase = document.createElement('button');
  erase.type = 'button';
  erase.className = 'spare erase';
  erase.dataset.erase = '1';
  erase.setAttribute('aria-label', 'Erase piece');
  erase.textContent = 'Erase';
  erase.addEventListener('click', () => {
    setSpare(selectedSpare === 'erase' ? null : 'erase');
  });
  container.appendChild(erase);
}

function isTypingTarget(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement
  );
}

function bindToolbar(): void {
  document.getElementById('btn-mode')?.addEventListener('click', toggleMode);
  document.getElementById('btn-review')?.addEventListener('click', toggleReview);

  document.getElementById('btn-reset')?.addEventListener('click', () => {
    resetPosition();
  });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (mode !== 'play') return;
    game.undo();
    ply = game.history().length;
    syncGroundFromGame();
    renderSidePanels();
  });

  document.getElementById('btn-prev')?.addEventListener('click', stepBack);
  document.getElementById('btn-next')?.addEventListener('click', stepForward);
  document.getElementById('btn-exit-preview')?.addEventListener('click', clearPreview);

  document.getElementById('btn-best')?.addEventListener('click', () => {
    if (mode !== 'review' || isExploring() || !lastEval?.best) return;
    showBestMove = !showBestMove;
    paintShapes();
    renderSidePanels();
  });

  const depthEl = document.getElementById('engine-depth') as HTMLSelectElement | null;
  if (depthEl) {
    depthEl.value = String(engineDepth);
    depthEl.addEventListener('change', () => {
      const n = Number(depthEl.value);
      if (!(ENGINE_DEPTHS as readonly number[]).includes(n)) return;
      engineDepth = n as EngineDepth;
      storeDepth(engineDepth);
      if (mode === 'review') void startAnalysis();
    });
  }

  document.getElementById('btn-flip')?.addEventListener('click', () => {
    ground.toggleOrientation();
    paintEvalBar();
  });

  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (mode === 'setup') clearBoard();
  });

  document.getElementById('btn-startpos')?.addEventListener('click', () => {
    if (mode === 'setup') resetPosition();
  });

  document.getElementById('setup-turn')?.addEventListener('change', () => {
    readSetupForm();
    applyModeToGround();
    renderSidePanels();
  });

  for (const flag of CASTLE_FLAGS) {
    document.getElementById(`castle-${flag}`)?.addEventListener('change', () => {
      readSetupForm();
      renderSidePanels();
    });
  }

  document.getElementById('btn-load')?.addEventListener('click', () => {
    const area = document.getElementById('fen') as HTMLTextAreaElement | null;
    loadFromText(area?.value ?? '');
  });

  document.getElementById('btn-copy-fen')?.addEventListener('click', () => {
    void copyFen();
  });

  document.getElementById('btn-export-fen')?.addEventListener('click', () => {
    downloadText('position.fen', currentFen() + '\n');
    setIoMsg('Downloaded position.fen');
  });

  document.getElementById('btn-export-pgn')?.addEventListener('click', () => {
    downloadText('game.pgn', exportPgn() + '\n');
    setIoMsg('Downloaded game.pgn');
  });

  document.getElementById('file-import')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      loadFromText(text);
      input.value = '';
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setSpare(null);
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (isTypingTarget(e.target)) return;
    if (mode === 'setup') return;
    e.preventDefault();
    if (e.key === 'ArrowLeft') stepBack();
    else stepForward();
  });
}

export function initBoard(container: HTMLElement): void {
  engineDepth = readStoredDepth();
  onEngineInfo(applyEngineInfo);
  onEngineDone(onAnalysisDone);

  const config: CgConfig = {
    fen: game.fen(),
    orientation: 'white',
    turnColor: turnColor(),
    movable: {
      free: false,
      color: turnColor(),
      dests: legalDests(),
      showDests: true,
      events: { after: onUserMove },
    },
    draggable: { showGhost: true },
    drawable: { enabled: true, visible: true },
    highlight: { lastMove: true, check: true },
    events: { change: () => onSetupChanged() },
  };

  ground = Chessground(container, config);

  container.addEventListener('mousedown', onBoardPointerDown, true);
  container.addEventListener('touchstart', onBoardPointerDown, { capture: true, passive: false });

  const palette = document.getElementById('palette');
  if (palette) buildPalette(palette);

  bindToolbar();
  renderSidePanels();
}
