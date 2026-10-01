/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    createEmptyRequest,
    createKeyValue,
    isHttpMethod,
    type HttpRequest,
    type KeyValueItem,
    type MultipartField,
} from '@httpreq/shared';
import { paramsFromUrl, splitUrl, urlWithParams } from '@httpreq/workspace';
import { stringifyPretty } from '../indent';
import { ImportError } from './errors';

/**
 * Splits a shell command line into words the way a POSIX shell would: single quotes are literal,
 * double quotes honour backslash escapes, `$'…'` understands C escapes (Chrome's "Copy as cURL"
 * uses it), and a backslash (or a Windows `^`) before a newline continues the line.
 */
export const tokenize = (command: string): string[] => {
    const text = command.replace(/\\\r?\n|\^\r?\n|`\r?\n/g, ' ');
    const words: string[] = [];
    let word = '';
    let inWord = false;
    let index = 0;
    const push = () => {
        if (inWord) words.push(word);
        word = '';
        inWord = false;
    };
    while (index < text.length) {
        const char = text[index]!;
        if (/\s/.test(char)) {
            push();
            index++;
        } else if (char === "'") {
            const end = text.indexOf("'", index + 1);
            if (end < 0)
                throw new ImportError('The cURL command has an unterminated single quote.');
            word += text.slice(index + 1, end);
            inWord = true;
            index = end + 1;
        } else if (char === '$' && text[index + 1] === "'") {
            index += 2;
            inWord = true;
            let closed = false;
            while (index < text.length) {
                const current = text[index]!;
                if (current === "'") {
                    closed = true;
                    index++;
                    break;
                }
                if (current === '\\' && index + 1 < text.length) {
                    const next = text[index + 1]!;
                    const escapes: Record<string, string> = {
                        n: '\n',
                        r: '\r',
                        t: '\t',
                        '\\': '\\',
                        "'": "'",
                        '"': '"',
                    };
                    if (next === 'x' || next === 'u') {
                        const digits = text
                            .slice(index + 2)
                            .match(next === 'x' ? /^[0-9a-f]{1,2}/i : /^[0-9a-f]{1,4}/i);
                        if (digits) {
                            word += String.fromCharCode(parseInt(digits[0], 16));
                            index += 2 + digits[0].length;
                            continue;
                        }
                    }
                    word += escapes[next] ?? `\\${next}`;
                    index += 2;
                    continue;
                }
                word += current;
                index++;
            }
            if (!closed) throw new ImportError("The cURL command has an unterminated $'…' string.");
        } else if (char === '"') {
            index++;
            inWord = true;
            let closed = false;
            while (index < text.length) {
                const current = text[index]!;
                if (current === '"') {
                    closed = true;
                    index++;
                    break;
                }
                if (current === '\\' && '"\\$`'.includes(text[index + 1] ?? '')) {
                    word += text[index + 1];
                    index += 2;
                    continue;
                }
                word += current;
                index++;
            }
            if (!closed)
                throw new ImportError('The cURL command has an unterminated double quote.');
        } else if (char === '\\' && index + 1 < text.length) {
            word += text[index + 1];
            inWord = true;
            index += 2;
        } else {
            word += char;
            inWord = true;
            index++;
        }
    }
    push();
    return words;
};

/** Options that take a value. Anything else starting with `-` is a switch and is ignored. */
const VALUE_OPTIONS = new Set([
    '-X',
    '--request',
    '-H',
    '--header',
    '-d',
    '--data',
    '--data-ascii',
    '--data-raw',
    '--data-binary',
    '--data-urlencode',
    '--json',
    '-F',
    '--form',
    '--form-string',
    '-u',
    '--user',
    '-A',
    '--user-agent',
    '-b',
    '--cookie',
    '-e',
    '--referer',
    '--url',
    '-m',
    '--max-time',
    '-o',
    '--output',
    '--connect-timeout',
    '-x',
    '--proxy',
    '--retry',
    '-w',
    '--write-out',
    '--cacert',
    '--cert',
    '--key',
    '-c',
    '--cookie-jar',
    '--resolve',
    '-T',
    '--upload-file',
    '-E',
    '--oauth2-bearer',
    '--proxy-user',
    '-U',
    '--limit-rate',
    '-r',
    '--range',
    '-z',
    '--time-cond',
    '-K',
    '--config',
    '--max-redirs',
    '--interface',
    '--dns-servers',
]);

