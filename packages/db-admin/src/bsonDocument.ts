/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * A BSON-aware document model for the MongoDB document editor: read the text a person writes
 * (JSON, shell constructors such as `ObjectId("…")` and `ISODate("…")`, or extended JSON such as
 * `{"$oid": "…"}`), keep every value's real BSON type, and write it back the same way. It never
 * evaluates code; it is a small parser over the characters. The tree view edits the same model, so
 * the JSON view and the tree view always agree.
 */

export type BsonNode =
    | { t: 'object'; entries: { key: string; value: BsonNode }[] }
    | { t: 'array'; items: BsonNode[] }
    | { t: 'string'; v: string }
    | { t: 'int32'; v: string }
    | { t: 'int64'; v: string }
    | { t: 'double'; v: string }
    | { t: 'decimal128'; v: string }
    | { t: 'bool'; v: boolean }
    | { t: 'null' }
    | { t: 'objectId'; v: string }
    | { t: 'date'; v: string }
    | { t: 'uuid'; v: string }
    | { t: 'binary'; v: string; subtype: number }
    | { t: 'regex'; pattern: string; flags: string }
    | { t: 'timestamp'; seconds: number; increment: number }
    | { t: 'minKey' }
    | { t: 'maxKey' };

export type BsonType = BsonNode['t'];

/** The types a field can be changed to in the editor, with the names a person knows. */
export const BSON_TYPE_LABELS: { type: BsonType; label: string }[] = [
    { type: 'string', label: 'String' },
    { type: 'int32', label: 'Int32' },
    { type: 'int64', label: 'Int64' },
    { type: 'double', label: 'Double' },
    { type: 'decimal128', label: 'Decimal128' },
    { type: 'bool', label: 'Boolean' },
    { type: 'null', label: 'Null' },
    { type: 'objectId', label: 'ObjectId' },
    { type: 'date', label: 'Date' },
    { type: 'object', label: 'Object' },
    { type: 'array', label: 'Array' },
    { type: 'uuid', label: 'UUID' },
    { type: 'regex', label: 'Regular expression' },
];

export type ParseOutcome =
    { ok: true; node: BsonNode } | { ok: false; error: string; position: number };

class ParseError extends Error {
    constructor(
        message: string,
        readonly position: number,
    ) {
        super(message);
    }
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const MAX_DEPTH = 100;

class Reader {
    index = 0;
    constructor(readonly text: string) {}

    fail(message: string, at = this.index): never {
        throw new ParseError(message, at);
    }

    skip() {
        for (;;) {
            const c = this.text[this.index];
            if (c !== undefined && /\s/.test(c)) this.index++;
            else if (c === '/' && this.text[this.index + 1] === '/') {
                while (this.index < this.text.length && this.text[this.index] !== '\n')
                    this.index++;
            } else if (c === '/' && this.text[this.index + 1] === '*') {
                const end = this.text.indexOf('*/', this.index + 2);
                if (end < 0) this.fail('A comment is never closed.');
                this.index = end + 2;
            } else return;
        }
    }

    peek() {
        this.skip();
        return this.text[this.index];
    }

    expect(char: string) {
        this.skip();
        if (this.text[this.index] !== char)
            this.fail(`Expected “${char}” but found ${this.describeHere()}.`);
        this.index++;
    }

    describeHere() {
        const c = this.text[this.index];
        return c === undefined ? 'the end of the text' : `“${c}”`;
    }

    string(): string {
        const quote = this.text[this.index];
        const start = this.index;
        this.index++;
        let out = '';
        for (;;) {
            const c = this.text[this.index++];
            if (c === undefined) this.fail('A string is never closed.', start);
            if (c === quote) return out;
            if (c !== '\\') {
                out += c;
                continue;
            }
            const e = this.text[this.index++];
            switch (e) {
                case 'n':
                    out += '\n';
                    break;
                case 't':
                    out += '\t';
                    break;
                case 'r':
                    out += '\r';
                    break;
                case 'b':
                    out += '\b';
                    break;
                case 'f':
                    out += '\f';
                    break;
                case '/':
                    out += '/';
                    break;
                case '\\':
                    out += '\\';
                    break;
                case '"':
                    out += '"';
                    break;
                case "'":
                    out += "'";
                    break;
                case 'u': {
                    const hex = this.text.slice(this.index, this.index + 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex))
                        this.fail('A \\u escape needs four hex digits.');
                    out += String.fromCharCode(parseInt(hex, 16));
                    this.index += 4;
                    break;
                }
                default:
                    this.fail('An escape in a string is not valid.');
            }
        }
    }
}

