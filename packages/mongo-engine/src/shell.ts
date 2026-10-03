/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError, type DbValue } from '@httpreq/db-core';
import type { BsonDocument } from '@httpreq/db-protocol-mongo';
import { newObjectId, parseArguments, parseValue } from './relaxed';

/**
 * What a result looks like, so the session knows how to show it.
 * - `cursor`: documents in `cursor.firstBatch`, continued with `getMore`.
 * - `document`: one reply document, shown as a single row (or key/value rows).
 * - `write`: the outcome of an insert, update or delete, in the shell's vocabulary.
 * - `count`: one number.
 * - `values`: a list of values (`distinct`, collection names).
 */
export type Shape = 'cursor' | 'document' | 'write' | 'count' | 'values';

export type Plan =
    /** `use shop`: changes the database later statements run on. */
    | { kind: 'use'; database: string }
    | {
          kind: 'command';
          database: string;
          command: BsonDocument;
          shape: Shape;
          /** For `write` and the helpers that report something other than the raw reply. */
          write?: 'insert' | 'update' | 'delete' | 'modify';
          /** Ids generated for an insert, so the result can show them. */
          insertedIds?: DbValue[];
          /** For `values`: the field of the reply that holds them. */
          valuesField?: string;
          /** The shell helper's name, for messages. */
          helper: string;
          /** The command can be wrapped in `explain`. */
          explainable: boolean;
          /**
           * `.asDocuments()`: the result is one `document` column holding each whole document,
           * for editors that need every field exactly (a table would drop fields past the 40th and
           * cannot tell a missing field from a null one).
           */
          documents?: boolean;
      };

const fail = (message: string): never => {
    throw new DbError('INVALID_REQUEST', message);
};

const isObject = (value: DbValue | undefined): value is BsonDocument =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array) &&
    !('$type' in value && '$value' in value && Object.keys(value).length === 2);

const doc = (value: DbValue | undefined, what: string): BsonDocument => {
    if (value === undefined) return {};
    if (!isObject(value)) return fail(`${what} must be a document ({ … }).`);
    return value;
};

const docs = (value: DbValue | undefined, what: string): BsonDocument[] => {
    if (!Array.isArray(value) || !value.every(isObject))
        return fail(`${what} must be an array of documents.`);
    return value as BsonDocument[];
};

const hasOperators = (value: BsonDocument): boolean =>
    Object.keys(value).some((key) => key.startsWith('$'));

/** Generates `_id` first, as the server would, when a document has none. */
const withId = (document: BsonDocument): BsonDocument => {
    if ('_id' in document) return document;
    return { _id: newObjectId(), ...document };
};

const COLLECTION_METHODS = new Set([
    'find',
    'findOne',
    'aggregate',
    'countDocuments',
    'estimatedDocumentCount',
    'count',
    'distinct',
    'insertOne',
    'insertMany',
    'insert',
    'updateOne',
    'updateMany',
    'replaceOne',
    'update',
    'deleteOne',
    'deleteMany',
    'remove',
    'findOneAndUpdate',
    'findOneAndReplace',
    'findOneAndDelete',
    'createIndex',
    'createIndexes',
    'dropIndex',
    'dropIndexes',
    'getIndexes',
    'drop',
    'stats',
    'explain',
]);

const DATABASE_METHODS = new Set([
    'runCommand',
    'adminCommand',
    'stats',
    'getCollectionNames',
    'getCollectionInfos',
    'dropDatabase',
    'createCollection',
    'serverStatus',
    'version',
    'currentOp',
    'getName',
]);

/** The name an index gets when none is given: `a_1_b_-1`. */
export const indexName = (keys: BsonDocument): string =>
    Object.entries(keys)
        .map(
            ([field, direction]) =>
                `${field}_${typeof direction === 'object' ? JSON.stringify(direction) : String(direction)}`,
        )
        .join('_');

/* ---------- Statement text ---------- */

const stripLeading = (text: string): string => {
    let s = text;
    for (;;) {
        s = s.replace(/^\s+/, '');
        if (s.startsWith('//')) s = s.replace(/^\/\/[^\n]*/, '');
        else if (s.startsWith('/*')) {
            const end = s.indexOf('*/');
            if (end < 0) return fail('A comment is not closed.');
            s = s.slice(end + 2);
        } else return s;
    }
};

interface Chain {
    name: string;
    args: DbValue[];
}

