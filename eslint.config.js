/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import eslint from '@eslint/js';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/dist-types/**',
            '**/coverage/**',
            '**/node_modules/**',
            '**/release/**',
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        plugins: { 'react-hooks': hooks, 'react-refresh': refresh },
        rules: {
            ...hooks.configs.recommended.rules,
            'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
    {
        // Node-run build scripts and CommonJS tool configs (e.g. electron-builder).
        files: ['**/*.cjs', 'apps/desktop/scripts/**/*.mjs'],
        languageOptions: {
            globals: {
                require: 'readonly',
                module: 'writable',
                console: 'readonly',
                process: 'readonly',
            },
        },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
);
