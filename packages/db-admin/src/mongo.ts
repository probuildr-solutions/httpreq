/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * MongoDB statements, written in the shell syntax the MongoDB engine reads. A MongoDB collection
 * has no tables, columns or foreign keys, so none of the relational generators apply; these are
 * its own: documents, collections, indexes, views and validation rules.
 */

import { formatNode, type DocumentChange } from './bsonDocument';

const q = (value: string) => JSON.stringify(value);

/**
 * A statement names its database with getSiblingDB instead of `use`: `use` would move every other
 * tab on the same connection to that database.
 */
const root = (database?: string) => (database ? `db.getSiblingDB(${q(database)})` : 'db');

const collection = (name: string, database?: string) =>
    `${root(database)}.getCollection(${q(name)})`;

export interface FindOptions {
    /** Shell text of the filter, `{}` by default. */
    filter?: string;
    projection?: string;
    sort?: string;
    skip?: number;
    limit?: number;
    /** Return each whole document in one `document` cell, for the document editor. */
    asDocuments?: boolean;
}

export const findStatement = (
    database: string | undefined,
    name: string,
    options: FindOptions = {},
): string => {
    const filter = options.filter?.trim() || '{}';
    const projection = options.projection?.trim();
    let text = `${collection(name, database)}.find(${filter}${projection ? `, ${projection}` : ''})`;
    if (options.sort?.trim()) text += `.sort(${options.sort.trim()})`;
    if (options.skip) text += `.skip(${Math.max(0, Math.floor(options.skip))})`;
    if (options.limit) text += `.limit(${Math.max(1, Math.floor(options.limit))})`;
    if (options.asDocuments) text += '.asDocuments()';
    return text;
};

export const countStatement = (database: string | undefined, name: string, filter = '{}'): string =>
    `${collection(name, database)}.countDocuments(${filter.trim() || '{}'})`;

export const insertDocumentStatement = (
    database: string | undefined,
    name: string,
    documentText: string,
): string => `${collection(name, database)}.insertOne(${documentText.trim()})`;

/** Replaces the whole document that has this `_id` (shell text) with the edited one. */
export const replaceDocumentStatement = (
    database: string | undefined,
    name: string,
    idText: string,
    documentText: string,
): string => `${collection(name, database)}.replaceOne({ _id: ${idText} }, ${documentText.trim()})`;

/** Saves only the changed fields of the document with this `_id` (shell text). */
export const updateDocumentStatement = (
    database: string | undefined,
    name: string,
    idText: string,
    change: DocumentChange,
): string => {
    const parts: string[] = [];
    if (change.set.length)
        parts.push(
            `$set: { ${change.set.map((s) => `${q(s.path)}: ${formatNode(s.value, 0, 0).replace(/\s*\n\s*/g, ' ')}`).join(', ')} }`,
        );
    if (change.unset.length)
        parts.push(`$unset: { ${change.unset.map((path) => `${q(path)}: ""`).join(', ')} }`);
    return `${collection(name, database)}.updateOne({ _id: ${idText} }, { ${parts.join(', ')} })`;
};

export const deleteDocumentStatement = (
    database: string | undefined,
    name: string,
    idText: string,
): string => `${collection(name, database)}.deleteOne({ _id: ${idText} })`;

export const dropCollectionStatement = (database: string | undefined, name: string): string =>
    `${collection(name, database)}.drop()`;

export const renameCollectionStatement = (
    database: string | undefined,
    name: string,
    to: string,
): string => `${collection(name, database)}.renameCollection(${q(to)})`;

export interface CollectionOptionsDesign {
    capped?: boolean;
    sizeBytes?: number;
    maxDocuments?: number;
    /** Shell text of a `$jsonSchema` validator or query validator. */
    validator?: string;
    validationLevel?: 'off' | 'moderate' | 'strict';
    validationAction?: 'error' | 'warn';
}

export const createCollectionStatement = (
    database: string | undefined,
    name: string,
    options: CollectionOptionsDesign = {},
): string => {
    const parts: string[] = [];
    if (options.capped) {
        parts.push('capped: true');
        if (options.sizeBytes) parts.push(`size: ${Math.floor(options.sizeBytes)}`);
        if (options.maxDocuments) parts.push(`max: ${Math.floor(options.maxDocuments)}`);
    }
    if (options.validator?.trim()) parts.push(`validator: ${options.validator.trim()}`);
    if (options.validationLevel) parts.push(`validationLevel: ${q(options.validationLevel)}`);
    if (options.validationAction) parts.push(`validationAction: ${q(options.validationAction)}`);
    return `${root(database)}.createCollection(${q(name)}${parts.length ? `, { ${parts.join(', ')} }` : ''})`;
};

/** Changes the validation rules of an existing collection. */
export const setValidationStatement = (
    database: string | undefined,
    name: string,
    options: Pick<CollectionOptionsDesign, 'validator' | 'validationLevel' | 'validationAction'>,
): string => {
    const parts = [`collMod: ${q(name)}`, `validator: ${options.validator?.trim() || '{}'}`];
    if (options.validationLevel) parts.push(`validationLevel: ${q(options.validationLevel)}`);
    if (options.validationAction) parts.push(`validationAction: ${q(options.validationAction)}`);
    return `${root(database)}.runCommand({ ${parts.join(', ')} })`;
};

export interface MongoIndexDesign {
    /** Shell text of the key pattern: `{ email: 1 }`, `{ a: 1, b: -1 }`, `{ title: "text" }`. */
    keys: string;
    name?: string;
    unique?: boolean;
    sparse?: boolean;
    /** Seconds, for a TTL index. */
    expireAfterSeconds?: number;
    /** Shell text of a partial filter expression. */
    partialFilter?: string;
    background?: boolean;
}

export const createIndexStatement = (
    database: string | undefined,
    name: string,
    index: MongoIndexDesign,
): string => {
    const options: string[] = [];
    if (index.name) options.push(`name: ${q(index.name)}`);
    if (index.unique) options.push('unique: true');
    if (index.sparse) options.push('sparse: true');
    if (index.expireAfterSeconds !== undefined)
        options.push(`expireAfterSeconds: ${Math.floor(index.expireAfterSeconds)}`);
    if (index.partialFilter?.trim())
        options.push(`partialFilterExpression: ${index.partialFilter.trim()}`);
    return `${collection(name, database)}.createIndex(${index.keys.trim()}${options.length ? `, { ${options.join(', ')} }` : ''})`;
};

export const dropIndexStatement = (
    database: string | undefined,
    name: string,
    indexName: string,
): string => `${collection(name, database)}.dropIndex(${q(indexName)})`;

export const createViewStatement = (
    database: string | undefined,
    viewName: string,
    source: string,
    pipeline: string,
): string =>
    `${root(database)}.createView(${q(viewName)}, ${q(source)}, ${pipeline.trim() || '[]'})`;

export const dropViewStatement = dropCollectionStatement;

/** A starting point for a `$jsonSchema` validator. */
export const VALIDATOR_TEMPLATE = `{
  $jsonSchema: {
    bsonType: "object",
    required: ["name"],
    properties: {
      name: { bsonType: "string", description: "must be a string" }
    }
  }
}`;
