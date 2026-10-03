/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { BSON_TYPES, type BsonTypeName } from './typeCatalog';

/**
 * The MongoDB collection designer's model. A collection is not a table: it has options (capped,
 * time series, collation, clustered index) and an optional `$jsonSchema` validator, which a field
 * grid can generate. Fields nest: an `object` field has child fields, an `array` field describes
 * its items, so the grid is a tree, not a flat list.
 */
export interface FieldDesign {
    id: string;
    name: string;
    bsonType: BsonTypeName;
    required: boolean;
    description?: string;
    /** Documentation only: `$jsonSchema` has no `default` keyword the server applies. */
    default?: string;
    /** Validation keywords for the type (see `validationKeywords`). */
    rules: Record<string, string>;
    /** For `object`: the child fields. */
    children: FieldDesign[];
    /** For `array`: the type of the items, and their fields when they are objects. */
    items?: { bsonType: BsonTypeName; children: FieldDesign[] };
}

export interface TimeSeriesDesign {
    timeField: string;
    metaField?: string;
    granularity?: 'seconds' | 'minutes' | 'hours';
    expireAfterSeconds?: number;
}

export interface CollectionDesign {
    database?: string;
    name: string;
    capped: boolean;
    sizeBytes?: number;
    maxDocuments?: number;
    collation?: { locale: string; strength?: number };
    timeSeries?: TimeSeriesDesign;
    clusteredIndex?: boolean;
    fields: FieldDesign[];
    /** Hand-written `$jsonSchema` (or other validator) that replaces the generated one when set. */
    customValidator?: string;
    validationLevel: 'off' | 'moderate' | 'strict';
    validationAction: 'error' | 'warn';
    additionalProperties: boolean;
}

let counter = 0;
export const newFieldId = (): string => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

export const emptyCollection = (): CollectionDesign => ({
    name: '',
    capped: false,
    fields: [],
    validationLevel: 'strict',
    validationAction: 'error',
    additionalProperties: true,
});

export const newField = (bsonType: BsonTypeName = 'string'): FieldDesign => ({
    id: newFieldId(),
    name: '',
    bsonType,
    required: false,
    rules: {},
    children: [],
});

/** The keywords a type can be validated with; the form shows exactly these. */
export const validationKeywords = (
    type: BsonTypeName,
): { key: string; label: string; kind: 'number' | 'text' | 'list' }[] => {
    switch (type) {
        case 'string':
            return [
                { key: 'minLength', label: 'Min length', kind: 'number' },
                { key: 'maxLength', label: 'Max length', kind: 'number' },
                { key: 'pattern', label: 'Pattern', kind: 'text' },
                { key: 'enum', label: 'Allowed values', kind: 'list' },
            ];
        case 'int':
        case 'long':
        case 'double':
        case 'decimal':
            return [
                { key: 'minimum', label: 'Minimum', kind: 'number' },
                { key: 'maximum', label: 'Maximum', kind: 'number' },
                { key: 'enum', label: 'Allowed values', kind: 'list' },
            ];
        case 'array':
            return [
                { key: 'minItems', label: 'Min items', kind: 'number' },
                { key: 'maxItems', label: 'Max items', kind: 'number' },
                { key: 'uniqueItems', label: 'Unique items', kind: 'text' },
            ];
        case 'object':
            return [
                { key: 'minProperties', label: 'Min properties', kind: 'number' },
                { key: 'maxProperties', label: 'Max properties', kind: 'number' },
            ];
        default:
            return [];
    }
};

const isNumber = (value: string) => /^-?\d+(?:\.\d+)?$/.test(value.trim());

const ruleValue = (key: string, kind: 'number' | 'text' | 'list', raw: string): unknown => {
    const value = raw.trim();
    if (kind === 'number') return isNumber(value) ? Number(value) : undefined;
    if (kind === 'list')
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => (isNumber(item) ? Number(item) : item));
    if (key === 'uniqueItems') return value === 'true' ? true : undefined;
    return value;
};

const schemaOf = (
    type: BsonTypeName,
    field: Pick<FieldDesign, 'description' | 'rules' | 'children'>,
    items?: FieldDesign['items'],
    additionalProperties = true,
): Record<string, unknown> => {
    const schema: Record<string, unknown> = { bsonType: type };
    if (field.description?.trim()) schema.description = field.description.trim();
    for (const keyword of validationKeywords(type)) {
        const raw = field.rules[keyword.key];
        if (raw === undefined || raw.trim() === '') continue;
        const value = ruleValue(keyword.key, keyword.kind, raw);
        if (value !== undefined && !(Array.isArray(value) && value.length === 0))
            schema[keyword.key] = value;
    }
    if (type === 'object')
        Object.assign(schema, propertiesOf(field.children, additionalProperties));
    if (type === 'array' && items) {
        schema.items = schemaOf(
            items.bsonType,
            { rules: {}, children: items.children },
            undefined,
            additionalProperties,
        );
    }
    return schema;
};