const identifierStart = /[A-Za-z_$]/;
const identifierPart = /[\w$]/;

const readKey = (r: Reader): string => {
    const c = r.peek();
    if (c === '"' || c === "'") return r.string();
    if (c !== undefined && identifierStart.test(c)) {
        const start = r.index;
        while (r.index < r.text.length && identifierPart.test(r.text[r.index]!)) r.index++;
        return r.text.slice(start, r.index);
    }
    // A bare number can be a key, as in the shell.
    if (c !== undefined && /\d/.test(c)) {
        const start = r.index;
        while (r.index < r.text.length && /[\d.]/.test(r.text[r.index]!)) r.index++;
        return r.text.slice(start, r.index);
    }
    return r.fail(`Expected a field name but found ${r.describeHere()}.`);
};

const numberNode = (text: string, at: number): BsonNode => {
    if (/^-?\d+$/.test(text)) {
        const big = BigInt(text);
        if (big >= BigInt(INT32_MIN) && big <= BigInt(INT32_MAX)) return { t: 'int32', v: text };
        if (big >= -(2n ** 63n) && big < 2n ** 63n) return { t: 'int64', v: text };
        throw new ParseError('The number is too large for a 64-bit integer.', at);
    }
    if (!Number.isFinite(Number(text))) throw new ParseError('Not a number.', at);
    return { t: 'double', v: text };
};

const asString = (node: BsonNode | undefined, what: string, at: number): string => {
    if (node && node.t === 'string') return node.v;
    if (node && (node.t === 'int32' || node.t === 'int64' || node.t === 'double')) return node.v;
    throw new ParseError(`${what} needs a text or number argument.`, at);
};

const parseValue = (r: Reader, depth: number): BsonNode => {
    if (depth > MAX_DEPTH) r.fail('The document is nested too deeply.');
    const c = r.peek();
    const start = r.index;
    if (c === undefined) return r.fail('Expected a value but the text ended.');
    if (c === '{') return finishObject(r, depth);
    if (c === '[') {
        r.index++;
        const items: BsonNode[] = [];
        if (r.peek() === ']') {
            r.index++;
            return { t: 'array', items };
        }
        for (;;) {
            items.push(parseValue(r, depth + 1));
            const next = r.peek();
            if (next === ',') {
                r.index++;
                if (r.peek() === ']') {
                    r.index++;
                    break;
                }
                continue;
            }
            if (next === ']') {
                r.index++;
                break;
            }
            r.fail(`Expected “,” or “]” but found ${r.describeHere()}.`);
        }
        return { t: 'array', items };
    }
    if (c === '"' || c === "'") return { t: 'string', v: r.string() };
    if (c === '/') {
        r.index++;
        let pattern = '';
        for (;;) {
            const ch = r.text[r.index++];
            if (ch === undefined) r.fail('A regular expression is never closed.', start);
            if (ch === '\\') pattern += ch + (r.text[r.index++] ?? '');
            else if (ch === '/') break;
            else pattern += ch;
        }
        const flagsStart = r.index;
        while (r.index < r.text.length && /[a-z]/.test(r.text[r.index]!)) r.index++;
        return { t: 'regex', pattern, flags: r.text.slice(flagsStart, r.index) };
    }
    if (c === '-' || /\d/.test(c)) {
        const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(r.text.slice(r.index));
        if (!m) return r.fail('Not a number.');
        r.index += m[0].length;
        return numberNode(m[0], start);
    }
    if (identifierStart.test(c)) {
        let word = '';
        while (r.index < r.text.length && identifierPart.test(r.text[r.index]!))
            word += r.text[r.index++];
        if (word === 'new' && r.peek() !== undefined) {
            r.skip();
            return parseValue(r, depth + 1);
        }
        if (word === 'true') return { t: 'bool', v: true };
        if (word === 'false') return { t: 'bool', v: false };
        if (word === 'null' || word === 'undefined') return { t: 'null' };
        if (word === 'NaN' || word === 'Infinity') return { t: 'double', v: word };
        if (r.peek() === '(') return constructor(r, word, start, depth);
        return r.fail(`“${word}” is not a value. Strings need quotes.`, start);
    }
    return r.fail(`Unexpected ${r.describeHere()}.`);
};

