/*
 * board.ts — glue between the *rules engine* and the *view*.
 *
 * The pattern here is Model-View separation:
 *   Model: `chess.js` knows the rules. It answers "is this move legal?",
 *          "whose turn is it?", "is this checkmate?", and exports PGN/FEN.
 *   View:  `chessground` draws the board and handles pointer/touch input.
 *
 * chessground is deliberately rules-agnostic — you tell it which moves are
 * legal each turn, and it enforces that constraint during drag/drop.
 */

import { Chess, type Square } from 'chess.js';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Config as CgConfig } from 'chessground/config';
import type { Key, Color, Dests } from 'chessground/types';

// A single source of truth for game state. Every UI update reads from here.
const game = new Chess();

let ground: CgApi;

/*
 * chessground wants a Map<from-square, to-squares[]> of legal moves.
 * We compute it from chess.js's `moves({verbose: true})` output.
 * This is called after every move to refresh what the user can do next.
 */
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

// chess.js uses 'w'/'b'; chessground uses 'white'/'black'. Simple translation.
function turnColor(): Color {
  return game.turn() === 'w' ? 'white' : 'black';
}

/*
 * Called by chessground *after* a user completes a drag. chessground has
 * already visually moved the piece; our job is to update the model and
 * either accept the move (updating legal dests for the next player) or,
 * if the move needs a promotion choice, handle that.
 *
 * For a first cut we auto-promote to queen. A real UI would show a picker.
 */
function onUserMove(orig: Key, dest: Key): void {
  const move = game.move({ from: orig as Square, to: dest as Square, promotion: 'q' });
  if (!move) {
    // Illegal — snap piece back. chessground doesn't undo the drag itself
    // when we don't call set(), so we force a re-sync from the model.
    syncGroundFromGame();
    return;
  }
  syncGroundFromGame();
  renderSidePanels();
}

/*
 * Push the current game state into chessground: piece positions, whose turn,
 * legal moves, last-move highlight, check indicator.
 * chessground diffs internally so this is cheap to call repeatedly.
 */
function syncGroundFromGame(): void {
  const history = game.history({ verbose: true });
  const last = history[history.length - 1];

  ground.set({
    fen: game.fen(), // FEN = position encoded as a string
    turnColor: turnColor(),
    check: game.inCheck(),
    lastMove: last ? [last.from as Key, last.to as Key] : undefined,
    movable: {
      color: turnColor(),
      dests: legalDests(),
    },
  });
}

function renderSidePanels(): void {
  const pgnEl = document.getElementById('pgn');
  if (pgnEl) pgnEl.textContent = game.pgn() || '(no moves yet)';

  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = gameStatusText();
}

function gameStatusText(): string {
  if (game.isCheckmate()) return `Checkmate — ${turnColor() === 'white' ? 'Black' : 'White'} wins`;
  if (game.isStalemate()) return 'Stalemate';
  if (game.isDraw()) return 'Draw';
  if (game.inCheck()) return `${turnColor()} to move (check)`;
  return `${turnColor()} to move`;
}

/*
 * Public entry point. Attaches chessground to the given element and wires up
 * the toolbar buttons. Returns nothing — state lives in module scope for now.
 */
export function initBoard(container: HTMLElement): void {
  const config: CgConfig = {
    fen: game.fen(),
    orientation: 'white',
    turnColor: turnColor(),
    movable: {
      free: false,          // only allow moves listed in `dests`
      color: turnColor(),
      dests: legalDests(),
      showDests: true,      // shows the little dots on legal target squares
      events: { after: onUserMove },
    },
    draggable: { showGhost: true },
    // The drawable API is what will let us render teaching arrows/circles.
    // Right-click-drag on desktop, two-finger on mobile draws an arrow.
    drawable: { enabled: true, visible: true },
    highlight: { lastMove: true, check: true },
  };

  ground = Chessground(container, config);
  renderSidePanels();

  document.getElementById('btn-reset')?.addEventListener('click', () => {
    game.reset();
    syncGroundFromGame();
    renderSidePanels();
  });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    game.undo();
    syncGroundFromGame();
    renderSidePanels();
  });

  document.getElementById('btn-flip')?.addEventListener('click', () => {
    ground.toggleOrientation();
  });
}
