/*
 * board.ts — glue between the *rules engine* and the *view*.
 *
 * The pattern here is Model-View separation:
 *   Model: `chess.js` knows the rules. It answers "is this move legal?",
 *          "whose turn is it?", "is this checkmate?", and exports PGN/FEN.
 *   View:  `chessground` draws the board and handles pointer/touch input.
 *
 * Two modes:
 *   play  — chess.js is the source of truth; chessground only offers legal moves.
 *   setup — chessground is the source of truth; pieces can sit anywhere, no turns.
 *           Export still writes a FEN from the board + the side-to-move /
 *           castling flags. Switching back to Play re-validates with chess.js.
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

type Mode = 'play' | 'setup';
type Spare = CgPiece | 'erase';

const ROLES: Role[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const COLORS: Color[] = ['white', 'black'];
const CASTLE_FLAGS = ['K', 'Q', 'k', 'q'] as const;

const game = new Chess();

let ground: CgApi;
let mode: Mode = 'play';
let setupFlags: FenFlags = { ...DEFAULT_FLAGS };
let selectedSpare: Spare | null = null;

function legalDests(): Dests {
  const dests = new Map<Key, Key[]>();
  for (const move of game.moves({ verbose: true })) {
    const from = move.from as Key;
    const to = move.to as Key;
    const arr = dests.get(from) ?? [];
    arr.push(to);
    dests.set(from, arr);
  }
  return dests;
}

function turnColor(): Color {
  return game.turn() === 'w' ? 'white' : 'black';
}

function currentFen(): string {
  if (mode === 'play') return game.fen();
  return buildFen(ground.getFen(), setupFlags);
}

function onUserMove(orig: Key, dest: Key): void {
  const move = game.move({ from: orig as Square, to: dest as Square, promotion: 'q' });
  if (!move) {
    syncGroundFromGame();
    return;
  }
  syncGroundFromGame();
  renderSidePanels();
}

function onSetupChanged(): void {
  if (mode !== 'setup') return;
  // Free moves flip chessground's turnColor; pin it to the editor's side-to-move.
  ground.set({ turnColor: setupFlags.turn === 'w' ? 'white' : 'black', lastMove: undefined });
  // Piece edits invalidate en passant (that flag describes the previous move).
  setupFlags = { ...setupFlags, ep: '-', halfmove: '0', fullmove: '1' };
  renderSidePanels();
}

function syncGroundFromGame(): void {
  const history = game.history({ verbose: true });
  const last = history[history.length - 1];

  ground.set({
    fen: game.fen(),
    turnColor: turnColor(),
    check: game.inCheck(),
    lastMove: last ? [last.from as Key, last.to as Key] : undefined,
    movable: {
      color: turnColor(),
      dests: legalDests(),
    },
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
    });
  } else {
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
    });
    syncGroundFromGame();
  }
}

function renderSidePanels(): void {
  const pgnEl = document.getElementById('pgn');
  if (pgnEl) {
    pgnEl.textContent =
      mode === 'setup' ? '(setup — no move list until you switch to Play)' : game.pgn() || '(no moves yet)';
  }

  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = statusText();

  const fenEl = document.getElementById('fen') as HTMLTextAreaElement | null;
  if (fenEl && document.activeElement !== fenEl) fenEl.value = currentFen();

  const modeBtn = document.getElementById('btn-mode');
  if (modeBtn) {
    modeBtn.textContent = mode === 'setup' ? 'Play' : 'Setup';
    modeBtn.setAttribute('aria-pressed', mode === 'setup' ? 'true' : 'false');
  }

  const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement | null;
  if (undoBtn) undoBtn.disabled = mode === 'setup';

  document.getElementById('setup-panel')?.toggleAttribute('hidden', mode !== 'setup');
  document.getElementById('app')?.classList.toggle('is-setup', mode === 'setup');

  syncSetupForm();
  highlightSpare();
}

function statusText(): string {
  if (mode === 'setup') {
    const err = playabilityError(currentFen());
    if (err) return `Setup — ${err.replace(/^Invalid FEN:\s*/i, '')}`;
    return 'Setup — pick a piece, tap a square. Drag off the board to delete.';
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
  const parsed = parseFen(game.fen());
  setupFlags = {
    turn: parsed.turn,
    castling: parsed.castling,
    ep: parsed.ep,
    halfmove: parsed.halfmove,
    fullmove: parsed.fullmove,
  };
  mode = 'setup';
  setSpare(null);
  applyModeToGround(game.fen());
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
  mode = 'play';
  setSpare(null);
  applyModeToGround();
  renderSidePanels();
  setIoMsg('');
  return true;
}

function toggleMode(): void {
  if (mode === 'play') enterSetup();
  else enterPlay();
}

function resetPosition(): void {
  game.load(START_FEN);
  setupFlags = { ...DEFAULT_FLAGS };
  if (mode === 'setup') applyModeToGround(START_FEN);
  else syncGroundFromGame();
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
  if (!result.ok && mode === 'play' && isFenLike(raw)) {
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
  // Prefer the pasted placement so chess.js cannot strip extra kings etc.
  const viewFen = result.kind === 'fen' ? normalizeFen(raw) : game.fen();
  applyModeToGround(viewFen);
  renderSidePanels();
  setIoMsg(result.kind === 'pgn' ? 'Loaded PGN' : 'Loaded FEN');
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

function bindToolbar(): void {
  document.getElementById('btn-mode')?.addEventListener('click', toggleMode);

  document.getElementById('btn-reset')?.addEventListener('click', () => {
    resetPosition();
  });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (mode === 'setup') return;
    game.undo();
    syncGroundFromGame();
    renderSidePanels();
  });

  document.getElementById('btn-flip')?.addEventListener('click', () => {
    ground.toggleOrientation();
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
  });
}

export function initBoard(container: HTMLElement): void {
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