const propertiesOf = (
    fields: FieldDesign[],
    additionalProperties: boolean,
): Record<string, unknown> => {
    const named = fields.filter((field) => field.name.trim());
    const result: Record<string, unknown> = {};
    const required = named.filter((field) => field.required).map((field) => field.name.trim());
    if (required.length) result.required = required;
    if (named.length)
        result.properties = Object.fromEntries(
            named.map((field) => [
                field.name.trim(),
                schemaOf(field.bsonType, field, field.items, additionalProperties),
            ]),
        );
    if (!additionalProperties) result.additionalProperties = false;
    return result;
};

/** The `$jsonSchema` the field grid describes, or `null` when there are no named fields. */
export const jsonSchemaFromFields = (
    fields: FieldDesign[],
    options: { additionalProperties?: boolean } = {},
): Record<string, unknown> | null => {
    if (!fields.some((field) => field.name.trim())) return null;
    return { bsonType: 'object', ...propertiesOf(fields, options.additionalProperties ?? true) };
};

/** The validator as shell text: the hand-written one, else the one generated from the fields. */
export const validatorText = (design: CollectionDesign): string | undefined => {
    if (design.customValidator?.trim()) return design.customValidator.trim();
    const schema = jsonSchemaFromFields(design.fields, {
        additionalProperties: design.additionalProperties,
    });
    return schema
        ? `{ $jsonSchema: ${JSON.stringify(schema, null, 2).split('\n').join('\n  ')} }`
        : undefined;
};

/** Reads a `$jsonSchema` back into fields, for editing an existing collection. */
export const fieldsFromJsonSchema = (schema: unknown): FieldDesign[] => {
    const read = (node: unknown): FieldDesign[] => {
        if (!node || typeof node !== 'object') return [];
        const object = node as Record<string, unknown>;
        const properties = object.properties;
        if (!properties || typeof properties !== 'object') return [];
        const required = new Set(
            Array.isArray(object.required) ? (object.required as string[]) : [],
        );
        return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
            const spec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
            const bsonType = (BSON_TYPES as readonly string[]).includes(String(spec.bsonType))
                ? (spec.bsonType as BsonTypeName)
                : 'string';
            const field: FieldDesign = {
                ...newField(bsonType),
                name,
                required: required.has(name),
                description: typeof spec.description === 'string' ? spec.description : undefined,
                children: bsonType === 'object' ? read(spec) : [],
            };
            for (const keyword of validationKeywords(bsonType)) {
                const value = spec[keyword.key];
                if (value !== undefined)
                    field.rules[keyword.key] = Array.isArray(value)
                        ? value.join(', ')
                        : String(value);
            }
            if (bsonType === 'array' && spec.items && typeof spec.items === 'object') {
                const items = spec.items as Record<string, unknown>;
                const itemType = (BSON_TYPES as readonly string[]).includes(String(items.bsonType))
                    ? (items.bsonType as BsonTypeName)
                    : 'string';
                field.items = {
                    bsonType: itemType,
                    children: itemType === 'object' ? read(items) : [],
                };
            }
            return field;
        });
    };
    return read(schema);
};

const q = (value: string) => JSON.stringify(value);

/** Why a collection design cannot be created; empty when it can. */
export const validateCollection = (design: CollectionDesign): string[] => {
    const problems: string[] = [];
    const name = design.name.trim();
    if (!name) problems.push('The collection needs a name.');
    else if (/^system\./.test(name)) problems.push('Names starting with "system." are reserved.');
    else if (name.includes('$') || name.includes('\0'))
        problems.push('The name cannot contain "$" or a null character.');
    if (design.capped) {
        if (design.timeSeries) problems.push('A time series collection cannot be capped.');
        if (!design.sizeBytes || design.sizeBytes <= 0)
            problems.push('A capped collection needs a maximum size in bytes.');
    }
    if (design.timeSeries && !design.timeSeries.timeField.trim())
        problems.push('A time series collection needs a time field.');
    if (design.timeSeries && design.clusteredIndex)
        problems.push('A time series collection cannot have a clustered index.');
    const check = (fields: FieldDesign[], path: string) => {
        const seen = new Set<string>();
        for (const field of fields) {
            const label = field.name.trim() ? `${path}${field.name.trim()}` : `${path}(unnamed)`;
            if (!field.name.trim())
                problems.push(`A field in ${path || 'the document'} has no name.`);
            else if (seen.has(field.name.trim())) problems.push(`${label} is defined twice.`);
            seen.add(field.name.trim());
            for (const keyword of validationKeywords(field.bsonType)) {
                const raw = field.rules[keyword.key];
                if (raw?.trim() && keyword.kind === 'number' && !isNumber(raw))
                    problems.push(`${label}: ${keyword.label} must be a number.`);
                if (keyword.key === 'pattern' && raw?.trim()) {
                    try {
                        new RegExp(raw);
                    } catch {
                        problems.push(`${label}: the pattern is not a valid expression.`);
                    }
                }
            }
            check(field.children, `${label}.`);
            if (field.items) check(field.items.children, `${label}[].`);
        }
    };
    check(design.fields, '');
    return problems;
};