/** Reads `.name(args)` repeated, until the text ends. */
const readChain = (text: string, from: number): Chain[] => {
    const chain: Chain[] = [];
    let i = from;
    for (;;) {
        while (/\s/.test(text[i] ?? '')) i++;
        if (i >= text.length || text[i] === ';') return chain;
        if (text[i] !== '.')
            return fail(`Unexpected text “${text.slice(i, i + 20)}”; expected “.method(…)”.`);
        i++;
        while (/\s/.test(text[i] ?? '')) i++;
        const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];
        if (!name) return fail('A method name is expected after “.”.');
        i += name.length;
        while (/\s/.test(text[i] ?? '')) i++;
        if (text[i] !== '(') return fail(`“${name}” must be called with ( ).`);
        const parsed = parseArguments(text, i);
        chain.push({ name, args: parsed.value });
        i = parsed.end;
    }
};

/**
 * Turns one shell statement into a plan: a database command and how to show its result.
 * `current` is the database in use (`use` changes it between statements).
 */
export const parseStatement = (source: string, currentDatabase: string): Plan => {
    let text = stripLeading(source).replace(/;\s*$/, '').trim();
    let current = currentDatabase;
    if (!text) return fail('There is nothing to run.');

    // db.getSiblingDB("other").coll.find(): the statement runs on another database without `use`,
    // which would change the database every other tab on this connection runs in.
    const sibling = /^db\s*\.\s*getSiblingDB\s*\(\s*(["'])([^"'\\]+)\1\s*\)/.exec(text);
    if (sibling) {
        current = sibling[2]!;
        text = `db${text.slice(sibling[0].length)}`;
    }

    const use = /^use\s+([^\s;]+)\s*$/i.exec(text);
    if (use) return { kind: 'use', database: use[1]!.replace(/^["']|["']$/g, '') };

    const show = /^show\s+(\w+)\s*$/i.exec(text);
    if (show) {
        switch (show[1]!.toLowerCase()) {
            case 'dbs':
            case 'databases':
                return command('admin', { listDatabases: 1 }, 'document', 'show dbs', false, {
                    valuesField: 'databases',
                });
            case 'collections':
            case 'tables':
                return command(
                    current,
                    { listCollections: 1, nameOnly: true },
                    'cursor',
                    'show collections',
                );
            default:
                return fail(
                    `“show ${show[1]}” is not supported. Try show dbs or show collections.`,
                );
        }
    }

    const head = /^db\s*\.\s*/.exec(text);
    if (!head)
        return fail(
            'A statement starts with db., use or show. Example: db.users.find({ age: { $gt: 30 } })',
        );
    let i = head[0].length;

    // db.getCollection("name") or db.name
    let collection: string | null = null;
    const viaGet = /^getCollection\s*\(/.exec(text.slice(i));
    if (viaGet) {
        const args = parseArguments(text, i + viaGet[0].length - 1);
        if (typeof args.value[0] !== 'string' || !args.value[0])
            return fail('getCollection() takes the collection’s name.');
        collection = args.value[0];
        i = args.end;
    } else {
        const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))?.[0];
        if (!name) return fail('A collection or a database method is expected after “db.”.');
        const afterName = text.slice(i + name.length).trimStart();
        if (afterName.startsWith('(')) {
            // db.method(...)
            if (!DATABASE_METHODS.has(name)) return fail(`“db.${name}()” is not supported.`);
            const chain = readChain(text, head[0].lastIndexOf('.'));
            return databaseMethod(chain, current);
        }
        collection = name;
        i += name.length;
    }
    const chain = readChain(text, i);
    return collectionMethod(collection, chain, current);
};

const command = (
    database: string,
    body: BsonDocument,
    shape: Shape,
    helper: string,
    explainable = false,
    extra: {
        write?: 'insert' | 'update' | 'delete' | 'modify';
        insertedIds?: DbValue[];
        valuesField?: string;
    } = {},
): Plan => ({ kind: 'command', database, command: body, shape, helper, explainable, ...extra });

/* ---------- db.method() ---------- */

const databaseMethod = (chain: Chain[], current: string): Plan => {
    const [first, ...rest] = chain;
    if (!first) return fail('A method is expected.');
    if (rest.length > 0) return fail(`“.${rest[0]!.name}()” cannot follow db.${first.name}().`);
    const { name, args } = first;
    switch (name) {
        case 'runCommand': {
            const body = args[0];
            if (typeof body === 'string')
                return command(current, { [body]: 1 }, 'document', 'db.runCommand');
            return command(current, doc(body, 'The command'), 'document', 'db.runCommand');
        }
        case 'adminCommand': {
            const body = args[0];
            return command(
                'admin',
                typeof body === 'string' ? { [body]: 1 } : doc(body, 'The command'),
                'document',
                'db.adminCommand',
            );
        }
        case 'stats':
            return command(current, { dbStats: 1 }, 'document', 'db.stats');
        case 'getCollectionNames':
            return command(
                current,
                { listCollections: 1, nameOnly: true },
                'values',
                'db.getCollectionNames',
                false,
                { valuesField: 'name' },
            );
        case 'getCollectionInfos':
            return command(current, { listCollections: 1 }, 'cursor', 'db.getCollectionInfos');
        case 'dropDatabase':
            return command(current, { dropDatabase: 1 }, 'document', 'db.dropDatabase');
        case 'createCollection': {
            if (typeof args[0] !== 'string' || !args[0])
                return fail('createCollection() takes the collection’s name.');
            return command(
                current,
                { create: args[0], ...doc(args[1], 'The options') },
                'document',
                'db.createCollection',
            );
        }
        case 'serverStatus':
            return command('admin', { serverStatus: 1 }, 'document', 'db.serverStatus');
        case 'version':
            return command('admin', { buildInfo: 1 }, 'document', 'db.version');
        case 'currentOp':
            return command(
                'admin',
                {
                    aggregate: 1,
                    pipeline: [{ $currentOp: { allUsers: true, localOps: true } }],
                    cursor: {},
                },
                'cursor',
                'db.currentOp',
            );
        case 'getName':
            return command(current, { ping: 1 }, 'document', 'db.getName');
        default:
            return fail(`“db.${name}()” is not supported.`);
    }
};

/* ---------- db.collection.method() ---------- */

const collectionMethod = (collection: string, chain: Chain[], current: string): Plan => {
    let steps = chain;
    let explain: { verbosity: string } | null = null;
    if (steps[0]?.name === 'explain') {
        const verbosity = steps[0].args[0];
        explain = { verbosity: typeof verbosity === 'string' ? verbosity : 'queryPlanner' };
        steps = steps.slice(1);
        if (steps.length === 0)
            return fail('explain() is followed by the method to explain, such as .find({…}).');
    }
    const [first, ...modifiers] = steps;
    if (!first) return fail(`A method is expected after db.${collection}.`);
    if (!COLLECTION_METHODS.has(first.name))
        return fail(`“${first.name}()” is not supported on a collection.`);
    const { name, args } = first;
    const label = `db.${collection}.${name}`;
    const run = (body: BsonDocument, shape: Shape, extra = {}, explainable = false): Plan =>
        command(current, body, shape, label, explainable, extra);

    let plan: Plan;
    switch (name) {
        case 'find':
        case 'findOne': {
            const body: BsonDocument = { find: collection, filter: doc(args[0], 'The filter') };
            if (args[1] !== undefined) body.projection = doc(args[1], 'The projection');
            if (name === 'findOne') {
                body.limit = 1;
                body.singleBatch = true;
            }
            for (const step of modifiers) applyFindModifier(body, step);
            plan = run(body, 'cursor', {}, true);
            if (modifiers.some((step) => step.name === 'asDocuments') && plan.kind === 'command')
                plan.documents = true;
            break;
        }
        case 'aggregate': {
            if (!Array.isArray(args[0]))
                return fail('aggregate() takes an array of stages: [ { $match: { … } }, … ]');
            const options = doc(args[1], 'The options');
            plan = run(
                { aggregate: collection, pipeline: args[0], cursor: {}, ...options },
                'cursor',
                {},
                true,
            );
            for (const step of modifiers) {
                if (step.name === 'toArray' || step.name === 'pretty') continue;
                return fail(`“.${step.name}()” cannot follow aggregate().`);
            }
            break;
        }
        case 'countDocuments':
            plan = run(
                {
                    aggregate: collection,
                    pipeline: [
                        { $match: doc(args[0], 'The filter') },
                        { $group: { _id: 1, n: { $sum: 1 } } },
                    ],
                    cursor: {},
                },
                'count',
            );
            break;
        case 'estimatedDocumentCount':
            plan = run({ count: collection }, 'count');
            break;
        case 'count':
            plan = run({ count: collection, query: doc(args[0], 'The filter') }, 'count', {}, true);
            break;
        case 'distinct': {
            if (typeof args[0] !== 'string') return fail('distinct() takes the field name first.');
            plan = run(
                { distinct: collection, key: args[0], query: doc(args[1], 'The filter') },
                'values',
                { valuesField: 'values' },
                true,
            );
            break;
        }
        case 'insertOne':
        case 'insert': {
            const given = args[0];
            if (Array.isArray(given)) {
                const documents = docs(given, 'The documents').map(withId);
                plan = run({ insert: collection, documents }, 'write', {
                    write: 'insert',
                    insertedIds: documents.map((d) => d._id!),
                });
            } else {
                const document = withId(doc(given, 'The document'));
                plan = run({ insert: collection, documents: [document] }, 'write', {
                    write: 'insert',
                    insertedIds: [document._id!],
                });
            }
            break;
        }
        case 'insertMany': {
            const documents = docs(args[0], 'The documents').map(withId);
            const options = doc(args[1], 'The options');
            plan = run(
                { insert: collection, documents, ordered: options.ordered !== false },
                'write',
                { write: 'insert', insertedIds: documents.map((d) => d._id!) },
            );
            break;
        }
        case 'updateOne':
        case 'updateMany':
        case 'replaceOne': {
            const filter = doc(args[0], 'The filter');
            const change = args[1];
            const options = doc(args[2], 'The options');
            if (name === 'replaceOne') {
                const replacement = doc(change, 'The replacement');
                if (hasOperators(replacement))
                    return fail(
                        'replaceOne() takes a plain document, without $ operators. Use updateOne() to change fields.',
                    );
            } else if (Array.isArray(change)) {
                // An aggregation pipeline update.
            } else if (
                !hasOperators(doc(change, 'The update')) ||
                Object.keys(doc(change, 'The update')).some((k) => !k.startsWith('$'))
            ) {
                return fail(
                    `${name}() needs update operators such as { $set: { … } }. Use replaceOne() to replace a whole document.`,
                );
            }
            plan = run(
                {
                    update: collection,
                    updates: [
                        {
                            q: filter,
                            u: change as DbValue,
                            multi: name === 'updateMany',
                            ...(options.upsert === true ? { upsert: true } : {}),
                            ...(options.arrayFilters ? { arrayFilters: options.arrayFilters } : {}),
                            ...(options.collation ? { collation: options.collation } : {}),
                            ...(options.hint ? { hint: options.hint } : {}),
                        },
                    ],
                },
                'write',
                { write: 'update' },
                true,
            );
            break;
        }
        case 'update': {
            // The legacy form: db.c.update(filter, update, { multi, upsert }).
            const filter = doc(args[0], 'The filter');
            const change = args[1];
            const options = doc(args[2], 'The options');
            plan = run(
                {
                    update: collection,
                    updates: [
                        {
                            q: filter,
                            u: change as DbValue,
                            multi: options.multi === true,
                            ...(options.upsert === true ? { upsert: true } : {}),
                        },
                    ],
                },
                'write',
                { write: 'update' },
                true,
            );
            break;
        }
        case 'deleteOne':
        case 'deleteMany':
        case 'remove': {
            const one =
                name === 'deleteOne' ||
                (name === 'remove' && doc(args[1], 'The options').justOne === true);
            plan = run(
                {
                    delete: collection,
                    deletes: [{ q: doc(args[0], 'The filter'), limit: one ? 1 : 0 }],
                },
                'write',
                { write: 'delete' },
                true,
            );
            break;
        }
        case 'findOneAndUpdate':
        case 'findOneAndReplace':
        case 'findOneAndDelete': {
            const options = doc(name === 'findOneAndDelete' ? args[1] : args[2], 'The options');
            const body: BsonDocument = {
                findAndModify: collection,
                query: doc(args[0], 'The filter'),
            };
            if (name === 'findOneAndDelete') body.remove = true;
            else {
                body.update = args[1] as DbValue;
                if (
                    name === 'findOneAndUpdate' &&
                    !Array.isArray(args[1]) &&
                    !hasOperators(doc(args[1], 'The update'))
                ) {
                    return fail(
                        'findOneAndUpdate() needs update operators such as { $set: { … } }.',
                    );
                }
                if (options.returnDocument === 'after' || options.returnNewDocument === true)
                    body.new = true;
                if (options.upsert === true) body.upsert = true;
            }
            if (options.sort) body.sort = options.sort;
            if (options.projection) body.fields = options.projection;
            plan = run(body, 'document', { write: 'modify' }, true);
            break;
        }
        case 'createIndex':
        case 'createIndexes': {
            const specs =
                name === 'createIndex'
                    ? [{ key: doc(args[0], 'The index keys'), ...doc(args[1], 'The options') }]
                    : docs(args[0], 'The index specifications');
            const indexes = specs.map((spec) => ({
                ...spec,
                name:
                    typeof spec.name === 'string' ? spec.name : indexName(spec.key as BsonDocument),
            }));
            plan = run({ createIndexes: collection, indexes }, 'document');
            break;
        }
        case 'dropIndex':
        case 'dropIndexes': {
            const target = args[0] ?? '*';
            plan = run(
                { dropIndexes: collection, index: isObject(target) ? indexName(target) : target },
                'document',
            );
            break;
        }
        case 'getIndexes':
            plan = run({ listIndexes: collection }, 'cursor');
            break;
        case 'drop':
            plan = run({ drop: collection }, 'document');
            break;
        case 'stats':
            plan = run({ collStats: collection }, 'document');
            break;
        default:
            return fail(`“${name}()” is not supported on a collection.`);
    }
    if (explain) {
        const body = (plan as Extract<Plan, { kind: 'command' }>).command;
        if (!(plan as Extract<Plan, { kind: 'command' }>).explainable)
            return fail(`${name}() cannot be explained.`);
        return command(
            current,
            { explain: body, verbosity: explain.verbosity },
            'document',
            `${label}.explain`,
        );
    }
    return plan;
};

/** `.sort() .limit() .skip() …` after a find. */
const applyFindModifier = (body: BsonDocument, step: Chain): void => {
    const first = step.args[0];
    switch (step.name) {
        case 'sort':
            body.sort = doc(first, 'The sort');
            break;
        case 'limit': {
            const n = Number(first);
            if (!Number.isInteger(n) || n < 0) fail('limit() takes a number of documents.');
            // A limit of 0 means no limit.
            if (n > 0) body.limit = n;
            break;
        }
        case 'skip': {
            const n = Number(first);
            if (!Number.isInteger(n) || n < 0) fail('skip() takes a number of documents.');
            body.skip = n;
            break;
        }
        case 'projection':
        case 'project':
            body.projection = doc(first, 'The projection');
            break;
        case 'hint':
            body.hint = first as DbValue;
            break;
        case 'batchSize':
            body.batchSize = Number(first);
            break;
        case 'maxTimeMS':
            body.maxTimeMS = Number(first);
            break;
        case 'collation':
            body.collation = doc(first, 'The collation');
            break;
        case 'toArray':
        case 'pretty':
        case 'asDocuments':
            break;
        default:
            fail(`“.${step.name}()” cannot follow find().`);
    }
};

/* ---------- Splitting a script ---------- */

/**
 * Splits text into statements. A statement ends at a `;` or a line break where every bracket,
 * quote and comment is closed and the next line does not continue it with a leading `.`, so
 * both one-line statements and a query laid out over many lines work.
 */
export const splitShellStatements = (
    text: string,
): { start: number; end: number; sql: string }[] => {
    const out: { start: number; end: number; sql: string }[] = [];
    let depth = 0;
    let start = -1;
    let i = 0;
    const push = (end: number) => {
        if (start < 0) return;
        const sql = text.slice(start, end).replace(/;\s*$/, '').trimEnd();
        // A run of nothing but comments is not a statement.
        if (/\S/.test(sql.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) {
            out.push({ start, end: start + sql.length, sql });
        }
        start = -1;
    };
    while (i < text.length) {
        const c = text[i]!;
        if (start < 0 && /\s/.test(c)) {
            i++;
            continue;
        }
        if (start < 0) start = i;
        if (c === '"' || c === "'") {
            i++;
            while (i < text.length && text[i] !== c) {
                if (text[i] === '\\') i++;
                i++;
            }
            i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            i = close < 0 ? text.length : close + 2;
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
        else if (c === ';' && depth === 0) {
            push(i + 1);
            i++;
            continue;
        } else if (c === '\n' && depth === 0) {
            // A line that starts with `.` continues the statement (method chaining).
            const rest = text.slice(i + 1).match(/^\s*(\S)/);
            if (!rest || rest[1] !== '.') {
                push(i);
                i++;
                continue;
            }
        }
        i++;
    }
    push(text.length);
    return out;
};

export { parseValue };
