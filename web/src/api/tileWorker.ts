/// <reference lib="webworker" />
// Fetches + decodes height tiles for the site API (tilePool.ts), so a horizon's few hundred
// tiles are decoded in parallel and off the main thread. Unlike the viewer's heightWorker
// it bakes no normal map: the site API only reads heights.
import { decodeHeightTile, type DecodedHeightTile } from '../terrain/heightCodec';

export interface TileRequest {
  id: number;
  url: string; // absolute
}

export type TileReply =
  | { id: number; ok: true; tile: DecodedHeightTile; bytes: number }
  | { id: number; ok: false; error: string };

self.onmessage = async (ev: MessageEvent<TileRequest>) => {
  const { id, url } = ev.data;
  const post = (self as unknown as Worker).postMessage.bind(self);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const tile = await decodeHeightTile(buf);
    post({ id, ok: true, tile, bytes: buf.byteLength } satisfies TileReply, [tile.q.buffer]);
  } catch (e) {
    post({ id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies TileReply);
  }
};
