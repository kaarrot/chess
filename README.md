# Chess Trainer

A progressive web app for studying chess and reviewing analysis. Play through a
game (or load a PGN/FEN), set up a position, then step the moves in Review
while Stockfish scores the current position on an eval bar. Previews of
sidelines do not change the recorded game. It runs in the browser, works
offline after the first visit, and can be installed to the home screen.

## Get started

```sh
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). `npm run dev` binds to
`0.0.0.0`, so the same URL works from another device on the LAN or from a
Termux/Chrome browser.

```sh
npm run build       # static site in dist/
npm run typecheck
```

Stockfish is copied into `public/engine/` on `npm install` (~7 MB, GPLv3).
The first time you enter Review, the engine loads in a Web Worker.

## Modes

- **Play** — legal moves only; they append to the PGN.
- **Setup** — place pieces freely to build an example, then switch to Play.
- **Review** — walk the game with ◀ ▶ (or arrow keys). At the current
  ply, move a different piece of the side that just played: the recorded
  piece snaps back and the try is scored against that turn (`+0.3` better,
  `-1.2` worse). ◀ or ▶ (or **Back to game** / **Reset**) drops the try
  and restores the recorded move. Drag a try back to its origin, or move
  another piece, to replace it. **Best move** draws Stockfish's suggestion
  in green. Depth 8 / 12 / 16 / 20 (default 12).

Load or export FEN/PGN from the sidebar. Draw teaching arrows with
right-click-drag (or two-finger drag on mobile).

Architecture, file tour, and the stack rationale live in
[docs/DESIGN.md](docs/DESIGN.md).
