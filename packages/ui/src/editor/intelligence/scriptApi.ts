/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ScriptStage } from '@httpreq/shared';

/**
 * What a request script can use, as data. The completion, hover and signature help for the
 * Scripts editor are all read from this table, so documenting a new function is one entry here
 * and nothing else. It describes the API that `@httpreq/scripting` provides; a test runs a real
 * script in the sandbox and fails if the two disagree.
 */

export type ApiKind = 'property' | 'method' | 'class' | 'function' | 'constant';

export interface ApiParameter {
    name: string;
    doc?: string;
}

export interface ApiMember {
    name: string;
    kind: ApiKind;
    doc: string;
    /** Type of the value this member evaluates to, a key of {@link API_TYPES}; continues a chain. */
    returns?: string;
    /** The arguments of a function or method, for signature help and the inserted call. */
    params?: ApiParameter[];
    /** What the call returns, shown after `→` in the signature. */
    result?: string;
    /** Stages the member exists in; every stage when omitted. */
    stages?: readonly ScriptStage[];
}

export interface ApiType {
    members: ApiMember[];
}

const RESPONSE_STAGES = ['postResponse', 'tests'] as const;

const prop = (name: string, doc: string, extra: Partial<ApiMember> = {}): ApiMember => ({
    name,
    kind: 'property',
    doc,
    ...extra,
});

const method = (
    name: string,
    doc: string,
    params: (string | ApiParameter)[] = [],
    extra: Partial<ApiMember> = {},
): ApiMember => ({
    name,
    kind: 'method',
    doc,
    params: params.map((param) => (typeof param === 'string' ? { name: param } : param)),
    ...extra,
});

const store = (what: string): ApiType => ({
    members: [
        method('get', `The value of a ${what}, or \`undefined\` when it is not set.`, ['name'], {
            result: 'string | undefined',
        }),
        method('has', `Whether the ${what} is set.`, ['name'], { result: 'boolean' }),
        method('set', `Sets a ${what}. The value is stored as text.`, ['name', 'value']),
        method('unset', `Removes a ${what}.`, ['name']),
        method('toObject', `A copy of every ${what} as a plain object.`, [], {
            result: 'Record<string, string>',
        }),
    ],
});

const headers = (who: string): ApiType => ({
    members: [
        method('get', `The value of a ${who} header (any casing), or \`undefined\`.`, ['name'], {
            result: 'string | undefined',
        }),
        method('has', `Whether the ${who} has the header (any casing).`, ['name'], {
            result: 'boolean',
        }),
        method('set', `Sets a ${who} header, replacing one of the same name.`, ['name', 'value']),
        method('remove', `Removes a ${who} header.`, ['name']),
        method('toObject', `All ${who} headers as a plain object.`, [], {
            result: 'Record<string, string>',
        }),
    ],
});

/** Words that only make an assertion read like a sentence. */
const CHAIN_WORDS = [
    'to',
    'be',
    'been',
    'is',
    'that',
    'which',
    'and',
    'has',
    'have',
    'with',
    'at',
    'of',
    'same',
    'does',
    'still',
];

const assertion = (): ApiType => {
    const chain = (name: string, doc: string): ApiMember =>
        prop(name, doc, { returns: 'Assertion' });
    const check = (name: string, doc: string): ApiMember =>
        prop(name, doc, { returns: 'Assertion' });
    const test = (names: string, doc: string, params: string[]): ApiMember[] =>
        names.split('/').map((name) => method(name, doc, params, { returns: 'Assertion' }));
    return {
        members: [
            ...CHAIN_WORDS.map((word) => chain(word, 'Reads naturally; does nothing.')),
            chain('not', 'Negates the assertions that follow.'),
            chain('deep', 'Compares objects and arrays by content, not identity.'),
            check('ok', 'Passes when the value is truthy.'),
            check('true', 'Passes when the value is exactly `true`.'),
            check('false', 'Passes when the value is exactly `false`.'),
            check('null', 'Passes when the value is `null`.'),
            check('undefined', 'Passes when the value is `undefined`.'),
            check('exist', 'Passes when the value is neither `null` nor `undefined`.'),
            check('empty', 'Passes for an empty string, array or object.'),
            ...test(
                'equal/equals/eq',
                'Passes when the value equals `expected` (`===`; with `deep`, by content).',
                ['expected'],
            ),
            ...test('eql', 'Passes when the value deeply equals `expected`.', ['expected']),
            ...test(
                'a/an',
                'Passes when the value has the given type: `string`, `number`, `boolean`, `array`, `object`, `null`.',
                ['type'],
            ),
            ...test(
                'include/includes/contain/contains',
                'Passes when a string contains `item`, an array has it, or an object has those properties.',
                ['item'],
            ),
            ...test(
                'property',
                'Passes when the value has the property, and with `value`, when it equals it.',
                ['name', 'value'],
            ),
            ...test('above/gt/greaterThan', 'Passes when the value is greater than `n`.', ['n']),
            ...test('below/lt/lessThan', 'Passes when the value is less than `n`.', ['n']),
            ...test('least/gte', 'Passes when the value is at least `n`.', ['n']),
            ...test('most/lte', 'Passes when the value is at most `n`.', ['n']),
            ...test('within', 'Passes when the value is between `low` and `high`, inclusive.', [
                'low',
                'high',
            ]),
            ...test('lengthOf/length', 'Passes when the value’s `length` is `n`.', ['n']),
            ...test('match/matches', 'Passes when a string matches the regular expression.', [
                'pattern',
            ]),
            ...test('oneOf', 'Passes when the value is one of the entries of `list`.', ['list']),
            ...test(
                'status',
                'Passes when a response’s status is `code`. Use it as `expect(httpreq.response).to.have.status(200)`.',
                ['code'],
            ),
        ],
    };
};

