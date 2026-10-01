/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { defineConfig } from 'vite';

export default defineConfig({
    esbuild: { legalComments: 'none', drop: ['debugger'] },
    build: {
        lib: { entry: 'src/preload.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
        outDir: 'dist/main',
        emptyOutDir: false,
        minify: 'esbuild',
        sourcemap: false,
        rollupOptions: { external: ['electron'] },
    },
});
