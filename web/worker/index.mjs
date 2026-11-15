import { questHandoff } from './quest.mjs';
import catalog from './orbital-catalog.json' with { type: 'json' };

const byHash = new Map(Object.values(catalog.packs).map(pack => [pack.sha, pack]));
const prefix = 'orbital/packs/';
const activeKey = 'orbital/active/' + catalog.id;
const noStore = { 'Cache-Control': 'private, no-store' };

async function inventory(bucket) {
  const found = new Set();
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      const hash = object.key.slice(prefix.length);
      if (byHash.get(hash)?.size === object.size) found.add(hash);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found;
}

function getTile(path) {
  const match = /^\/orbital\/(h|c)\/(\d+)\/([0-5])\/(\d+)\/(\d+)\.(bin|ktx2)$/.exec(path);
  if (!match) return;
  const [, kind, level, face, row, column, suffix] = match;
  if (suffix !== (kind === 'h' ? 'bin' : 'ktx2')) return;
  const y = Number(row), x = Number(column);
  const pack = catalog.packs[[kind, level, face, Math.floor(y / 16), Math.floor(x / 16)].join('/')];
  if (!pack) return;
  const slot = (y % 16) * 16 + (x % 16);
  const raw = Uint8Array.from(atob(pack.offsets), ch => ch.charCodeAt(0));
  const offsets = new DataView(raw.buffer);
  const offset = offsets.getUint32(slot * 4, true);
  const length = offsets.getUint32((slot + 1) * 4, true) - offset;
  if (length) return { key: prefix + pack.sha, range: { offset, length }, suffix };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const bucket = env.BUCKET;
    if (path.startsWith('/api/quest/')) return questHandoff(request, bucket);
    if (path === '/orbital/status.json' && request.method === 'GET') {
      const ready = await bucket.head(activeKey);
      return Response.json(ready ? { maxLevel: catalog.maxLevel, colourMaxLevel: catalog.colourMaxLevel } : {}, { headers: noStore });
    }
    if (path.startsWith('/orbital/') && ['GET', 'HEAD'].includes(request.method)) {
      const tile = getTile(path);
      if (!tile) return new Response(null, { status: 404 });
      const data = await bucket.get(tile.key, { range: tile.range });
      if (!data) return new Response(null, { status: 404 });
      return new Response(request.method === 'HEAD' ? null : data.body, { headers: {
        'Content-Type': tile.suffix === 'ktx2' ? 'image/ktx2' : 'application/octet-stream',
        'Content-Length': String(tile.range.length),
        'Cache-Control': 'private, max-age=86400',
      } });
    }
    // Only known hashes and exact byte counts from this release can enter storage.
    if (path.startsWith('/__orbital/packs/') && request.method === 'PUT') {
      const hash = path.slice('/__orbital/packs/'.length);
      const pack = byHash.get(hash);
      if (!pack || !request.body || Number(request.headers.get('Content-Length')) !== pack.size)
        return new Response('Unrecognized pack or size', { status: 400 });
      if (!await bucket.head(prefix + hash)) {
        await bucket.put(prefix + hash, request.body, { sha256: hash });
      }
      return new Response(null, { status: 204 });
    }
    if (path === '/__orbital/inventory' && request.method === 'GET') {
      return Response.json({ packs: [...await inventory(bucket)] }, { headers: noStore });
    }
    if (path === '/__orbital/activate' && request.method === 'POST') {
      const packs = await inventory(bucket);
      if (packs.size !== byHash.size) return new Response('Incomplete terrain', { status: 409 });
      await bucket.put(activeKey, catalog.id);
      return Response.json({ id: catalog.id }, { headers: noStore });
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response(null, { status: 404 });
  },
};