const constructor = (r: Reader, name: string, start: number, depth: number): BsonNode => {
    r.expect('(');
    const args: BsonNode[] = [];
    if (r.peek() !== ')') {
        for (;;) {
            args.push(parseValue(r, depth + 1));
            if (r.peek() === ',') {
                r.index++;
                continue;
            }
            break;
        }
    }
    r.expect(')');
    const text = () => asString(args[0], `${name}()`, start);
    switch (name) {
        case 'ObjectId': {
            if (args.length === 0) return { t: 'objectId', v: '000000000000000000000000' };
            const v = text();
            if (!OBJECT_ID.test(v)) r.fail('An ObjectId is 24 hexadecimal characters.', start);
            return { t: 'objectId', v: v.toLowerCase() };
        }
        case 'ISODate':
        case 'Date': {
            if (args.length === 0) return { t: 'date', v: new Date().toISOString() };
            const first = args[0]!;
            const date =
                first.t === 'int32' || first.t === 'int64' || first.t === 'double'
                    ? new Date(Number(first.v))
                    : new Date(text());
            if (Number.isNaN(date.getTime())) r.fail('That is not a valid date.', start);
            return { t: 'date', v: date.toISOString() };
        }
        case 'NumberInt':
            return numberOfKind(text(), 'int32', r, start);
        case 'NumberLong':
            return numberOfKind(text(), 'int64', r, start);
        case 'NumberDecimal':
            return { t: 'decimal128', v: text() };
        case 'Double':
            return { t: 'double', v: text() };
        case 'UUID':
            return { t: 'uuid', v: text().toLowerCase() };
        case 'BinData': {
            const subtype =
                args[0] && (args[0].t === 'int32' || args[0].t === 'int64') ? Number(args[0].v) : 0;
            return { t: 'binary', v: asString(args[1], 'BinData()', start), subtype };
        }
        case 'Timestamp':
            return {
                t: 'timestamp',
                seconds: Number((args[0] as { v?: string })?.v ?? 0),
                increment: Number((args[1] as { v?: string })?.v ?? 0),
            };
        case 'MinKey':
            return { t: 'minKey' };
        case 'MaxKey':
            return { t: 'maxKey' };
        case 'RegExp':
            return { t: 'regex', pattern: text(), flags: args[1]?.t === 'string' ? args[1].v : '' };
        default:
            return r.fail(`“${name}(…)” is not a supported value.`, start);
    }
};

const numberOfKind = (text: string, kind: 'int32' | 'int64', r: Reader, at: number): BsonNode => {
    if (!/^-?\d+$/.test(text)) r.fail('An integer is expected.', at);
    const big = BigInt(text);
    if (kind === 'int32' && (big < BigInt(INT32_MIN) || big > BigInt(INT32_MAX)))
        r.fail('The number does not fit in a 32-bit integer.', at);
    if (big < -(2n ** 63n) || big >= 2n ** 63n) r.fail('The number does not fit in 64 bits.', at);
    return { t: kind, v: text };
};

const finishObject = (r: Reader, depth: number): BsonNode => {
    r.expect('{');
    const entries: { key: string; value: BsonNode }[] = [];
    if (r.peek() === '}') {
        r.index++;
        return { t: 'object', entries };
    }
    for (;;) {
        const key = readKey(r);
        r.expect(':');
        entries.push({ key, value: parseValue(r, depth + 1) });
        const next = r.peek();
        if (next === ',') {
            r.index++;
            if (r.peek() === '}') {
                r.index++;
                break;
            }
            continue;
        }
        if (next === '}') {
            r.index++;
            break;
        }
        r.fail(`Expected “,” or “}” but found ${r.describeHere()}.`);
    }
    return fromExtendedJson({ t: 'object', entries });
};