export const API_TYPES: Record<string, ApiType> = {
    Httpreq: {
        members: [
            prop('info', 'Facts about this run.', { returns: 'Info' }),
            prop('request', 'The request about to be sent. Change it to change what is sent.', {
                returns: 'Request',
            }),
            prop('response', 'The response that arrived.', {
                returns: 'Response',
                stages: RESPONSE_STAGES,
            }),
            prop('environment', 'Variables of the active environment; changes are saved to it.', {
                returns: 'Store',
            }),
            prop('variables', 'Variables that last for this request run only.', {
                returns: 'Store',
            }),
            method('test', 'Defines a test. Each test passes or fails on its own.', ['name', 'fn']),
            method('expect', 'Starts an assertion about a value.', ['value'], {
                returns: 'Assertion',
            }),
            prop('utils', 'Helpers for encoding, hashing and generating values.', {
                returns: 'Utils',
            }),
        ],
    },
    Info: {
        members: [
            prop('stage', 'Which script is running: `preRequest`, `postResponse` or `tests`.'),
        ],
    },
    Request: {
        members: [
            prop('method', 'The HTTP method, e.g. `"POST"`. Assignable in a pre-request script.'),
            prop(
                'url',
                'The full URL with variables resolved. Assignable in a pre-request script.',
            ),
            prop(
                'body',
                'The body text, or `null` when there is none. Assignable in a pre-request script.',
            ),
            prop('headers', 'The request headers.', { returns: 'RequestHeaders' }),
        ],
    },
    RequestHeaders: headers('request'),
    Response: {
        members: [
            prop('status', 'The status code, e.g. `200`.'),
            prop('code', 'The status code, an alias of `status`.'),
            prop('statusText', 'The status text, e.g. `"OK"`.'),
            prop('headers', 'The response headers.', { returns: 'ResponseHeaders' }),
            prop('responseTime', 'How long the request took, in milliseconds.'),
            prop('size', 'The size of the response body, in bytes.'),
            method('text', 'The response body as text.', [], { result: 'string' }),
            method('json', 'The response body parsed as JSON. Throws when it is not JSON.', [], {
                result: 'any',
            }),
        ],
    },
    ResponseHeaders: headers('response'),
    Store: store('variable'),
    Assertion: assertion(),
    Utils: {
        members: [
            method('base64Encode', 'Encodes text as Base64.', ['text'], { result: 'string' }),
            method('base64Decode', 'Decodes Base64 to text.', ['text'], { result: 'string' }),
            method('sha256Hex', 'The SHA-256 hash of the text, in hexadecimal.', ['text'], {
                result: 'string',
            }),
            method(
                'hmacSha256Hex',
                'The HMAC-SHA256 of the text, in hexadecimal.',
                ['key', 'text'],
                { result: 'string' },
            ),
            method(
                'hmacSha256Base64',
                'The HMAC-SHA256 of the text, Base64 encoded.',
                ['key', 'text'],
                { result: 'string' },
            ),
            method('uuid', 'A random UUID (version 4).', [], { result: 'string' }),
            method('timestamp', 'The current time in milliseconds since 1970.', [], {
                result: 'number',
            }),
            method('isoTimestamp', 'The current time as an ISO 8601 string.', [], {
                result: 'string',
            }),
            method(
                'randomInt',
                'A random whole number from `min` to `max`, inclusive.',
                ['min', 'max'],
                { result: 'number' },
            ),
            method('urlEncode', 'Percent-encodes text for use in a URL.', ['text'], {
                result: 'string',
            }),
            method('urlDecode', 'Decodes percent-encoded text.', ['text'], { result: 'string' }),
        ],
    },
    Console: {
        members: ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
            method(level, `Writes a ${level} line to the script output.`, ['...values']),
        ),
    },
    // The few standard objects scripts use most; the sandbox has the full language.
    JSON: {
        members: [
            method('parse', 'Parses JSON text into a value.', ['text'], { result: 'any' }),
            method('stringify', 'Converts a value to JSON text.', ['value', 'replacer', 'space'], {
                result: 'string',
            }),
        ],
    },
    Math: {
        members: ['abs', 'ceil', 'floor', 'max', 'min', 'pow', 'random', 'round', 'trunc'].map(
            (name) =>
                method(name, `Math.${name}`, name === 'random' ? [] : ['x'], { result: 'number' }),
        ),
    },
    Object: {
        members: ['keys', 'values', 'entries', 'assign'].map((name) =>
            method(name, `Object.${name}`, ['obj']),
        ),
    },
};

