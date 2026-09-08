/*
 * engine.ts — Stockfish UCI wrapper.
 *
 * The WASM engine is a prebuilt worker in /engine/, not an ES module.
 * We talk to it with UCI strings over postMessage and parse `info` / `bestmove`.
 *
 * Analysis always runs at full strength. Depth is only a search cap
 * (`go depth N`), never Skill Level (that weakens the engine as an opponent).
 */

export const ENGINE_DEPTHS = [8, 12, 16, 20] as const;
export type EngineDepth = (typeof ENGINE_DEPTHS)[number];
export const DEFAULT_DEPTH: EngineDepth = 12;
export const DEPTH_STORAGE_KEY = 'chess-trainer.engine-depth';

const WORKER_URL = '/engine/stockfish-18-lite-single.js';

export type Score = { type: 'cp'; value: number } | { type: 'mate'; value: number };

export type EngineInfo = {
  id: number;
  depth: number;
  score: Score;
  pv: string[];
};

export type EngineListener = (info: EngineInfo) => void;

let worker: Worker | null = null;
let ready = false;
let starting: Promise<void> | null = null;
let analysisId = 0;
let runningId = 0;
let listener: EngineListener | null = null;
let pending: { fen: string; depth: number; id: number } | null = null;
let pumping = false;
let bestmoveWait: (() => void) | null = null;

export function readStoredDepth(): EngineDepth {
  try {
    const raw = localStorage.getItem(DEPTH_STORAGE_KEY);
    const n = raw ? Number(raw) : DEFAULT_DEPTH;
    return (ENGINE_DEPTHS as readonly number[]).includes(n) ? (n as EngineDepth) : DEFAULT_DEPTH;
  } catch {
    return DEFAULT_DEPTH;
  }
}

export function storeDepth(depth: EngineDepth): void {
  try {
    localStorage.setItem(DEPTH_STORAGE_KEY, String(depth));
  } catch {
    /* private mode / disabled storage */
  }
}

export function onEngineInfo(fn: EngineListener | null): void {
  listener = fn;
}

export function ensureEngine(): Promise<void> {
  if (ready) return Promise.resolve();
  if (starting) return starting;

  starting = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Stockfish failed to start'));
    }, 30000);

    try {
      worker = new Worker(WORKER_URL);
    } catch (e) {
      window.clearTimeout(timeout);
      starting = null;
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    worker.onerror = () => {
      window.clearTimeout(timeout);
      starting = null;
      reject(new Error('Stockfish worker error (is public/engine present?)'));
    };

    worker.onmessage = (e: MessageEvent<unknown>) => {
      if (typeof e.data !== 'string') return;
      const line = e.data;
      if (line === 'uciok') {
        worker?.postMessage('isready');
        return;
      }
      if (line === 'readyok') {
        ready = true;
        window.clearTimeout(timeout);
        resolve();
        void pump();
        return;
      }
      handleLine(line);
    };

    worker.postMessage('uci');
  }).catch((err) => {
    starting = null;
    throw err;
  });

  return starting;
}

export function analyze(fen: string, depth: number): number {
  analysisId += 1;
  pending = { fen, depth, id: analysisId };
  if (ready) void pump();
  return analysisId;
}

export function stopAnalysis(): void {
  analysisId += 1;
  pending = null;
  runningId = 0;
  if (ready) worker?.postMessage('stop');
}

export function currentAnalysisId(): number {
  return analysisId;
}

async function pump(): Promise<void> {
  if (pumping || !worker) return;
  pumping = true;
  try {
    while (pending && ready) {
      const job = pending;
      pending = null;
      if (runningId) {
        worker.postMessage('stop');
        await waitForBestmove(150);
      }
      if (job.id !== analysisId) continue;
      runningId = job.id;
      worker.postMessage(`position fen ${job.fen}`);
      worker.postMessage(`go depth ${job.depth}`);
    }
  } finally {
    pumping = false;
    if (pending && ready) void pump();
  }
}

function waitForBestmove(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (bestmoveWait === done) bestmoveWait = null;
      resolve();
    }, ms);
    function done(): void {
      window.clearTimeout(timer);
      resolve();
    }
    bestmoveWait = done;
  });
}

function handleLine(line: string): void {
  if (line.startsWith('bestmove')) {
    const done = bestmoveWait;
    bestmoveWait = null;
    done?.();
    return;
  }
  if (!line.startsWith('info ')) return;
  const parsed = parseInfo(line);
  if (!parsed || !listener || !runningId) return;
  listener({ ...parsed, id: runningId });
}

function parseInfo(line: string): Omit<EngineInfo, 'id'> | null {
  if (line.includes('lowerbound') || line.includes('upperbound')) return null;
  const depth = /(?:^|\s)depth (\d+)/.exec(line);
  const mate = / score mate (-?\d+)/.exec(line);
  const cp = / score cp (-?\d+)/.exec(line);
  if (!depth || (!mate && !cp)) return null;
  const pvMatch = / pv (.+)$/.exec(line);
  const pv = pvMatch ? pvMatch[1].trim().split(/\s+/).filter(Boolean) : [];
  return {
    depth: Number(depth[1]),
    score: mate
      ? { type: 'mate', value: Number(mate[1]) }
      : { type: 'cp', value: Number(cp![1]) },
    pv,
  };
}

/** Convert a side-to-move score into White's perspective. */
export function whiteScore(score: Score, turn: 'w' | 'b'): Score {
  if (turn === 'w') return score;
  return { type: score.type, value: -score.value };
}

/** White-advantage fill, 0–100. Mate is a full bar. */
export function barPercent(white: Score): number {
  if (white.type === 'mate') {
    if (white.value === 0) return 50;
    return white.value > 0 ? 100 : 0;
  }
  const clamped = Math.max(-800, Math.min(800, white.value));
  return 50 + (clamped / 800) * 50;
}

/** First four characters of a UCI move, e.g. `e2e4` or `e7e8q`. */
export function parseUci(uci: string): { orig: string; dest: string } | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(uci)) return null;
  return { orig: uci.slice(0, 2).toLowerCase(), dest: uci.slice(2, 4).toLowerCase() };
}

export function formatScore(white: Score): string {
  if (white.type === 'mate') {
    if (white.value === 0) return '0.0';
    return white.value > 0 ? `#${white.value}` : `#-${Math.abs(white.value)}`;
  }
  const pawns = white.value / 100;
  if (pawns > 0.05) return `+${pawns.toFixed(1)}`;
  if (pawns < -0.05) return `-${Math.abs(pawns).toFixed(1)}`;
  return '0.0';
}
