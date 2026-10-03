/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

/**
 * Deterministic fixture files for the large-file benchmarks.
 *
 * Each fixture is produced by a streaming writer in about 1 MiB batches with backpressure, so
 * generating a 3 GB file needs a few megabytes of memory, and the same seed always yields the same
 * bytes. Fixtures are cached between runs; they are never committed.
 */

export type FixtureKind = 'sql' | 'jsonl' | 'json' | 'csv' | 'json-minified';

export const FIXTURE_KINDS: readonly FixtureKind[] = [
    'sql',
    'jsonl',
    'json',
    'csv',
    'json-minified',
];

const EXTENSION: Record<FixtureKind, string> = {
    sql: 'sql',
    jsonl: 'jsonl',
    json: 'json',
    csv: 'csv',
    'json-minified': 'json',
};

export interface Fixture {
    path: string;
    kind: FixtureKind;
    bytes: number;
    /** Lines as an editor counts them (newlines + 1). */
    lines: number;
}

const UNITS: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** "100MB", "1.5GB" → bytes. */
export const parseSize = (text: string): number => {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(KB|MB|GB)\s*$/i.exec(text);
    if (!match) throw new Error(`Cannot read the size “${text}”; use e.g. 100MB or 3GB.`);
    return Math.round(Number(match[1]) * UNITS[match[2]!.toUpperCase()]!);
};

/** Small, fast, seedable PRNG (mulberry32). */
const prng = (seed: number) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const WORDS = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
];

const sentence = (random: () => number, words: number): string => {
    let out = '';
    for (let i = 0; i < words; i++)
        out += (i ? ' ' : '') + WORDS[Math.floor(random() * WORDS.length)];
    return out;
};

const hex = (random: () => number, length: number): string => {
    let out = '';
    for (let i = 0; i < length; i++) out += Math.floor(random() * 16).toString(16);
    return out;
};

/** Produces the text of record `index` for a kind, including its own line ending. */
const record = (kind: FixtureKind, index: number, random: () => number, first: boolean): string => {
    const note = sentence(random, 3 + Math.floor(random() * 12));
    const total = (random() * 1000).toFixed(2);
    switch (kind) {
        case 'sql': {
            const insert = `INSERT INTO \`orders\` (\`id\`, \`customer\`, \`total\`, \`note\`) VALUES (${index}, 'cust-${hex(random, 8)}', ${total}, '${note}');\n`;
            // A stored procedure with a custom delimiter now and then: the shapes the SQL scanner
            // (phase 2) must get right, present from the first benchmark.
            if (index > 0 && index % 20_000 === 0) {
                return (
                    `-- block ${index}\nDELIMITER $$\nCREATE PROCEDURE p_${index}()\nBEGIN\n    SELECT 'a;b';\n    UPDATE t SET n = n + 1;\nEND$$\nDELIMITER ;\n` +
                    insert
                );
            }
            return insert;
        }
        case 'jsonl':
            return `{"_id":{"$oid":"${hex(random, 24)}"},"n":${index},"total":${total},"note":"${note}","tags":["a","b"],"nested":{"x":${random().toFixed(4)}}}\n`;
        case 'json':
            return `${first ? '' : ',\n'}{"_id":{"$oid":"${hex(random, 24)}"},"n":${index},"total":${total},"note":"${note}"}`;
        case 'json-minified':
            return `${first ? '' : ','}{"_id":"${hex(random, 24)}","n":${index},"note":"${note}"}`;
        case 'csv':
            return `${index},cust-${hex(random, 8)},${total},"${note}"\n`;
    }
};

const HEADER: Partial<Record<FixtureKind, string>> = {
    json: '[\n',
    'json-minified': '[',
    csv: 'id,customer,total,note\n',
};
const FOOTER: Partial<Record<FixtureKind, string>> = { json: '\n]\n', 'json-minified': ']' };

const countNewlines = (text: string): number => {
    let count = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++;
    return count;
};

const write = async (stream: ReturnType<typeof createWriteStream>, text: string) => {
    if (!stream.write(text)) await once(stream, 'drain');
};

/**
 * Writes a fixture of at least `bytes` bytes (it stops at the first whole record past the target).
 * Returns the exact byte and line counts so a benchmark can check the index against them.
 */
export const generateFixture = async (
    kind: FixtureKind,
    bytes: number,
    path: string,
): Promise<Fixture> => {
    const random = prng(0x5eed + bytes);
    const temporary = `${path}.partial`;
    const stream = createWriteStream(temporary);
    let written = 0;
    let newlines = 0;
    const emit = async (batch: string) => {
        written += Buffer.byteLength(batch);
        newlines += countNewlines(batch);
        await write(stream, batch);
    };

    await emit(HEADER[kind] ?? '');
    let batch = '';
    for (let index = 0; written + batch.length < bytes; index++) {
        batch += record(kind, index, random, index === 0);
        if (batch.length >= 1024 * 1024) {
            await emit(batch);
            batch = '';
        }
    }
    await emit(batch + (FOOTER[kind] ?? ''));
    stream.end();
    await once(stream, 'finish');
    await rename(temporary, path);
    return { path, kind, bytes: written, lines: newlines + 1 };
};

/** The cache directory for fixtures; override with BENCH_DIR. */
export const fixtureDirectory = (): string =>
    process.env.BENCH_DIR ?? join(tmpdir(), 'httpreq-bench');

/** Returns a cached fixture of the exact kind and size, generating it if missing. */
export const ensureFixture = async (kind: FixtureKind, bytes: number): Promise<Fixture> => {
    const directory = fixtureDirectory();
    await mkdir(directory, { recursive: true });
    const base = join(directory, `${kind}-${bytes}.${EXTENSION[kind]}`);
    const manifest = `${base}.json`;
    try {
        const cached = JSON.parse(await readFile(manifest, 'utf8')) as Fixture;
        if ((await stat(base)).size === cached.bytes) return cached;
    } catch {
        // Missing or stale: generate below.
    }
    const fixture = await generateFixture(kind, bytes, base);
    await writeFile(manifest, JSON.stringify(fixture));
    return fixture;
};