/** The statements that create the collection (the validator travels in `createCollection`). */
export const createCollectionFromDesign = (design: CollectionDesign): string[] => {
    const root = design.database ? `db.getSiblingDB(${q(design.database)})` : 'db';
    const options: string[] = [];
    if (design.capped) {
        options.push('capped: true');
        if (design.sizeBytes) options.push(`size: ${Math.floor(design.sizeBytes)}`);
        if (design.maxDocuments) options.push(`max: ${Math.floor(design.maxDocuments)}`);
    }
    if (design.timeSeries) {
        const ts = design.timeSeries;
        const parts = [`timeField: ${q(ts.timeField.trim())}`];
        if (ts.metaField?.trim()) parts.push(`metaField: ${q(ts.metaField.trim())}`);
        if (ts.granularity) parts.push(`granularity: ${q(ts.granularity)}`);
        options.push(`timeseries: { ${parts.join(', ')} }`);
        if (ts.expireAfterSeconds !== undefined)
            options.push(`expireAfterSeconds: ${Math.floor(ts.expireAfterSeconds)}`);
    }
    if (design.collation?.locale.trim()) {
        options.push(
            `collation: { locale: ${q(design.collation.locale.trim())}${
                design.collation.strength ? `, strength: ${design.collation.strength}` : ''
            } }`,
        );
    }
    if (design.clusteredIndex)
        options.push('clusteredIndex: { key: { _id: 1 }, unique: true, name: "_id_" }');
    const validator = validatorText(design);
    if (validator) {
        options.push(`validator: ${validator}`);
        options.push(`validationLevel: ${q(design.validationLevel)}`);
        options.push(`validationAction: ${q(design.validationAction)}`);
    }
    return [
        `${root}.createCollection(${q(design.name.trim())}${
            options.length ? `, {\n  ${options.join(',\n  ')}\n}` : ''
        })`,
    ];
};

/** The statement that changes the validation of an existing collection. */
export const alterCollectionStatements = (design: CollectionDesign): string[] => {
    const root = design.database ? `db.getSiblingDB(${q(design.database)})` : 'db';
    const validator = validatorText(design) ?? '{}';
    return [
        `${root}.runCommand({ collMod: ${q(design.name.trim())}, validator: ${validator}, validationLevel: ${q(design.validationLevel)}, validationAction: ${q(design.validationAction)} })`,
    ];
};

/* ---------- Field tree operations ---------- */

/** One row of the field grid: a field, or the `items` of an array field. */
export interface FlatField {
    /** The field's id, or `<arrayFieldId>:items` for the items row. */
    id: string;
    depth: number;
    kind: 'field' | 'items';
    /** The id of the field that holds this one (absent for a top-level field). */
    parentId?: string;
    field: FieldDesign;
    /** For an items row: the array field it belongs to. */
    owner?: FieldDesign;
    /** Whether the row can have child fields added to it. */
    canNest: boolean;
}

const itemsId = (field: FieldDesign) => `${field.id}:items`;

/** The fields as grid rows, depth first: an array's items and an object's children follow it. */
export const flattenFields = (fields: readonly FieldDesign[]): FlatField[] => {
    const rows: FlatField[] = [];
    const visit = (list: readonly FieldDesign[], depth: number, parentId?: string) => {
        for (const field of list) {
            rows.push({
                id: field.id,
                depth,
                kind: 'field',
                parentId,
                field,
                canNest: field.bsonType === 'object',
            });
            if (field.bsonType === 'object') visit(field.children, depth + 1, field.id);
            if (field.bsonType === 'array' && field.items) {
                rows.push({
                    id: itemsId(field),
                    depth: depth + 1,
                    kind: 'items',
                    parentId: field.id,
                    field,
                    owner: field,
                    canNest: field.items.bsonType === 'object',
                });
                if (field.items.bsonType === 'object')
                    visit(field.items.children, depth + 2, itemsId(field));
            }
        }
    };
    visit(fields, 0);
    return rows;
};

