#!/usr/bin/env node
/*
 * Copy the lite single-threaded Stockfish worker + WASM into public/engine.
 * Vite serves public/ as static files; the engine must not go through the bundler.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish');
const dest = join(root, 'public', 'engine');

mkdirSync(dest, { recursive: true });

const files = [
  ['bin/stockfish-18-lite-single.js', 'stockfish-18-lite-single.js'],
  ['bin/stockfish-18-lite-single.wasm', 'stockfish-18-lite-single.wasm'],
  ['Copying.txt', 'COPYING'],
];

for (const [from, to] of files) {
  copyFileSync(join(src, from), join(dest, to));
}

console.log('synced stockfish lite-single -> public/engine');
