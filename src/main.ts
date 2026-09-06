/*
 * main.ts — application entry point. Vite loads this from index.html.
 *
 * Kept intentionally tiny: it just imports the CSS, finds the board container,
 * and hands off to board.ts. Any future initialization (routing, service
 * worker registration hooks, engine worker startup) will branch out from here.
 */

import './style.css';
import { initBoard } from './board';

const boardEl = document.getElementById('board');
if (!boardEl) throw new Error('#board container missing from index.html');

initBoard(boardEl);
