import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// `pnpm dev` and `pnpm preview` (local Vite servers) read PORT/BASE_PATH
// from the shell. `pnpm build` (what Vercel, Netlify, Render static
// hosting run) does not start a server and does not need these vars at
// build time. Earlier versions of this config threw when PORT or
// BASE_PATH were missing, which broke `vite build` on any host that
// doesn't set dev-server env vars — most notably Vercel, which only
// runs the bundle step. We now default both: PORT to 5173 (Vite's
// default) and BASE_PATH to '/'. To use a non-default at dev time,
// set them in the shell before `pnpm dev` / `pnpm preview`.
const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5173;
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});

