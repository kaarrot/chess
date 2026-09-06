# Chess Trainer — Phase 0

A PWA for analyzing and training chess. This document explains **why** each
piece of the setup exists, so the scaffold doubles as a tour of the stack.

## Run it

```sh
npm install
npm run dev     # opens on http://localhost:5173
npm run build   # produces dist/ — a static site you can host anywhere
npm run typecheck
```

`npm run dev` is passed `--host`, so Vite binds to `0.0.0.0` and you can open
it from another device on the LAN, or from the Termux/Chrome browser at
`http://localhost:5173`.

## What's on the page

- An 8×8 board rendered by **chessground** (Lichess's board UI).
- Click a piece → dots appear on legal target squares.
- Drag it → chessground enforces that only legal moves are accepted.
- Right-click-drag (desktop) or two-finger drag (mobile) → **teaching arrow**.
- Toolbar: **Setup** / Play, reset, undo, flip.
- **Setup mode:** place pieces freely (no turns) to build a starting example.
- Side panel: live PGN, plus FEN import/export (copy, file download, file load).

## Files, in the order you should read them

1. **`index.html`** — static shell. Vite injects the compiled JS. Contains
   the `#board` div that chessground mounts into, the setup palette, and
   the FEN/PGN import-export controls.
2. **`src/main.ts`** — entry point. Imports CSS, finds `#board`, calls
   `initBoard`. Deliberately tiny.
3. **`src/board.ts`** — the interesting file. Glues **chess.js** (rules) to
   **chessground** (view), including Play vs Setup. Read the comments
   top-to-bottom.
4. **`src/position.ts`** — FEN/PGN string helpers (normalize, detect, load).
   No DOM. This is the format layer Phase 3 builds on.
5. **`src/style.css`** — layout + imports for chessground's board/piece CSS.
6. **`vite.config.ts`** — dev server + PWA plugin config.
7. **`tsconfig.json`** — TypeScript in strict mode.

## Concepts worth internalizing

### FEN
A single-line string that fully encodes a position: piece placement, whose
turn, castling rights, en passant target, halfmove clock, fullmove number.
Starting position: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`.
Every time we call `game.fen()` we get one of these; chessground can render
any FEN via `ground.set({ fen })`.

### PGN
Portable Game Notation — the standard file format for whole games. It's
just move numbers + Standard Algebraic Notation (`1. e4 e5 2. Nf3 Nc6 ...`).
`chess.js` produces and parses this natively, so **saving/loading games is
already free** — Phase 3 is mostly about where to store the string.

### UCI
Universal Chess Interface — the protocol Stockfish (and most engines) speak.
Text-based: you send `position fen ...` and `go depth 15`, the engine
streams back `info depth ... score cp ... pv e2e4 e7e5 ...` lines. Phase 4
is essentially: spawn `stockfish.wasm` in a Web Worker, pipe UCI messages
across `postMessage`, parse `info` lines into a nice eval view.

### Model / View separation
`chess.js` never touches the DOM. `chessground` never knows the rules of
chess — it only knows which moves the caller says are legal. This makes
both testable in isolation and lets you swap either side later (e.g.
different board renderer, or a WASM rules engine for speed).

The dance every move looks like this:

```
user drags piece  ──▶  chessground fires `movable.events.after(from, to)`
                       │
                       ▼
                  we call game.move({from, to, promotion: 'q'})
                       │
                       ▼
                  we call ground.set({ fen, turnColor, dests, ... })
```

If `game.move` returns `null` (illegal — shouldn't happen because we
constrained `dests`, but promotion edge cases exist), we re-sync from the
model, snapping the piece back.

### Play vs Setup

In **Play**, chess.js is the source of truth: chessground may only drag to
squares listed in `dests`. In **Setup**, that constraint is lifted
(`movable.free = true`, `movable.color = 'both'`). Pieces can be dropped
on any square, or dragged off the board (`deleteOnDropOff`) to remove
them. chess.js is updated with `skipValidation: true` so an unfinished
example (missing a king, extra pieces, …) still has a FEN.

Switching back to Play calls `new Chess(fen)` without skip — if the
position is illegal, we stay in Setup and show why.

### Saving a board

A **FEN** is a snapshot of one position (placement, whose turn, castling,
en passant). That's the right export for a composed example.

A **PGN** is a whole game (moves, and optionally a `[FEN "…"]` header if
you started from a custom position). Export PGN after playing through an
example; import PGN to restore the game including the move list.

Paste either format into the sidebar and click **Load**, or use
**Import file**. Chess.js already parses both; the UI is just choosing
which call to make (`game.load` vs `game.loadPgn`).

### Why chessground?
- Battle-tested — it's the actual board on lichess.org, powering millions of games/day.
- Handles the fiddly bits: piece dragging, touch targets, promotion animation, board flipping, coordinate labels, drawing shapes.
- Rules-agnostic → you can plug in variants (chess960, atomic, ...) without fighting the UI.
- Trade-off: opinionated look. Deep visual customization means overriding CSS or forking.

### Why chess.js?
- Complete rules engine including the annoying cases: threefold repetition,
  50-move rule, insufficient material, castling through check, en passant.
- Reads/writes FEN and PGN with one call each.
- Trade-off: pure JS; ~200× slower than a native/WASM engine. That's fine
  for humans clicking, wrong for search. **Move generation for analysis
  will live in Stockfish**, not chess.js.

### Why Vite?
- Native ES modules in dev = no bundling, so hot-reload is instant.
- Rollup under the hood for production builds → small, tree-shaken output.
- First-class PWA plugin.
- Trade-off: newer than webpack, occasional gaps in obscure plugin ecosystems.

### Why the PWA plugin?
- Auto-generates a service worker that caches your build output, so the app
  loads offline after the first visit.
- Generates the web manifest so mobile browsers offer "Install to home screen."
- Trade-off: service workers can be surprising (stale caches, update UX).
  `registerType: 'autoUpdate'` in `vite.config.ts` picks the friendliest
  default — new versions activate on next reload.

### Why TypeScript strict mode?
- `strict: true` + `noUnusedLocals`/`noUnusedParameters` catches whole
  classes of bugs at compile time (null derefs, off-by-one in enums, unused
  vars during refactors).
- Chess types are naturally sum types (`'w' | 'b'`, `'K' | 'Q' | 'R' | ...`)
  which TypeScript models perfectly. You'll feel this most when Phase 4
  parses UCI lines into typed structures.

## Where we're going

- **Phase 1 (done):** legal-move visualization, drag-to-move, teaching arrows, PGN sidebar.
- **Phase 2 (done):** setup/editor mode to place pieces without turns.
- **Phase 3 (partial):** FEN/PGN import and export as copy/paste and files.
  IndexedDB persistence still to come. Annotation UI still to come.
- **Phase 4:** Stockfish-WASM in a Web Worker, eval bar, best-line, move classification.
- **Phase 5:** puzzle mode, opening trainer, play-vs-engine at limited depth.

## Things to try in the browser once it's running

1. Play a full game against yourself. Watch the PGN panel update.
2. Trigger a checkmate (fool's mate: `f3 e5 g4 Qh4#`). Status text should
   announce it and the king should highlight red.
3. Right-click-drag from `e2` to `e4` and back → arrows draw and clear.
4. Hit **Flip board** — chessground redraws from Black's perspective.
5. `game.fen()` in DevTools console after loading `board.ts` — you'll see
   the raw position string that drives everything.
6. Click **Setup**, clear the board, place two kings and a queen, set
   Black to move, **Copy FEN**, then **Play** and finish the mate.
7. Export that FEN, hit Reset, paste it back, **Load** — the example
   should return. Export PGN after a few moves and Load that too.
