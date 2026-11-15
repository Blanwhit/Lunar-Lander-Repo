import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// Dev-only helper used for automated visual verification: POST /__shot/<name>.png
// writes the request body to ../data/shots/. Not part of the production build.
function shotSink(): Plugin {
  const dir = resolve(__dirname, '../data/shots');
  return {
    name: 'shot-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot/', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          mkdirSync(dir, { recursive: true });
          const name = basename(req.url || 'shot.png').replace(/[^\w.-]/g, '_') || 'shot.png';
          writeFileSync(resolve(dir, name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [shotSink()],
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1200 },
  server: { port: 5173 },
});