const SHORT_WITH_VALUE = new Set(
    [...VALUE_OPTIONS].filter((option) => /^-[a-zA-Z]$/.test(option)).map((option) => option[1]!),
);

/** Normalises `-XPOST`, `-sSL` and `-HAccept: x` into separate options and values. */
const expandOptions = (words: string[]): string[] => {
    const result: string[] = [];
    for (const word of words) {
        if (/^-[a-zA-Z]{2,}/.test(word) && !word.startsWith('--')) {
            for (let index = 1; index < word.length; index++) {
                const flag = word[index]!;
                result.push(`-${flag}`);
                if (SHORT_WITH_VALUE.has(flag)) {
                    if (index + 1 < word.length) result.push(word.slice(index + 1));
                    break;
                }
            }
        } else {
            result.push(word);
        }
    }
    return result;
};

const encodeUrlencodedPart = (part: string) => {
    // `--data-urlencode name=value` encodes only the value; a bare value is encoded whole.
    const equals = part.indexOf('=');
    if (equals < 0) return encodeURIComponent(part.startsWith('=') ? part.slice(1) : part);
    return `${part.slice(0, equals + 1)}${encodeURIComponent(part.slice(equals + 1))}`;
};

const looksLikeJson = (text: string) => {
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed)) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
};

const nameFor = (method: string, url: string) => {
    const { base } = splitUrl(url);
    const path = base.replace(/^[a-z]+:\/\/[^/]+/i, '');
    return `${method} ${path && path !== '/' ? path : base.replace(/^[a-z]+:\/\//i, '')}`.slice(
        0,
        120,
    );
};

