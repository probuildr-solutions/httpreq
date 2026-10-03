/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { defineConfig } from 'vitest/config';

/**
 * Database Studio benchmarks. Kept out of `npm test`: they generate multi-gigabyte fixtures and
 * take minutes. Run them with `npm run bench:db` (see bench/db-studio/README.md).
 */
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['bench/**/*.bench.ts'],
        testTimeout: 30 * 60 * 1000,
        hookTimeout: 30 * 60 * 1000,
        // One file at a time: two scans competing for the disk would distort each other.
        fileParallelism: false,
        pool: 'forks',
    },
});
