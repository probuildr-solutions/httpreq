/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createDefaultCodegenRegistry } from './index';
import { FIXTURES } from './testing/fixtures';
import { syntaxErrors, typeErrors } from './testing/syntax';

const registry = createDefaultCodegenRegistry();
const httpGenerators = registry.forProtocol('http');

const generate = (id: string, fixture: keyof typeof FIXTURES): string => {
    const result = registry.generate(FIXTURES[fixture]!, id);
    if (!result.supported) throw new Error(result.reason);
    return result.code;
};

describe.each(httpGenerators.map((generator) => [generator.id, generator] as const))(
    '%s',
    (id, generator) => {
        it('describes itself for the selector and for saving', () => {
            expect(generator.label).toBeTruthy();
            expect(generator.language).toBeTruthy();
            expect(generator.fileExtension).toMatch(/^[a-z0-9]+$/);
            expect(generator.protocols).toEqual(expect.arrayContaining(['http', 'soap']));
        });

        it.each(Object.keys(FIXTURES))('writes clean code for the %s request', (fixture) => {
            const code = generate(id, fixture);
            expect(code.trim()).not.toBe('');
            expect(code).not.toMatch(/undefined|\[object |NaN/);
            // No trailing whitespace outside multi-line literals, and Unix line endings throughout.
            expect(code).not.toContain('\r\n');
            expect(code.endsWith('\n')).toBe(false);
            // The request itself is present.
            expect(code).toContain(new URL(FIXTURES[fixture]!.url).hostname);
        });

        it('never sends a body with GET or HEAD', () => {
            const text = generate(id, 'head');
            expect(text).not.toMatch(/--data|body:|payload|Content =|httpBody|-Body/);
        });
    },
);

describe('formatting', () => {
    it('indents Go with tabs and everything else with the configured spaces', () => {
        const go = generate('go-nethttp', 'json-post');
        expect(go).toMatch(/^\treq, err := /m);
        expect(go).toMatch(/^import \(\n\t"fmt"/m);
        const python = generate('python-requests', 'json-post');
        expect(python).toMatch(/^ {4}"Accept"/m);
        expect(python).not.toContain('\t');
        expect(generate('ruby-nethttp', 'json-post')).toMatch(/^ {2}http\.request\(request\)/m);
    });

    it('honours the indentation option', () => {
        const result = registry.generate(FIXTURES['json-post']!, 'javascript-fetch', { indent: 2 });
        expect(result.supported && result.code).toMatch(/^ {2}method: "POST"/m);
    });
});

describe('request bodies', () => {
    it('shows a JSON document as data where the language has a native form', () => {
        expect(generate('javascript-fetch', 'json-post')).toMatch(
            /body: JSON\.stringify\(\{\n {8}name: "Ada Lovelace"/,
        );
        expect(generate('python-requests', 'json-post')).toMatch(/json=payload/);
        expect(generate('python-requests', 'json-post')).toMatch(/"active": True/);
        expect(generate('node-axios', 'json-post')).toMatch(/data: \{/);
    });

    it('keeps the body byte for byte when it would not survive being rewritten', () => {
        const code = generate('javascript-fetch', 'json-lossy');
        expect(code).not.toContain('JSON.stringify');
        expect(code).toContain('1.0');
        expect(code).toContain('12345678901234567890');
        expect(generate('python-requests', 'json-lossy')).not.toContain('json=payload');
    });

    it('writes XML and SOAP as readable multi-line literals', () => {
        expect(generate('java-httpclient', 'soap')).toContain('ofString("""');
        expect(generate('csharp-httpclient', 'soap')).toMatch(/new StringContent\("""\n/);
        // Swift switches to a raw string (`#"""`) when the text has backslashes.
        expect(generate('swift-urlsession', 'soap')).toMatch(/Data\(#"""\n/);
        expect(generate('php-curl', 'soap')).toContain("<<<'BODY'");
        expect(generate('ruby-nethttp', 'soap')).toContain("<<~'BODY'");
        expect(generate('go-nethttp', 'soap')).toMatch(/strings\.NewReader\(`<\?xml/);
        expect(generate('powershell', 'soap')).toMatch(/\$body = @'\n<\?xml/);
    });

    it('keeps multipart parts in order and never invents a Content-Type for them', () => {
        for (const generator of httpGenerators) {
            const code = generate(generator.id, 'multipart');
            const title = code.indexOf('title');
            const note = code.indexOf('note');
            expect(title, generator.id).toBeGreaterThan(-1);
            expect(note, generator.id).toBeGreaterThan(title);
            expect(code, generator.id).not.toMatch(
                /Content-Type['"]?\s*[:=,]\s*['"]?multipart\/form-data['"]?\s*[,)}]/i,
            );
        }
    });

    it('treats a text field that starts with @ as text, not a file', () => {
        expect(generate('curl', 'multipart')).toContain("--form-string 'note=@not-a-file'");
    });

    it('re-encodes form fields and keeps repeated names', () => {
        // A name with a space cannot be given to --data-urlencode, so the encoded string is used.
        expect(generate('curl', 'form')).toContain(
            "--data-raw 'user+name=ada+%26+co&scope=read&scope=write'",
        );
        const plain = registry.generate(
            {
                ...FIXTURES.form!,
                body: { kind: 'form', fields: [{ name: 'scope', value: 'a b' }] },
            },
            'curl',
        );
        expect(plain.supported && plain.code).toContain("--data-urlencode 'scope=a b'");
        expect(generate('python-requests', 'form')).toMatch(
            /\("scope", "read"\),\n\s+\("scope", "write"\)/,
        );
        expect(generate('javascript-fetch', 'form')).toContain('new URLSearchParams(');
    });
});

describe('settings', () => {
    it('turns off redirects, certificate checks and sets the timeout in every language', () => {
        const expectations: Record<string, RegExp[]> = {
            curl: [/--insecure/, /--max-time 3/],
            'javascript-fetch': [/redirect: "manual"/, /AbortSignal\.timeout\(2500\)/],
            'typescript-fetch': [/redirect: "manual"/, /AbortSignal\.timeout\(2500\)/],
            'node-axios': [/maxRedirects: 0/, /timeout: 2500/, /rejectUnauthorized: false/],
            'python-requests': [/allow_redirects=False/, /verify=False/, /timeout=2\.5/],
            'java-httpclient': [/Duration\.ofMillis\(2500\)/, /SSLContext/, /trustAll/],
            'java-okhttp': [
                /\.followRedirects\(false\)/,
                /\.callTimeout\(Duration\.ofMillis\(2500\)\)/,
                /\.sslSocketFactory\(sslContext\.getSocketFactory\(\), trustAll\)/,
            ],
            'csharp-httpclient': [
                /AllowAutoRedirect = false/,
                /DangerousAcceptAnyServerCertificateValidator/,
                /FromMilliseconds\(2500\)/,
            ],
            'go-nethttp': [
                /ErrUseLastResponse/,
                /InsecureSkipVerify: true/,
                /2500 \* time\.Millisecond/,
            ],
            'php-curl': [
                /CURLOPT_FOLLOWLOCATION => false/,
                /CURLOPT_SSL_VERIFYPEER => false/,
                /CURLOPT_TIMEOUT_MS => 2500/,
            ],
            'ruby-nethttp': [/VERIFY_NONE/, /read_timeout: 2\.5/],
            'swift-urlsession': [
                /completionHandler\(nil\)/,
                /URLCredential\(trust: trust\)/,
                /timeoutInterval = 2\.5/,
            ],
            powershell: [
                /MaximumRedirection\s+= 0/,
                /SkipCertificateCheck\s+= \$true/,
                /TimeoutSec\s+= 3/,
            ],
        };
        for (const [id, patterns] of Object.entries(expectations)) {
            const code = generate(id, 'get-settings');
            for (const pattern of patterns) expect(code, id).toMatch(pattern);
        }
        expect(generate('curl', 'get-settings')).not.toContain('--location');
    });

    it('omits settings that are at their defaults', () => {
        const code = generate('go-nethttp', 'json-post');
        expect(code).toContain('http.DefaultClient.Do(req)');
        expect(code).not.toMatch(/Timeout|InsecureSkipVerify|CheckRedirect/);
        expect(generate('python-requests', 'json-post')).not.toMatch(
            /verify=|timeout=|allow_redirects=/,
        );
    });
});

describe('JavaScript and TypeScript output is valid', () => {
    const ids = ['javascript-fetch', 'typescript-fetch', 'node-axios'];

    it.each(ids.flatMap((id) => Object.keys(FIXTURES).map((fixture) => [id, fixture] as const)))(
        '%s parses for the %s request',
        (id, fixture) => {
            expect(syntaxErrors(generate(id, fixture), `${id}.ts`)).toEqual([]);
        },
    );

    it.each(Object.keys(FIXTURES))(
        'typescript-fetch type-checks for the %s request',
        (fixture) => {
            expect(typeErrors(generate('typescript-fetch', fixture))).toEqual([]);
        },
        60_000,
    );
});
