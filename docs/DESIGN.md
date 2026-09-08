# Chess Trainer — design

Architecture notes and a tour of the stack. For install and a short product overview, see [README.md](../README.md).

This document explains **why** each piece of the setup exists.

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
- Toolbar: **Setup** / **Review** / Play, reset, undo, ◀ ▶, depth, flip.
- **Setup mode:** place pieces freely (no turns) to build a starting example.
- **Review mode:** step through the recorded game without changing it. Try a different move as a throwaway preview. A Stockfish eval bar sits to the left of the board.
- Side panel: clickable move list (current ply highlighted), plus FEN import/export (copy, file download, file load).

## Files, in the order you should read them

1. **`index.html`** — static shell. Vite injects the compiled JS. Contains
   the `#board` div that chessground mounts into, the setup palette, and
   the FEN/PGN import-export controls.
2. **`src/main.ts`** — entry point. Imports CSS, finds `#board`, calls
   `initBoard`. Deliberately tiny.
3. **`src/board.ts`** — the interesting file. Glues **chess.js** (rules) to
   **chessground** (view), including Play / Setup / Review. Read the comments
   top-to-bottom.
4. **`src/review.ts`** — ply cursor, replay from `rootFen`, preview variation.
   No DOM. Review never mutates the recorded game.
5. **`src/engine.ts`** — Stockfish worker + UCI parse. Lazy-starts on Review.
6. **`src/position.ts`** — FEN/PGN string helpers (normalize, detect, load).
7. **`src/style.css`** — layout + imports for chessground's board/piece CSS.
8. **`vite.config.ts`** — dev server + PWA plugin config.
9. **`public/engine/`** — Stockfish 18 lite-single (`.js` + `.wasm`) and its GPL license.
10. **`tsconfig.json`** — TypeScript in strict mode.

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
Text-based: you send `position fen ...` and `go depth 12`, the engine
streams back `info depth ... score cp ... pv e2e4 e7e5 ...` lines.

Review mode lazy-loads `public/engine/stockfish-18-lite-single.js` as a Web
Worker (not an ES module — do not `import` it into Vite). Depth 8 / 12 / 16 / 20
is a search cap, not Skill Level. Default **12**. The eval bar is the
*position* score (who is better here), from White's perspective.

The bundled engine is Stockfish.js (GPLv3). See `public/engine/COPYING`.
`npm install` copies the files from the `stockfish` package via
`scripts/sync-stockfish.mjs`.

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

### Play vs Setup vs Review

In **Play**, chess.js is the source of truth: chessground may only drag to
squares listed in `dests`. In **Setup**, that constraint is lifted
(`movable.free = true`, `movable.color = 'both'`). Pieces can be dropped
on any square, or dragged off the board (`deleteOnDropOff`) to remove
them. chess.js is updated with `skipValidation: true` so an unfinished
example (missing a king, extra pieces, …) still has a FEN.

Switching back to Play calls `new Chess(fen)` without skip — if the
position is illegal, we stay in Setup and show why.

In **Review**, chess.js history is frozen. ◀ ▶ (and the arrow keys) move a
ply cursor; the board is rebuilt by replaying from the starting FEN.

◀ on the current move **takes it back** without forgetting it: the SAN stays
marked (dashed outline), a yellow arrow shows the recorded from→to, and you
can play a different legal move from that earlier position. **Best move** is
enabled only in that state (your turn, next-move arrow visible); it draws a
green arrow for Stockfish's top choice. While a preview is on the board, ▶
is disabled. **Reset** restores the recorded move from the PGN (it does not
wipe the game). **Back to game** drops the preview but leaves the take-back
in place.

A move that is *not* the recorded one becomes a preview variation — shown
under the move list, never written to the PGN. Drag the preview piece back
to its origin to undo it, or move a different piece of that side: the last
try snaps back and the new move replaces it. Playing the actual recorded
move just puts it back / advances the cursor. Leaving Review discards the
preview and returns to the end of the recorded game.

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
- **Phase 4 (partial):** Stockfish-WASM in a Web Worker, Review mode, eval bar.
  Best-line display and move classification (`??` / `?`) still to come.
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
8. Play a few moves, click **Review**, step with ◀ ▶. The current SAN
   should highlight. Play a different move — the PGN must not change; hit
   **Back to game**. Watch the eval bar and try depth 8 vs 20.