/** `{ "$oid": "…" }`, `{ "$date": … }` and the other extended JSON forms become real types. */
const fromExtendedJson = (node: Extract<BsonNode, { t: 'object' }>): BsonNode => {
    if (node.entries.length !== 1) return node;
    const { key, value } = node.entries[0]!;
    const str =
        value.t === 'string'
            ? value.v
            : value.t === 'int32' || value.t === 'int64' || value.t === 'double'
              ? value.v
              : undefined;
    switch (key) {
        case '$oid':
            return str && OBJECT_ID.test(str) ? { t: 'objectId', v: str.toLowerCase() } : node;
        case '$date': {
            if (value.t === 'object') {
                const inner = value.entries.find((e) => e.key === '$numberLong')?.value;
                if (inner?.t === 'string')
                    return { t: 'date', v: new Date(Number(inner.v)).toISOString() };
                return node;
            }
            const date =
                str !== undefined && value.t !== 'string'
                    ? new Date(Number(str))
                    : new Date(str ?? '');
            return Number.isNaN(date.getTime()) ? node : { t: 'date', v: date.toISOString() };
        }
        case '$numberInt':
            return str && /^-?\d+$/.test(str) ? { t: 'int32', v: str } : node;
        case '$numberLong':
            return str && /^-?\d+$/.test(str) ? { t: 'int64', v: str } : node;
        case '$numberDouble':
            return str !== undefined ? { t: 'double', v: str } : node;
        case '$numberDecimal':
            return str !== undefined ? { t: 'decimal128', v: str } : node;
        case '$uuid':
            return str !== undefined ? { t: 'uuid', v: str.toLowerCase() } : node;
        default:
            return node;
    }
};

export const parseDocument = (text: string): ParseOutcome => {
    const reader = new Reader(text);
    try {
        const node = parseValue(reader, 0);
        reader.skip();
        if (reader.index < text.length)
            reader.fail(`Unexpected ${reader.describeHere()} after the document.`);
        return { ok: true, node };
    } catch (error) {
        if (error instanceof ParseError)
            return { ok: false, error: error.message, position: error.position };
        throw error;
    }
};

/* ---------- Writing ---------- */

const KEY = /^[A-Za-z_$][\w$]*$/;
const quoteString = (value: string) => JSON.stringify(value);

/** Writes a node as shell text, which `parseDocument` and the server's statement parser read back. */
export const formatNode = (node: BsonNode, indent = 0, step = 2): string => {
    const pad = ' '.repeat(indent);
    const inner = ' '.repeat(indent + step);
    switch (node.t) {
        case 'object':
            if (node.entries.length === 0) return '{}';
            return `{\n${node.entries.map((e) => `${inner}${KEY.test(e.key) ? e.key : quoteString(e.key)}: ${formatNode(e.value, indent + step, step)}`).join(',\n')}\n${pad}}`;
        case 'array':
            if (node.items.length === 0) return '[]';
            return `[\n${node.items.map((item) => `${inner}${formatNode(item, indent + step, step)}`).join(',\n')}\n${pad}]`;
        case 'string':
            return quoteString(node.v);
        case 'int32':
            return node.v;
        case 'int64':
            return `NumberLong(${quoteString(node.v)})`;
        case 'double':
            // A whole-number double must say so, or the server would store it as an int32.
            return /^-?\d+$/.test(node.v) ? `Double(${quoteString(node.v)})` : node.v;
        case 'decimal128':
            return `NumberDecimal(${quoteString(node.v)})`;
        case 'bool':
            return String(node.v);
        case 'null':
            return 'null';
        case 'objectId':
            return `ObjectId(${quoteString(node.v)})`;
        case 'date':
            return `ISODate(${quoteString(node.v)})`;
        case 'uuid':
            return `UUID(${quoteString(node.v)})`;
        case 'binary':
            return `BinData(${node.subtype}, ${quoteString(node.v)})`;
        case 'regex':
            return `/${node.pattern}/${node.flags}`;
        case 'timestamp':
            return `Timestamp(${node.seconds}, ${node.increment})`;
        case 'minKey':
            return 'MinKey()';
        case 'maxKey':
            return 'MaxKey()';
    }
};

