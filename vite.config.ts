import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };
const buildId = process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.GITHUB_SHA
  || process.env.VITE_BUILD_ID
  || 'local';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(packageMetadata.version),
    __APP_BUILD_ID__: JSON.stringify(buildId.slice(0, 12)),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        // Only split vendors that every first paint genuinely needs. framer-motion
        // is deliberately absent: naming it as its own chunk made the bundler give
        // that chunk a shared module the entry also imports, which put all 40 kB
        // of it behind a modulepreload on every load — including the login screen,
        // which uses no animation at all. Left unnamed it rides along with the
        // lazy screens that actually animate, for ~2 kB on the react chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react-router')) return 'router';
          if (id.includes('react-dom') || id.includes('/react/')) return 'react';
          return undefined;
        },
      },
    },
  },
  server: { host: '0.0.0.0', port: 3000, strictPort: true },
});
