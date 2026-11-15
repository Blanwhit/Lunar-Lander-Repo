// A small pool of tileWorker.ts workers for the site API's terrain: a horizon needs a few
// hundred height tiles and decoding one takes ~3 ms, so decoding them one after another on
// the main thread was most of a first query's time (and stalled the globe while it ran).
//
// Workers are started on demand, up to `size`, and stopped again after a while without
// work. Where workers can't be used (Node, a blocked worker script) createTilePool returns
// null or falls back to `local`, the in-thread loader.
import type { DecodedHeightTile } from '../terrain/heightCodec';
import type { TileReply, TileRequest } from './tileWorker';

export interface LoadedTile {
  tile: DecodedHeightTile;
  bytes: number; // size of the tile file
}
export type TileLoader = (url: string) => Promise<LoadedTile>;

const IDLE_MS = 300e3; // stop the workers after this long without a tile to load (starting them again costs a click ~40 ms)

interface Job {
  url: string;
  resolve: (t: LoadedTile) => void;
  reject: (e: unknown) => void;
}
interface Slot {
  worker: Worker;
  jobs: Map<number, Job>;
}

export function createTilePool(local: TileLoader, size = defaultSize()): TileLoader | null {
  if (typeof Worker === 'undefined' || size < 1) return null;
  const slots: Slot[] = [];
  let nextId = 1;
  let broken = false; // a worker failed to start: decode in-thread from now on
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // a worker resolves URLs against its own script, not the page
  const baseHref = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href;

  const stopIdle = () => {
    idleTimer = undefined;
    if (slots.some((s) => s.jobs.size)) return;
    for (const s of slots) s.worker.terminate();
    slots.length = 0;
  };
  const settled = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(stopIdle, IDLE_MS);
  };

  const spawn = (): Slot => {
    const worker = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, jobs: new Map() };
    worker.onmessage = (ev: MessageEvent<TileReply>) => {
      const r = ev.data;
      const job = slot.jobs.get(r.id);
      if (!job) return;
      slot.jobs.delete(r.id);
      if (r.ok) job.resolve({ tile: r.tile, bytes: r.bytes });
      else job.reject(new Error(r.error));
      settled();
    };
    // the worker itself failed (script blocked or crashed): hand its tiles to the in-thread loader
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      broken = true;
      const i = slots.indexOf(slot);
      if (i >= 0) slots.splice(i, 1);
      worker.terminate();
      for (const job of slot.jobs.values()) local(job.url).then(job.resolve, job.reject);
      slot.jobs.clear();
    };
    slots.push(slot);
    return slot;
  };

  return (url) => {
    if (broken) return local(url);
    return new Promise<LoadedTile>((resolve, reject) => {
      // an idle worker, else a new one, else the one with the fewest tiles in flight
      let slot = slots.find((s) => s.jobs.size === 0);
      try {
        if (!slot && slots.length < size) slot = spawn();
      } catch {
        broken = true;
      }
      if (!slot) {
        if (!slots.length) return void local(url).then(resolve, reject);
        slot = slots.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
      }
      const id = nextId++;
      slot.jobs.set(id, { url, resolve, reject });
      slot.worker.postMessage({ id, url: baseHref ? new URL(url, baseHref).href : url } satisfies TileRequest);
    });
  };
}

/** leave cores for the page and the viewer's own tile workers; decoding scales to ~8 */
function defaultSize(): number {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(8, cores - 2));
}
