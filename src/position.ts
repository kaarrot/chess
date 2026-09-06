/*
 * position.ts — FEN/PGN string helpers with no DOM and no chessground.
 *
 * FEN (Forsyth-Edwards Notation) is six space-separated fields:
 *   1. piece placement, ranks 8→1, '/' between ranks, numbers = empty squares
 *   2. side to move: 'w' or 'b'
 *   3. castling rights: subset of KQkq, or '-'
 *   4. en passant target square, or '-'
 *   5. halfmove clock (50-move rule)
 *   6. fullmove number
 *
 * chessground only knows field 1. chess.js needs all six. These helpers
 * fill in defaults so a placement-only paste still loads.
 */

import { Chess, validateFen } from 'chess.js';

export const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const EMPTY_PLACEMENT = '8/8/8/8/8/8/8/8';

export type FenFlags = {
  turn: 'w' | 'b';
  castling: string;
  ep: string;
  halfmove: string;
  fullmove: string;
};

export const DEFAULT_FLAGS: FenFlags = {
  turn: 'w',
  castling: 'KQkq',
  ep: '-',
  halfmove: '0',
  fullmove: '1',
};

const CASTLE_ORDER = ['K', 'Q', 'k', 'q'] as const;

export function isFenLike(text: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? '';
  return first.split('/').length === 8;
}

export function normalizeFen(input: string): string {
  const parts = input.trim().split(/\s+/);
  return [
    parts[0] ?? EMPTY_PLACEMENT,
    parts[1] === 'b' ? 'b' : parts[1] === 'w' ? 'w' : 'w',
    parts[2] ?? '-',
    parts[3] ?? '-',
    parts[4] ?? '0',
    parts[5] ?? '1',
  ].join(' ');
}

export function parseFen(fen: string): { placement: string } & FenFlags {
  const [placement, turn, castling, ep, halfmove, fullmove] = normalizeFen(fen).split(' ');
  return {
    placement,
    turn: turn === 'b' ? 'b' : 'w',
    castling: castling || '-',
    ep: ep || '-',
    halfmove: halfmove || '0',
    fullmove: fullmove || '1',
  };
}

export function buildFen(placement: string, flags: FenFlags): string {
  return [
    placement,
    flags.turn,
    flags.castling || '-',
    flags.ep,
    flags.halfmove,
    flags.fullmove,
  ].join(' ');
}

/** Keep KQkq in canonical order; drop unknown characters. */
export function normalizeCastling(raw: string): string {
  if (!raw || raw === '-') return '-';
  const next = CASTLE_ORDER.filter((flag) => raw.includes(flag)).join('');
  return next || '-';
}

/**
 * Why a position can't be played. `validateFen` catches structural problems
 * (missing king, pawns on the 1st rank). `new Chess(fen)` catches the rest
 * (e.g. the side not to move is already in check).
 */
export function playabilityError(fen: string): string | null {
  const v = validateFen(fen);
  if (!v.ok) return v.error ?? 'Invalid FEN';
  try {
    new Chess(fen);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export type ImportOk = { ok: true; kind: 'fen' | 'pgn'; fen: string };
export type ImportErr = { ok: false; error: string };
export type ImportResult = ImportOk | ImportErr;

/**
 * Load a pasted FEN or PGN into `game`. Illegal FENs are allowed only when
 * `allowIllegalFen` is true (setup mode), via chess.js `skipValidation`.
 */
export function importInto(game: Chess, raw: string, allowIllegalFen: boolean): ImportResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Nothing to load' };

  if (isFenLike(text)) {
    const fen = normalizeFen(text);
    try {
      game.load(fen, { skipValidation: allowIllegalFen });
      return { ok: true, kind: 'fen', fen: game.fen() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Invalid FEN' };
    }
  }

  try {
    game.loadPgn(text);
    return { ok: true, kind: 'pgn', fen: game.fen() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid PGN' };
  }
}