/** Names a script can use without a receiver. */
export const GLOBALS: ApiMember[] = [
    prop('httpreq', 'The script API: the request, response, variables, tests and utilities.', {
        kind: 'constant',
        returns: 'Httpreq',
    }),
    prop('console', 'Writes to the script output shown beside the response.', {
        kind: 'constant',
        returns: 'Console',
    }),
    method(
        'expect',
        'Starts an assertion about a value. The same as `httpreq.expect`.',
        ['value'],
        {
            kind: 'function',
            returns: 'Assertion',
        },
    ),
    method('test', 'Defines a test. The same as `httpreq.test`.', ['name', 'fn'], {
        kind: 'function',
    }),
    method('btoa', 'Encodes text as Base64.', ['text'], { kind: 'function', result: 'string' }),
    method('atob', 'Decodes Base64 to text.', ['text'], { kind: 'function', result: 'string' }),
    ...['JSON', 'Math', 'Object'].map((name): ApiMember =>
        prop(name, `The standard ${name} object.`, { kind: 'class', returns: name }),
    ),
];

/** Ready-made scripts for what is done most often, offered as completions. */
export interface ScriptSnippet {
    label: string;
    detail: string;
    /** Monaco snippet syntax: `${1:name}` marks a place to type. */
    body: string;
    stages?: readonly ScriptStage[];
}

export const SNIPPETS: ScriptSnippet[] = [
    {
        label: 'test',
        detail: 'A test with an assertion',
        body: "test('${1:does something}', () => {\n\texpect(${2:httpreq.response.status}).to.equal(${3:200});\n});",
    },
    {
        label: 'test-status',
        detail: 'Test that the status code is 200',
        body: "test('status is ${1:200}', () => {\n\texpect(httpreq.response.status).to.equal(${1:200});\n});",
        stages: RESPONSE_STAGES,
    },
    {
        label: 'test-json-property',
        detail: 'Test a property of the JSON response',
        body: "test('${1:id} is present', () => {\n\texpect(httpreq.response.json()).to.have.property('${1:id}');\n});",
        stages: RESPONSE_STAGES,
    },
    {
        label: 'save-token',
        detail: 'Store a value from the JSON response in the environment',
        body: "const body = httpreq.response.json();\nhttpreq.environment.set('${1:token}', body.${2:token});",
        stages: RESPONSE_STAGES,
    },
    {
        label: 'set-header',
        detail: 'Add a header to the request',
        body: "httpreq.request.headers.set('${1:X-Request-Id}', ${2:httpreq.utils.uuid()});",
        stages: ['preRequest'],
    },
    {
        label: 'sign-request',
        detail: 'Add an HMAC signature header',
        body: "const signature = httpreq.utils.hmacSha256Hex(httpreq.environment.get('${1:secret}'), httpreq.request.body || '');\nhttpreq.request.headers.set('${2:X-Signature}', signature);",
        stages: ['preRequest'],
    },
    {
        label: 'parse-json-body',
        detail: 'Read and change the JSON request body',
        body: "const body = JSON.parse(httpreq.request.body || '{}');\nbody.${1:field} = ${2:value};\nhttpreq.request.body = JSON.stringify(body);",
        stages: ['preRequest'],
    },
];

/** The type a name evaluates to at the top level, or undefined for something unknown. */
export const globalType = (name: string): string | undefined =>
    GLOBALS.find((member) => member.name === name)?.returns;

const available = (member: ApiMember, stage: ScriptStage) =>
    !member.stages || member.stages.includes(stage);

/** Members of a type usable in a stage, in declaration order. */
export const membersOf = (type: string, stage: ScriptStage): ApiMember[] =>
    (API_TYPES[type]?.members ?? []).filter((member) => available(member, stage));

export const globalsFor = (stage: ScriptStage): ApiMember[] =>
    GLOBALS.filter((member) => available(member, stage));

/** The member a name refers to on a type, if it exists in the stage. */
export const findMember = (type: string, name: string, stage: ScriptStage): ApiMember | undefined =>
    membersOf(type, stage).find((member) => member.name === name);

/** `get(name): string | undefined`, the line shown in a completion detail and signature help. */
export const signatureOf = (member: ApiMember): string => {
    if (!member.params) return member.name;
    const args = member.params.map((param) => param.name).join(', ');
    return `${member.name}(${args})${member.result ? `: ${member.result}` : ''}`;
};
