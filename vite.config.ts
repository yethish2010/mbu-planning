import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const basePath = mode === 'production' ? env.VITE_BASE_PATH || '/' : '/';
  return {
    base: basePath,
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || ''),
      'process.env.APP_URL': JSON.stringify(env.APP_URL || env.VITE_APP_URL || ''),
      'process.env.JWT_SECRET': JSON.stringify(env.JWT_SECRET || ''),
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      watch: {
        ignored: ['**/camera-streams/**'],
      },
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
