import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await build({ entryPoints: ['worker/index.mjs'], bundle: true, format: 'esm', target: 'es2022', outfile: 'dist/server/index.js' });
await mkdir('dist/.openai', { recursive: true });
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