/** Canonical extended JSON, for copying into tools that expect plain JSON. */
export const toExtendedJson = (node: BsonNode): unknown => {
    switch (node.t) {
        case 'object':
            return Object.fromEntries(node.entries.map((e) => [e.key, toExtendedJson(e.value)]));
        case 'array':
            return node.items.map(toExtendedJson);
        case 'string':
            return node.v;
        case 'int32':
            return { $numberInt: node.v };
        case 'int64':
            return { $numberLong: node.v };
        case 'double':
            return { $numberDouble: node.v };
        case 'decimal128':
            return { $numberDecimal: node.v };
        case 'bool':
            return node.v;
        case 'null':
            return null;
        case 'objectId':
            return { $oid: node.v };
        case 'date':
            return { $date: node.v };
        case 'uuid':
            return { $uuid: node.v };
        case 'binary':
            return {
                $binary: { base64: node.v, subType: node.subtype.toString(16).padStart(2, '0') },
            };
        case 'regex':
            return { $regularExpression: { pattern: node.pattern, options: node.flags } };
        case 'timestamp':
            return { $timestamp: { t: node.seconds, i: node.increment } };
        case 'minKey':
            return { $minKey: 1 };
        case 'maxKey':
            return { $maxKey: 1 };
    }
};

/* ---------- Editing the tree ---------- */

export type Path = (string | number)[];

export const nodeAt = (root: BsonNode, path: Path): BsonNode | undefined => {
    let node: BsonNode | undefined = root;
    for (const step of path) {
        if (!node) return undefined;
        if (node.t === 'object' && typeof step === 'string')
            node = node.entries.find((e) => e.key === step)?.value;
        else if (node.t === 'array' && typeof step === 'number') node = node.items[step];
        else return undefined;
    }
    return node;
};

const mapAt = (node: BsonNode, path: Path, change: (target: BsonNode) => BsonNode): BsonNode => {
    if (path.length === 0) return change(node);
    const [step, ...rest] = path;
    if (node.t === 'object' && typeof step === 'string')
        return {
            ...node,
            entries: node.entries.map((e) =>
                e.key === step ? { ...e, value: mapAt(e.value, rest, change) } : e,
            ),
        };
    if (node.t === 'array' && typeof step === 'number')
        return {
            ...node,
            items: node.items.map((item, i) => (i === step ? mapAt(item, rest, change) : item)),
        };
    return node;
};

/** Replaces the value at a path. */
export const setValue = (root: BsonNode, path: Path, value: BsonNode): BsonNode =>
    mapAt(root, path, () => value);

/** Adds a field to an object, or an item to an array (`key` is ignored). A duplicate name is refused. */
export const addEntry = (
    root: BsonNode,
    path: Path,
    key: string,
    value: BsonNode,
): BsonNode | { error: string } => {
    const target = nodeAt(root, path);
    if (!target) return { error: 'There is nothing at that place.' };
    if (target.t === 'object') {
        if (!key.trim()) return { error: 'A field needs a name.' };
        if (target.entries.some((e) => e.key === key))
            return { error: `The field “${key}” already exists.` };
        return mapAt(root, path, (t) =>
            t.t === 'object' ? { ...t, entries: [...t.entries, { key, value }] } : t,
        );
    }
    if (target.t === 'array')
        return mapAt(root, path, (t) =>
            t.t === 'array' ? { ...t, items: [...t.items, value] } : t,
        );
    return { error: 'Only an object or an array can have entries added.' };
};

export const removeEntry = (root: BsonNode, path: Path): BsonNode => {
    if (path.length === 0) return root;
    const parent = path.slice(0, -1);
    const last = path[path.length - 1]!;
    return mapAt(root, parent, (t) => {
        if (t.t === 'object') return { ...t, entries: t.entries.filter((e) => e.key !== last) };
        if (t.t === 'array') return { ...t, items: t.items.filter((_, i) => i !== last) };
        return t;
    });
};

