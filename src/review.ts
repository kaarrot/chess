/*
 * review.ts — recorded-game cursor and throwaway preview lines.
 *
 * The recorded `Chess` instance is never mutated in Review. We keep a ply
 * index into its history plus a variation stack, and rebuild the displayed
 * position by replaying from `rootFen` each time (human games are short).
 */
import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js';
import { parseFen, START_FEN } from './position';

export type ReplayMove = {
  from: Square;
  to: Square;
  san: string;
  promotion?: PieceSymbol;
};

export type SanCell = {
  ply: number;
  san: string;
  number: number;
  showNumber: boolean;
  black: boolean;
};

export function toReplayMove(m: Pick<Move, 'from' | 'to' | 'san' | 'promotion'>): ReplayMove {
  return {
    from: m.from,
    to: m.to,
    san: m.san,
    promotion: m.promotion,
  };
}

export function mainlineOf(game: Chess): ReplayMove[] {
  return game.history({ verbose: true }).map(toReplayMove);
}

/** FEN of the position before the first recorded move. */
export function rootFenFromGame(game: Chess): string {
  if (game.history().length === 0) return game.fen();
  const headerFen = game.getHeaders().FEN;
  if (headerFen) return headerFen;
  const copy = new Chess();
  try {
    copy.loadPgn(game.pgn());
  } catch {
    return START_FEN;
  }
  while (copy.history().length) copy.undo();
  return copy.fen();
}

export function replay(
  rootFen: string,
  mainline: ReplayMove[],
  ply: number,
  variation: ReplayMove[],
): Chess {
  const chess = new Chess(rootFen);
  const n = Math.max(0, Math.min(ply, mainline.length));
  for (const move of mainline.slice(0, n)) apply(chess, move);
  for (const move of variation) apply(chess, move);
  return chess;
}

function apply(chess: Chess, move: ReplayMove): void {
  const result = chess.move({
    from: move.from,
    to: move.to,
    promotion: move.promotion,
  });
  if (!result) {
    throw new Error(`Cannot replay ${move.san} (${move.from}${move.to})`);
  }
}

export function lastReplayMove(
  mainline: ReplayMove[],
  ply: number,
  variation: ReplayMove[],
): ReplayMove | undefined {
  if (variation.length) return variation[variation.length - 1];
  if (ply > 0) return mainline[ply - 1];
  return undefined;
}

/**
 * Drag-back or swap the last preview ply.
 * Dropping the moved piece on its origin undoes it. A legal move from the
 * position *before* that ply replaces it (so you can try another piece
 * without an extra undo). Returns null if this gesture is a continuation.
 */
export function tryReplaceLastPreview(
  rootFen: string,
  mainline: ReplayMove[],
  basePly: number,
  variation: ReplayMove[],
  orig: Square,
  dest: Square,
  promotion: string = 'q',
): ReplayMove[] | null {
  if (!variation.length) return null;
  const last = variation[variation.length - 1];
  if (orig === last.to && dest === last.from) return variation.slice(0, -1);

  const prefix = variation.slice(0, -1);
  const before = replay(rootFen, mainline, basePly, prefix);
  const from = orig === last.to ? last.from : orig;
  if (from === dest) return variation.slice(0, -1);
  try {
    const move = before.move({ from, to: dest, promotion });
    if (!move) return null;
    return [...prefix, toReplayMove(move)];
  } catch {
    return null;
  }
}

export function sameMove(
  move: Pick<ReplayMove, 'from' | 'to' | 'promotion'>,
  from: string,
  to: string,
  promotion?: string,
): boolean {
  if (move.from !== from || move.to !== to) return false;
  if (move.promotion) return (promotion ?? 'q') === move.promotion;
  return true;
}

export function sameReplayMove(a: ReplayMove, b: ReplayMove): boolean {
  return sameMove(a, b.from, b.to, b.promotion);
}

export function matchesNextMainline(
  mainline: ReplayMove[],
  ply: number,
  from: string,
  to: string,
  promotion?: string,
): boolean {
  const next = mainline[ply];
  return !!next && sameMove(next, from, to, promotion);
}

export function moveListCells(rootFen: string, mainline: ReplayMove[]): SanCell[] {
  const start = parseFen(rootFen);
  const startBlack = start.turn === 'b';
  const startFull = parseInt(start.fullmove, 10) || 1;
  return mainline.map((move, i) => {
    const black = startBlack ? i % 2 === 0 : i % 2 === 1;
    const number = startBlack ? startFull + Math.floor((i + 1) / 2) : startFull + Math.floor(i / 2);
    return {
      ply: i + 1,
      san: move.san,
      number,
      showNumber: !black || i === 0,
      black,
    };
  });
}

/** PGN-ish text for the throwaway line, e.g. `12... Nxe4 13. Bxe4`. */
export function previewText(rootFen: string, ply: number, variation: ReplayMove[]): string {
  if (!variation.length) return '';
  const start = parseFen(rootFen);
  let blackTurn = start.turn === 'b';
  let full = parseInt(start.fullmove, 10) || 1;
  for (let i = 0; i < ply; i++) {
    if (blackTurn) full += 1;
    blackTurn = !blackTurn;
  }
  const parts: string[] = [];
  for (const move of variation) {
    if (!blackTurn) {
      parts.push(`${full}. ${move.san}`);
    } else if (parts.length === 0) {
      parts.push(`${full}... ${move.san}`);
    } else {
      parts.push(move.san);
    }
    if (blackTurn) full += 1;
    blackTurn = !blackTurn;
  }
  return parts.join(' ');
}
