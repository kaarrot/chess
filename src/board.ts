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
 *            the board. Stockfish scores the displayed position.
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
  currentAnalysisId,
  ensureEngine,
  formatScore,
  onEngineInfo,
  parseUci,
  readStoredDepth,
  stopAnalysis,
  storeDepth,
  whiteScore,
} from './engine';

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
/** True after ◀ takes back the focused move so you can try a replacement. */
let takenBack = false;
let variation: ReplayMove[] = [];
/** Main-line prefix length the preview is played from. */
let variationBasePly = 0;
let engineDepth: EngineDepth = DEFAULT_DEPTH;
let lastEval: { white: Score; depth: number; best?: { orig: Key; dest: Key } } | null = null;
let showBestMove = false;

/** Yellow PGN arrow is up and it's that side's turn (taken back, no preview). */
function nextMoveIsYourTurn(): boolean {
  return mode === 'review' && takenBack && variation.length === 0 && !!recordedMove();
}

function replayPly(): number {
  if (variation.length) return variationBasePly;
  if (takenBack) return Math.max(0, ply - 1);
  return ply;
}

function recordedMove(): ReplayMove | undefined {
  const line = mainlineOf(game);
  if (variation.length) return line[variationBasePly];
  if (takenBack && ply > 0) return line[ply - 1];
  return undefined;
}

function isExploring(): boolean {
  return variation.length > 0 || takenBack;
}

function originalShapes(): { orig: Key; dest: Key; brush: string }[] {
  const move = recordedMove();
  if (!move) return [];
  return [{ orig: move.from as Key, dest: move.to as Key, brush: 'yellow' }];
}