export const renameField = (
    root: BsonNode,
    path: Path,
    name: string,
): BsonNode | { error: string } => {
    const parent = nodeAt(root, path.slice(0, -1));
    const old = path[path.length - 1];
    if (!parent || parent.t !== 'object' || typeof old !== 'string')
        return { error: 'Only a field can be renamed.' };
    if (!name.trim()) return { error: 'A field needs a name.' };
    if (name !== old && parent.entries.some((e) => e.key === name))
        return { error: `The field “${name}” already exists.` };
    return mapAt(root, path.slice(0, -1), (t) =>
        t.t === 'object'
            ? { ...t, entries: t.entries.map((e) => (e.key === old ? { ...e, key: name } : e)) }
            : t,
    );
};

/** A new value of a type, with a sensible starting value. */
export const defaultNode = (type: BsonType): BsonNode => {
    switch (type) {
        case 'object':
            return { t: 'object', entries: [] };
        case 'array':
            return { t: 'array', items: [] };
        case 'string':
            return { t: 'string', v: '' };
        case 'int32':
            return { t: 'int32', v: '0' };
        case 'int64':
            return { t: 'int64', v: '0' };
        case 'double':
            return { t: 'double', v: '0.0' };
        case 'decimal128':
            return { t: 'decimal128', v: '0' };
        case 'bool':
            return { t: 'bool', v: false };
        case 'null':
            return { t: 'null' };
        case 'objectId':
            return { t: 'objectId', v: '000000000000000000000000' };
        case 'date':
            return { t: 'date', v: new Date().toISOString() };
        case 'uuid':
            return { t: 'uuid', v: '00000000-0000-0000-0000-000000000000' };
        case 'binary':
            return { t: 'binary', v: '', subtype: 0 };
        case 'regex':
            return { t: 'regex', pattern: '', flags: '' };
        case 'timestamp':
            return { t: 'timestamp', seconds: 0, increment: 0 };
        case 'minKey':
            return { t: 'minKey' };
        case 'maxKey':
            return { t: 'maxKey' };
    }
};

/** The text form of a scalar, for the tree's edit box. */
export const scalarText = (node: BsonNode): string => {
    switch (node.t) {
        case 'string':
        case 'int32':
        case 'int64':
        case 'double':
        case 'decimal128':
        case 'objectId':
        case 'date':
        case 'uuid':
            return node.v;
        case 'bool':
            return String(node.v);
        case 'null':
            return 'null';
        case 'regex':
            return `/${node.pattern}/${node.flags}`;
        case 'binary':
            return node.v;
        default:
            return formatNode(node);
    }
};

/** Reads edited text back into a node of the given type, or says why it is not valid. */
export const parseScalar = (
    type: BsonType,
    text: string,
): { ok: true; node: BsonNode } | { ok: false; error: string } => {
    const t = text.trim();
    switch (type) {
        case 'string':
            return { ok: true, node: { t: 'string', v: text } };
        case 'int32':
            return /^-?\d+$/.test(t) &&
                BigInt(t) >= BigInt(INT32_MIN) &&
                BigInt(t) <= BigInt(INT32_MAX)
                ? { ok: true, node: { t: 'int32', v: t } }
                : {
                      ok: false,
                      error: 'Enter a whole number from −2,147,483,648 to 2,147,483,647.',
                  };
        case 'int64':
            return /^-?\d+$/.test(t) && BigInt(t) >= -(2n ** 63n) && BigInt(t) < 2n ** 63n
                ? { ok: true, node: { t: 'int64', v: t } }
                : { ok: false, error: 'Enter a whole number that fits in 64 bits.' };
        case 'double':
            return t !== '' && Number.isFinite(Number(t))
                ? { ok: true, node: { t: 'double', v: t } }
                : { ok: false, error: 'Enter a number.' };
        case 'decimal128':
            return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)
                ? { ok: true, node: { t: 'decimal128', v: t } }
                : { ok: false, error: 'Enter a decimal number.' };
        case 'bool':
            return t === 'true' || t === 'false'
                ? { ok: true, node: { t: 'bool', v: t === 'true' } }
                : { ok: false, error: 'Enter true or false.' };
        case 'null':
            return { ok: true, node: { t: 'null' } };
        case 'objectId':
            return OBJECT_ID.test(t)
                ? { ok: true, node: { t: 'objectId', v: t.toLowerCase() } }
                : { ok: false, error: 'An ObjectId is 24 hexadecimal characters.' };
        case 'date': {
            const date = new Date(t);
            return Number.isNaN(date.getTime())
                ? { ok: false, error: 'Enter a date such as 2026-01-31T12:00:00Z.' }
                : { ok: true, node: { t: 'date', v: date.toISOString() } };
        }
        case 'uuid':
            return /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(
                t,
            )
                ? { ok: true, node: { t: 'uuid', v: t.toLowerCase() } }
                : { ok: false, error: 'Enter a UUID.' };
        default: {
            const parsed = parseDocument(t);
            return parsed.ok ? { ok: true, node: parsed.node } : { ok: false, error: parsed.error };
        }
    }
};