/** Converts a cURL command into a draft request. Throws `ImportError` with a readable message. */
export const parseCurl = (command: string): HttpRequest => {
    const trimmed = command.trim();
    if (!trimmed) throw new ImportError('Paste a cURL command to import.');
    const words = expandOptions(tokenize(trimmed));
    if (words[0]?.toLowerCase() === 'curl' || words[0]?.toLowerCase() === 'curl.exe') words.shift();
    else throw new ImportError('The command must start with “curl”.');

    let method: string | null = null;
    let url = '';
    const headers: KeyValueItem[] = [];
    const data: string[] = [];
    const form: MultipartField[] = [];
    let json = false;
    let get = false;
    let insecure = false;
    let follow = false;
    let timeoutMs = 0;
    let user: string | null = null;
    let bearer: string | null = null;

    for (let index = 0; index < words.length; index++) {
        const word = words[index]!;
        const takesValue = VALUE_OPTIONS.has(word);
        const value = takesValue ? words[++index] : undefined;
        if (takesValue && value === undefined) {
            throw new ImportError(`The option ${word} is missing its value.`);
        }
        const header = (name: string, content: string) =>
            headers.push(createKeyValue({ key: name, value: content }));
        switch (word) {
            case '-X':
            case '--request':
                method = value!.toUpperCase();
                break;
            case '-H':
            case '--header': {
                const colon = value!.indexOf(':');
                if (colon > 0)
                    header(value!.slice(0, colon).trim(), value!.slice(colon + 1).trim());
                break;
            }
            case '-d':
            case '--data':
            case '--data-ascii':
            case '--data-raw':
            case '--data-binary':
                data.push(value!);
                break;
            case '--data-urlencode':
                data.push(encodeUrlencodedPart(value!));
                break;
            case '--json':
                data.push(value!);
                json = true;
                break;
            case '-F':
            case '--form':
            case '--form-string': {
                const equals = value!.indexOf('=');
                const name = equals >= 0 ? value!.slice(0, equals) : value!;
                const content = equals >= 0 ? value!.slice(equals + 1) : '';
                const file = word !== '--form-string' && content.startsWith('@');
                form.push({
                    ...createKeyValue({
                        key: name,
                        value: file ? '' : content.replace(/;type=[^;]*$/, ''),
                    }),
                    kind: file ? 'file' : 'text',
                    file: null,
                });
                break;
            }
            case '-u':
            case '--user':
                user = value!;
                break;
            case '--oauth2-bearer':
                bearer = value!;
                break;
            case '-A':
            case '--user-agent':
                header('User-Agent', value!);
                break;
            case '-b':
            case '--cookie':
                // A value without `=` names a cookie file, which cannot be read here.
                if (value!.includes('=')) header('Cookie', value!);
                break;
            case '-e':
            case '--referer':
                header('Referer', value!);
                break;
            case '-m':
            case '--max-time':
                timeoutMs = Math.max(0, Math.round(Number(value) * 1000)) || 0;
                break;
            case '--url':
                url ||= value!;
                break;
            case '-G':
            case '--get':
                get = true;
                break;
            case '-I':
            case '--head':
                method ??= 'HEAD';
                break;
            case '-k':
            case '--insecure':
                insecure = true;
                break;
            case '-L':
            case '--location':
                follow = true;
                break;
            default:
                if (!takesValue && !word.startsWith('-') && !url) url = word;
        }
    }

    if (!url) throw new ImportError('The cURL command does not contain a URL.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = `http://${url}`;

    const body = data.join('&');
    if (get && body) {
        const { base, query, hash } = splitUrl(url);
        url = `${base}?${query ? `${query}&` : ''}${body}${hash}`;
    }
    const resolvedMethod = method ?? (form.length || (body && !get) ? 'POST' : 'GET');
    if (!isHttpMethod(resolvedMethod)) {
        throw new ImportError(`The HTTP method “${resolvedMethod}” is not supported.`);
    }

    const request = createEmptyRequest(null);
    request.name = nameFor(resolvedMethod, url);
    request.method = resolvedMethod;
    request.url = url;
    request.params = paramsFromUrl(url, []);
    request.url = urlWithParams(url, request.params);
    request.settings = {
        ...request.settings,
        followRedirects: follow,
        verifyTls: !insecure,
        timeoutMs,
    };

    const contentType = headers
        .find((item) => item.key.toLowerCase() === 'content-type')
        ?.value.toLowerCase();
    if (json && !contentType) {
        headers.push(createKeyValue({ key: 'Content-Type', value: 'application/json' }));
        headers.push(createKeyValue({ key: 'Accept', value: 'application/json' }));
    }
    request.headers = headers;

    if (form.length) {
        request.body = { ...request.body, mode: 'multipart', multipart: form };
    } else if (body && !get) {
        if (json || contentType?.includes('json') || (!contentType && looksLikeJson(body))) {
            request.body = { ...request.body, mode: 'json', json: prettyIfJson(body) };
        } else if (
            (!contentType || contentType.includes('x-www-form-urlencoded')) &&
            /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)
        ) {
            request.body = {
                ...request.body,
                mode: 'form-urlencoded',
                formUrlEncoded: body.split('&').map((pair) => {
                    const equals = pair.indexOf('=');
                    const decode = (text: string) => {
                        try {
                            return decodeURIComponent(text.replace(/\+/g, ' '));
                        } catch {
                            return text;
                        }
                    };
                    return createKeyValue({
                        key: decode(pair.slice(0, equals)),
                        value: decode(pair.slice(equals + 1)),
                    });
                }),
            };
        } else {
            const xml = contentType?.includes('xml') || /^\s*</.test(body);
            request.body = {
                ...request.body,
                mode: 'text',
                text: body,
                textContentType: xml ? 'application/xml' : 'text/plain',
            };
        }
    }

    if (user !== null) {
        const colon = user.indexOf(':');
        request.auth = {
            type: 'basic',
            username: colon >= 0 ? user.slice(0, colon) : user,
            password: colon >= 0 ? user.slice(colon + 1) : '',
        };
    } else if (bearer !== null) {
        request.auth = { type: 'bearer', token: bearer, prefix: 'Bearer' };
    }
    return request;
};

const prettyIfJson = (text: string) => {
    try {
        return stringifyPretty(JSON.parse(text));
    } catch {
        return text;
    }
};
