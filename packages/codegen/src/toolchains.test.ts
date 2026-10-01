/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    goDialect,
    javaDialect,
    jsDialect,
    powershellDialect,
    pythonDialect,
    wellFormed,
    type StringDialect,
} from './core/dialects';
import { createDefaultCodegenRegistry } from './index';
import { FIXTURES } from './testing/fixtures';

/**
 * Runs generated code through the real compilers and interpreters. This is how string escaping
 * and syntax are known to be right, rather than assumed from reading the output. It needs those
 * toolchains installed, so it only runs on request:
 *
 *   HTTPREQ_TOOLCHAIN_TESTS=1 npx vitest run packages/codegen/src/toolchains.test.ts
 *
 * Each language is skipped when its tool is not on the PATH.
 */
const enabled = process.env.HTTPREQ_TOOLCHAIN_TESTS === '1';

const available = (command: string, args: string[]): boolean => {
    try {
        execFileSync(command, args, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const run = (command: string, args: string[], cwd?: string): string =>
    execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });

const registry = createDefaultCodegenRegistry();
const scratch = mkdtempSync(join(tmpdir(), 'httpreq-codegen-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const generate = (id: string, fixture: string): string => {
    const result = registry.generate(FIXTURES[fixture]!, id);
    if (!result.supported) throw new Error(result.reason);
    return result.code;
};

/** Text a literal must survive: quotes, backslashes, delimiters, line separators, emoji. */
const HOSTILE = [
    'plain',
    'back`tick ${x} """triple""" \'\'\'single\'\'\' \u2028 \u0085 😀 \\u0041 \\n',
    'tab\there',
    'ends with backslash\\',
    'ends with quote"',
    "ends with single'",
    'line1\nline2\n',
    'no trailing newline\nsecond',
    '{\n    "a": "x\\ny",\n    "b": [1, 2],\n  "q": "\\"\\""\n}\n',
    '<a>\n  <b attr="x">back`tick ${x}</b>\n  <c>"""</c>\n  <d>\\u0041 \\n</d>\n  <e>BODY</e>\n  <f>\'@</f>\n</a>',
    'indented\n    four\n        eight\n',
    'blank\n\nlines\n\n\nhere',
    'quotes """" four and ""\\" mix',
    'unicode é ü 日本語 🎉',
    'curly \u2018 \u2019 \u201a \u201b \u201c \u201d',
    'ctrl \u0001 \u007f',
    'cr\r\nlf',
    'raw #" hash """# end \\#( x',
];

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

/** Each text as its literal, in block form when the dialect offers it for that text. */
const literals = (dialect: StringDialect, indent: string, prepare = (text: string) => text) =>
    HOSTILE.map((raw) => {
        const text = prepare(raw);
        const block = text.includes('\n') ? dialect.block(text, indent) : null;
        return { text, expression: block ?? dialect.literal(text) };
    });

describe.skipIf(!enabled)('string literals mean what the text says', () => {
    it('JavaScript', () => {
        for (const { text, expression } of literals(jsDialect, '')) {
            expect(eval(`(${expression})`), expression).toBe(text);
        }
    });

    it.skipIf(!available('python', ['--version']))('Python', () => {
        const items = literals(pythonDialect, '');
        const file = join(scratch, 'literals.py');
        writeFileSync(
            file,
            `import json, sys\nvalues = [\n${items.map((i) => `${i.expression},`).join('\n')}\n]\nsys.stdout.write(json.dumps([v.encode("utf-8", "surrogatepass").hex() for v in values]))\n`,
        );
        const out = JSON.parse(run('python', [file])) as string[];
        items.forEach((item, index) => expect(out[index], item.expression).toBe(hex(item.text)));
    });

    it.skipIf(!available('javac', ['-version']))('Java', () => {
        const items = literals(javaDialect, '        ');
        const folder = join(scratch, 'literals-java');
        mkdirSync(folder);
        writeFileSync(
            join(folder, 'Main.java'),
            `public class Main {\n    public static void main(String[] args) {\n        String[] values = {\n${items.map((i) => `        ${i.expression},`).join('\n')}\n        };\n        StringBuilder out = new StringBuilder();\n        for (String v : values) {\n            for (byte b : v.getBytes(java.nio.charset.StandardCharsets.UTF_8)) out.append(String.format("%02x", b));\n            out.append("\\n");\n        }\n        System.out.print(out);\n    }\n}\n`,
        );
        run('javac', ['-encoding', 'UTF-8', 'Main.java'], folder);
        const out = run('java', ['-cp', '.', 'Main'], folder).split('\n');
        items.forEach((item, index) => {
            // A text block drops trailing whitespace from each line by design.
            const expected = item.expression.startsWith('"""')
                ? hex(item.text.replace(/[ \t]+$/gm, ''))
                : hex(item.text);
            expect(out[index], item.expression).toBe(expected);
        });
    });

    it.skipIf(!available('go', ['version']))('Go', () => {
        const items = literals(goDialect, '', wellFormed);
        const folder = join(scratch, 'literals-go');
        mkdirSync(folder);
        writeFileSync(
            join(folder, 'main.go'),
            `package main\n\nimport (\n\t"encoding/hex"\n\t"fmt"\n)\n\nfunc main() {\n\tvalues := []string{\n${items.map((i) => `${i.expression},`).join('\n')}\n\t}\n\tfor _, v := range values {\n\t\tfmt.Println(hex.EncodeToString([]byte(v)))\n\t}\n}\n`,
        );
        writeFileSync(join(folder, 'go.mod'), 'module literals\n\ngo 1.21\n');
        const out = run('go', ['run', '.'], folder).split(/\r?\n/);
        items.forEach((item, index) => expect(out[index], item.expression).toBe(hex(item.text)));
    });

    it.skipIf(!available('powershell', ['-NoProfile', '-Command', 'exit 0']))('PowerShell', () => {
        const items = literals(powershellDialect, '');
        const file = join(scratch, 'literals.ps1');
        // Windows PowerShell reads a file without a BOM as ANSI.
        writeFileSync(
            file,
            `\ufeff$values = @(\n${items.map((i) => `${i.expression},`).join('\n')}\n$null)\nforeach ($v in $values) { if ($null -ne $v) { [BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($v)).Replace('-','').ToLower() } }\n`,
            'utf8',
        );
        const out = run('powershell', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            file,
        ]).split(/\r?\n/);
        items.forEach((item, index) => {
            // A here-string reads line breaks as the platform's own; fold CRLF for the comparison.
            expect(out[index]?.replace(/0d0a/g, '0a'), item.expression).toBe(
                hex(item.text).replace(/0d0a/g, '0a'),
            );
        });
    });
});

describe.skipIf(!enabled)('generated programs compile', () => {
    it.skipIf(!available('python', ['--version']))('Python', () => {
        for (const fixture of Object.keys(FIXTURES)) {
            const file = join(scratch, `python-${fixture}.py`);
            writeFileSync(file, `${generate('python-requests', fixture)}\n`);
            run('python', ['-m', 'py_compile', file]);
        }
    });

    it.skipIf(!available('javac', ['-version']))('Java', () => {
        for (const fixture of Object.keys(FIXTURES)) {
            const folder = join(scratch, `java-${fixture}`);
            mkdirSync(folder);
            writeFileSync(join(folder, 'Main.java'), `${generate('java-httpclient', fixture)}\n`);
            run('javac', ['-Xlint:all', '-encoding', 'UTF-8', 'Main.java'], folder);
        }
    });

    it.skipIf(!available('go', ['version']))('Go, and it is gofmt-clean', () => {
        for (const fixture of Object.keys(FIXTURES)) {
            const folder = join(scratch, `go-${fixture}`);
            mkdirSync(folder);
            writeFileSync(join(folder, 'main.go'), `${generate('go-nethttp', fixture)}\n`);
            writeFileSync(join(folder, 'go.mod'), 'module sample\n\ngo 1.21\n');
            run('go', ['vet', './...'], folder);
            expect(run('gofmt', ['-l', '.'], folder).trim(), fixture).toBe('');
        }
    });

    it.skipIf(!available('powershell', ['-NoProfile', '-Command', 'exit 0']))('PowerShell', () => {
        for (const fixture of Object.keys(FIXTURES)) {
            const file = join(scratch, `powershell-${fixture}.ps1`);
            writeFileSync(file, `\ufeff${generate('powershell', fixture)}\n`, 'utf8');
            const errors = run('powershell', [
                '-NoProfile',
                '-Command',
                `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }`,
            ]).trim();
            expect(errors, fixture).toBe('');
        }
    });
});