/** The document's `_id` as shell text, for addressing it in an update or delete. */
export const idOf = (root: BsonNode): string | null => {
    if (root.t !== 'object') return null;
    const id = root.entries.find((e) => e.key === '_id')?.value;
    return id ? formatNode(id, 0, 0) : null;
};

/* ---------- Saving only what changed ---------- */

export interface DocumentChange {
    /** Dotted path to the new value. */
    set: { path: string; value: BsonNode }[];
    unset: string[];
}

export type DiffResult = ({ ok: true } & DocumentChange) | { ok: false; error: string };

/** Whether two nodes hold the same value, ignoring the order of an object's fields. */
export const sameNode = (a: BsonNode, b: BsonNode): boolean => {
    if (a.t !== b.t) return false;
    if (a.t === 'object' && b.t === 'object') {
        if (a.entries.length !== b.entries.length) return false;
        const other = new Map(b.entries.map((e) => [e.key, e.value]));
        return a.entries.every((e) => {
            const match = other.get(e.key);
            return match !== undefined && sameNode(e.value, match);
        });
    }
    if (a.t === 'array' && b.t === 'array')
        return (
            a.items.length === b.items.length &&
            a.items.every((item, i) => sameNode(item, b.items[i]!))
        );
    return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * What an edit changed, as `$set` and `$unset` paths. Saving only the changes keeps every field
 * that was not touched exactly as the server has it, including values whose type the editor cannot
 * show precisely (a whole-number double reads like an int32). An array is replaced as a whole when
 * any item changes, because positions are not a safe way to address its items. Field names that
 * contain a dot or start with `$` cannot be written as a path, and `_id` cannot change.
 */
export const diffDocument = (original: BsonNode, edited: BsonNode): DiffResult => {
    if (original.t !== 'object' || edited.t !== 'object')
        return { ok: false, error: 'A document must be an object.' };
    const set: DocumentChange['set'] = [];
    const unset: string[] = [];
    let failure: string | null = null;
    const visit = (
        before: Extract<BsonNode, { t: 'object' }>,
        after: Extract<BsonNode, { t: 'object' }>,
        prefix: string,
    ) => {
        const old = new Map(before.entries.map((e) => [e.key, e.value]));
        const now = new Map(after.entries.map((e) => [e.key, e.value]));
        for (const [key, value] of now) {
            if (key.includes('.') || key.startsWith('$')) {
                failure = `The field name “${key}” contains a dot or starts with $, which cannot be saved as a partial change. Use a replacement instead.`;
                return;
            }
            const path = prefix ? `${prefix}.${key}` : key;
            const previous = old.get(key);
            if (previous === undefined) set.push({ path, value });
            else if (previous.t === 'object' && value.t === 'object') visit(previous, value, path);
            else if (!sameNode(previous, value)) set.push({ path, value });
        }
        for (const key of old.keys()) {
            if (!now.has(key)) unset.push(prefix ? `${prefix}.${key}` : key);
        }
    };
    const beforeId = original.entries.find((e) => e.key === '_id')?.value;
    const afterId = edited.entries.find((e) => e.key === '_id')?.value;
    if (beforeId && (!afterId || !sameNode(beforeId, afterId)))
        return { ok: false, error: 'The _id of a document cannot be changed.' };
    visit(original, edited, '');
    return failure ? { ok: false, error: failure } : { ok: true, set, unset };
};