function analysisShapes(): { orig: Key; dest: Key; brush: string }[] {
  const shapes = originalShapes();
  if (showBestMove && lastEval?.best) {
    shapes.push({ orig: lastEval.best.orig, dest: lastEval.best.dest, brush: 'green' });
  }
  return shapes;
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

/** Current-position dests, plus replacement dests for the last preview ply. */
function reviewDests(view: Chess): Dests {
  const dests = destsOf(view);
  if (!variation.length) return dests;

  const last = variation[variation.length - 1];
  const before = replay(rootFen, mainlineOf(game), variationBasePly, variation.slice(0, -1));
  const pre = destsOf(before);
  for (const [from, tos] of pre) {
    if (from === (last.from as Key)) continue;
    dests.set(from, tos);
  }
  const alts = new Set<Key>(pre.get(last.from as Key) ?? []);
  alts.add(last.from as Key);
  alts.delete(last.to as Key);
  dests.set(last.to as Key, [...alts]);
  return dests;
}

function reviewMovableColor(view: Chess): Color | 'both' {
  if (variation.length) return 'both';
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
  const base = replayPly();

  if (variation.length) {
    const replaced = tryReplaceLastPreview(
      rootFen,
      line,
      variationBasePly,
      variation,
      orig as Square,
      dest as Square,
    );
    if (replaced) {
      variation = replaced;
      if (!variation.length) {
        takenBack = variationBasePly === Math.max(0, ply - 1) && ply > 0;
      }
      syncReview();
      return;
    }
  } else if (matchesNextMainline(line, base, variation, orig, dest, 'q')) {
    // Replayed the recorded move: either advance, or put back a taken-back ply.
    if (takenBack) takenBack = false;
    else ply += 1;
    variation = [];
    syncReview();
    return;
  }

  const view = displayedChess();
  const move = view.move({ from: orig as Square, to: dest as Square, promotion: 'q' });
  if (!move) {
    syncReview();
    return;
  }
  if (!variation.length) variationBasePly = base;
  variation = [...variation, toReplayMove(move)];
  syncReview();
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
    const original = recordedMove();
    if (original) return [original.from as Key, original.to as Key];
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

  const replacedPly = variation.length ? variationBasePly + 1 : takenBack ? ply : 0;
  const currentPly =
    mode === 'play'
      ? cells.length
      : variation.length
        ? variationBasePly
        : takenBack
          ? Math.max(0, ply - 1)
          : ply;
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

function renderPreview(): void {
  const lineEl = document.getElementById('preview-line');
  const exitBtn = document.getElementById('btn-exit-preview') as HTMLButtonElement | null;
  const inPreview = mode === 'review' && variation.length > 0;
  const original = recordedMove()?.san;
  const text = inPreview
    ? `Preview: ${previewText(rootFen, variationBasePly, variation)}${original ? `  (PGN: ${original})` : ''}`
    : mode === 'review' && takenBack && original
      ? `Taken back: ${original} — try another move, or Reset to restore it`
      : '';
  if (lineEl) {
    lineEl.hidden = !text;
    lineEl.textContent = text;
  }
  if (exitBtn) exitBtn.hidden = !inPreview;
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

  if (prevBtn) {
    prevBtn.disabled = mode === 'review' && ply === 0 && !takenBack && variation.length === 0;
  }
  if (nextBtn) {
    nextBtn.disabled =
      mode === 'review' && (variation.length > 0 || (!takenBack && ply === game.history().length));
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
  const evalCaption = document.getElementById('eval-caption');
  evalBar?.toggleAttribute('hidden', mode !== 'review');
  evalCaption?.toggleAttribute('hidden', mode !== 'review');

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
    const original = recordedMove()?.san;
    const extra = variation.length
      ? ` · preview${original ? ` vs ${original}` : ''}`
      : takenBack && original
        ? ` · vs ${original}`
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
    variation = [];
    takenBack = false;
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
  variation = [];
  takenBack = false;
  mode = 'play';
  setSpare(null);
  applyModeToGround();
  renderSidePanels();
  setIoMsg('');
  return true;
}

function enterReview(nextPly?: number, takeBack = false): void {
  if (mode === 'setup') return;
  variation = [];
  ply = nextPly ?? game.history().length;
  takenBack = takeBack && ply > 0;
  mode = 'review';
  lastEval = null;
  applyModeToGround();
  renderSidePanels();
  void startAnalysis();
}

function exitReview(): void {
  variation = [];
  takenBack = false;
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
  variation = [];
  takenBack = false;
  ply = target;
  syncReview();
}

function stepBack(): void {
  if (mode === 'setup') return;
  if (mode === 'play') {
    enterReview(game.history().length, true);
    return;
  }
  if (variation.length) {
    variation = variation.slice(0, -1);
    if (!variation.length) {
      takenBack = variationBasePly === Math.max(0, ply - 1) && ply > 0;
    }
  } else if (!takenBack && ply > 0) {
    takenBack = true;
  } else if (ply > 0) {
    ply -= 1;
    takenBack = false;
  }
  syncReview();
}

function stepForward(): void {
  if (mode === 'setup') return;
  if (mode === 'play') {
    enterReview(game.history().length);
    return;
  }
  if (variation.length) return;
  if (takenBack) takenBack = false;
  else ply = Math.min(game.history().length, ply + 1);
  syncReview();
}

function clearPreview(): void {
  if (mode !== 'review' || !variation.length) return;
  takenBack = variationBasePly === Math.max(0, ply - 1) && ply > 0;
  variation = [];
  syncReview();
}

function restoreRecordedMove(): void {
  variation = [];
  takenBack = false;
  syncReview();
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
    takenBack = false;
    variation = [];
    syncReview();
    return;
  }
  game.load(START_FEN);
  rootFen = START_FEN;
  setupFlags = { ...DEFAULT_FLAGS };
  ply = 0;
  variation = [];
  takenBack = false;
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
  variation = [];
  takenBack = false;
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
  const available = nextMoveIsYourTurn();
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

function applyEngineInfo(info: EngineInfo): void {
  if (mode !== 'review') return;
  if (info.id !== currentAnalysisId()) return;
  const turn = displayedChess().turn();
  const parsed = info.pv[0] ? parseUci(info.pv[0]) : null;
  lastEval = {
    white: whiteScore(info.score, turn),
    depth: info.depth,
    best: parsed ? { orig: parsed.orig as Key, dest: parsed.dest as Key } : undefined,
  };
  paintEvalBar();
  if (showBestMove) paintShapes();
  renderBestButton();
}

async function startAnalysis(): Promise<void> {
  if (mode !== 'review') return;
  lastEval = null;
  showBestMove = false;
  paintEvalBar();
  paintShapes();
  renderBestButton();

  const view = displayedChess();
  if (view.isCheckmate()) {
    stopAnalysis();
    const whiteWins = view.turn() === 'b';
    lastEval = { white: { type: 'mate', value: whiteWins ? 1 : -1 }, depth: engineDepth };
    paintEvalBar();
    return;
  }
  if (view.isStalemate() || view.isDraw()) {
    stopAnalysis();
    lastEval = { white: { type: 'cp', value: 0 }, depth: engineDepth };
    paintEvalBar();
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
  analyze(displayedChess().fen(), engineDepth);
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
    if (!nextMoveIsYourTurn() || !lastEval?.best) return;
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