/** Applies `change` to the list that holds the field `id` (or the items of an array `id:items`). */
const mapTree = (
    fields: readonly FieldDesign[],
    change: (
        list: FieldDesign[],
        owner: FieldDesign | null,
        items: boolean,
    ) => FieldDesign[] | null,
    owner: FieldDesign | null = null,
    items = false,
): FieldDesign[] => {
    const own = change([...fields], owner, items);
    if (own) return own;
    return fields.map((field) => ({
        ...field,
        children: mapTree(field.children, change, field, false),
        ...(field.items
            ? {
                  items: {
                      ...field.items,
                      children: mapTree(field.items.children, change, field, true),
                  },
              }
            : {}),
    }));
};

const containsId = (list: readonly FieldDesign[], id: string): boolean =>
    list.some((field) => field.id === id);

/** Changes a field wherever it sits in the tree. */
export const updateFieldIn = (
    fields: readonly FieldDesign[],
    id: string,
    patch: Partial<Omit<FieldDesign, 'id'>>,
): FieldDesign[] => {
    const apply = (field: FieldDesign): FieldDesign => {
        const next = { ...field, ...patch };
        // Leaving `object` drops the children; leaving `array` drops the items; entering array adds items.
        if (patch.bsonType && patch.bsonType !== field.bsonType) {
            if (patch.bsonType !== 'object') next.children = [];
            if (patch.bsonType !== 'array') delete next.items;
            else next.items = field.items ?? { bsonType: 'string', children: [] };
            next.rules = {};
        }
        return next;
    };
    return mapTree(fields, (list) =>
        containsId(list, id) ? list.map((field) => (field.id === id ? apply(field) : field)) : null,
    );
};

/** Changes the item type of an array field. */
export const updateItemsIn = (
    fields: readonly FieldDesign[],
    arrayId: string,
    bsonType: BsonTypeName,
): FieldDesign[] => {
    const walk = (list: readonly FieldDesign[]): FieldDesign[] =>
        list.map((field) => ({
            ...field,
            children: walk(field.children),
            ...(field.items
                ? {
                      items:
                          field.id === arrayId
                              ? {
                                    bsonType,
                                    children: bsonType === 'object' ? field.items.children : [],
                                }
                              : { ...field.items, children: walk(field.items.children) },
                  }
                : {}),
        }));
    return walk(fields);
};

/** Adds a child to an object field, or to the items of an array whose id is `<id>:items`. */
export const addChildField = (
    fields: readonly FieldDesign[],
    parentId: string | null,
    child: FieldDesign = newField(),
): FieldDesign[] => {
    if (parentId === null) return [...fields, child];
    const walk = (list: readonly FieldDesign[]): FieldDesign[] =>
        list.map((field) => {
            const withChildren =
                field.id === parentId
                    ? { ...field, children: [...field.children, child] }
                    : { ...field, children: walk(field.children) };
            if (!field.items) return withChildren;
            return {
                ...withChildren,
                items:
                    itemsId(field) === parentId
                        ? { ...field.items, children: [...field.items.children, child] }
                        : { ...field.items, children: walk(field.items.children) },
            };
        });
    return walk(fields);
};

export const removeFieldIn = (fields: readonly FieldDesign[], id: string): FieldDesign[] =>
    mapTree(fields, (list) =>
        containsId(list, id) ? list.filter((field) => field.id !== id) : null,
    );

const cloneField = (field: FieldDesign): FieldDesign => ({
    ...structuredClone(field),
    id: newFieldId(),
    children: field.children.map(cloneField),
    ...(field.items
        ? { items: { ...field.items, children: field.items.children.map(cloneField) } }
        : {}),
});

/** Inserts a copy (with new ids all the way down) right after the field. */
export const duplicateFieldIn = (fields: readonly FieldDesign[], id: string): FieldDesign[] =>
    mapTree(fields, (list) => {
        const index = list.findIndex((field) => field.id === id);
        if (index < 0) return null;
        const copy = cloneField(list[index]!);
        copy.name = copy.name ? `${copy.name}_copy` : copy.name;
        list.splice(index + 1, 0, copy);
        return list;
    });

/** Moves a field up or down among its siblings. */
export const moveFieldIn = (
    fields: readonly FieldDesign[],
    id: string,
    delta: -1 | 1,
): FieldDesign[] =>
    mapTree(fields, (list) => {
        const index = list.findIndex((field) => field.id === id);
        if (index < 0) return null;
        const to = index + delta;
        if (to < 0 || to >= list.length) return list;
        const [field] = list.splice(index, 1);
        list.splice(to, 0, field!);
        return list;
    });
