/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readBuildInfo, versionManifest } from './build-info';

const build = readBuildInfo();

export default defineConfig({
    base: './',
    plugins: [react(), tailwindcss(), versionManifest(build)],
    define: {
        __APP_VERSION__: JSON.stringify(build.version),
        __APP_BUILD__: JSON.stringify(build),
    },
    server: { port: 5173 },
    build: {
        outDir: 'dist',
        // Maps are not written, and so not packaged, unless a build asks for them. `hidden` keeps the
        // `sourceMappingURL` comment out of the bundles, so a browser does not fetch them on its own.
        sourcemap: process.env.HTTPREQ_SOURCEMAPS === '1' ? 'hidden' : false,
        minify: 'esbuild',
    },
    esbuild: { legalComments: 'none', drop: ['debugger'] },
});
