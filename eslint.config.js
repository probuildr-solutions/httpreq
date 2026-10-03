/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import eslint from '@eslint/js';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * Database Studio's package boundaries (docs/database-studio.md, "Layering"). Each package may
 * import only the internal packages listed here, nothing may import Electron or the UI, and only
 * `file-engine` may touch the file system, so no package can quietly grow a way to read a whole
 * file into memory.
 */
const DB_PACKAGE_DEPENDENCIES = {
    'db-core': [],
    'streaming-engine': ['db-core'],
    'file-engine': ['db-core', 'streaming-engine', 'sql-parser', 'document-engine'],
    'db-workers': ['db-core'],
    'sql-parser': ['db-core'],
    'document-engine': ['db-core'],
    'editor-core': [],
    'db-protocol-mysql': ['db-core', 'streaming-engine'],
    'mysql-engine': ['db-core', 'db-protocol-mysql'],
    'db-protocol-redis': ['db-core', 'streaming-engine'],
    'redis-engine': ['db-core', 'db-protocol-redis'],
    'db-protocol-mongo': ['db-core', 'streaming-engine'],
    'mongo-engine': ['db-core', 'db-protocol-mongo'],
    'db-protocol-postgres': ['db-core', 'streaming-engine'],
    'postgres-engine': ['db-core', 'db-protocol-postgres'],
    'result-engine': ['db-core', 'file-engine'],
    'query-engine': ['db-core', 'file-engine', 'sql-parser', 'result-engine'],
    'connection-manager': ['db-core'],
    'db-host': [
        'db-core',
        'connection-manager',
        'query-engine',
        'result-engine',
        'file-engine',
        'sql-parser',
        'mysql-engine',
        'redis-engine',
        'mongo-engine',
        'postgres-engine',
    ],
};

const NODE_FS = ['node:fs', 'node:fs/promises', 'fs', 'fs/promises'];

/**
 * One package's import rules. Tests may use the file system for their own fixtures; the rule that
 * matters, that product code never touches it, still applies to everything else.
 */
const dbBoundaryConfigs = Object.entries(DB_PACKAGE_DEPENDENCIES).flatMap(([name, allowed]) =>
    [false, true].map((tests) => dbBoundary(name, allowed, tests)),
);

function dbBoundary(name, allowed, tests) {
    // `(?!)` never matches, so a package with no internal dependencies forbids every @httpreq/*.
    const allowedNames = `(?:${[...allowed, 'test-servers'].join('|')})`;
    return {
        files: [tests ? `packages/${name}/src/**/*.test.ts` : `packages/${name}/src/**/*.ts`],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'electron',
                            message: 'Database Studio packages must not depend on Electron.',
                        },
                        {
                            name: 'react',
                            message: 'Database Studio packages must not depend on the UI.',
                        },
                        ...(name === 'file-engine' || tests
                            ? []
                            : NODE_FS.map((path) => ({
                                  name: path,
                                  message: 'Only file-engine may access the file system.',
                              }))),
                    ],
                    patterns: [
                        {
                            // Any @httpreq package that is not on this package's allow list.
                            regex: `^@httpreq/(?!${allowedNames}(?:/|$))`,
                            message: `${name} may only depend on: ${allowed.join(', ') || 'nothing internal'}.`,
                        },
                    ],
                },
            ],
        },
    };
}

/** Reading a whole file into memory is what the large-file architecture exists to prevent. */
const WHOLE_FILE_READS = [
    {
        selector: 'CallExpression[callee.property.name=/^(readFile|readFileSync)$/]',
        message: 'Do not read whole files: stream them through file-engine.',
    },
    {
        selector: 'CallExpression[callee.name=/^(readFile|readFileSync)$/]',
        message: 'Do not read whole files: stream them through file-engine.',
    },
    {
        selector: "CallExpression[callee.property.name='text'][arguments.length=0]",
        message: 'Do not read whole files or bodies with .text(): stream them.',
    },
];

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
    ...dbBoundaryConfigs,
    {
        files: [
            'packages/{db-core,streaming-engine,file-engine,db-workers,sql-parser,document-engine,editor-core,db-protocol-mysql,mysql-engine,db-protocol-redis,redis-engine,db-protocol-mongo,mongo-engine,db-protocol-postgres,postgres-engine,result-engine,query-engine,connection-manager,db-host}/src/**/*.ts',
        ],
        ignores: ['**/*.test.ts', 'packages/file-engine/src/indexStore.ts'],
        rules: { 'no-restricted-syntax': ['error', ...WHOLE_FILE_READS] },
    },
    {
        // Node-run build scripts and CommonJS tool configs (e.g. electron-builder).
        files: [
            '**/*.cjs',
            'apps/desktop/scripts/**/*.mjs',
            'packages/db-workers/src/testWorker.mjs',
        ],
        languageOptions: {
            globals: {
                require: 'readonly',
                module: 'writable',
                console: 'readonly',
                process: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
            },
        },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
);
