import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readBuildInfo, versionManifest } from './build-info';

const build = readBuildInfo();

export default defineConfig({
  base: './',
  plugins: [react(), versionManifest(build)],
  define: {
    __APP_VERSION__: JSON.stringify(build.version),
    __APP_BUILD__: JSON.stringify(build),
  },
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: true },
});
