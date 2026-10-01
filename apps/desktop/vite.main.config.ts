/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { defineConfig } from 'vite';

export default defineConfig({
    // Identifiers are mangled and comments dropped, and no source map is written: the packaged
    // main process is not meant to be read back into the original TypeScript.
    esbuild: { legalComments: 'none', drop: ['debugger'] },
    build: {
        ssr: 'src/main.ts',
        outDir: 'dist/main',
        emptyOutDir: true,
        minify: 'esbuild',
        sourcemap: false,
        rollupOptions: {
            // ssh2 and ws load optional native bindings through runtime requires, so they are kept
            // as real dependencies and resolved from node_modules instead of being bundled; so is
            // electron-updater, which reads its feed settings from the app's resources at runtime.
            external: [
                'electron',
                'electron-updater',
                'ssh2',
                'ws',
                '@grpc/grpc-js',
                'mqtt',
                'protobufjs',
            ],
            output: { format: 'es', entryFileNames: 'main.js' },
        },
    },
});
