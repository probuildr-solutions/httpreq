/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ColumnInfo, ConstraintInfo, IndexInfo } from '@httpreq/db-core';

/**
 * A reusable relationship graph: tables as nodes, foreign keys as edges. It is built from what a
 * server reports (columns, indexes, constraints) and knows nothing about drawing, so the same model
 * can feed an ER diagram, a dependency list or a "tables that reference this one" panel. Layout is
 * separate and pure, so it can be tested and run for any number of tables.
 */

export interface ErInput {
    schema?: string;
    database?: string;
    name: string;
    columns: ColumnInfo[];
    indexes: IndexInfo[];
    constraints: ConstraintInfo[];
}

export interface ErColumn {
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
    foreignKey: boolean;
    unique: boolean;
}

export interface ErTable {
    id: string;
    schema?: string;
    name: string;
    columns: ErColumn[];
}

export type Cardinality = 'one-to-one' | 'one-to-many' | 'many-to-many';

export interface ErRelationship {
    id: string;
    /** The referenced (parent) table. */
    from: { table: string; columns: string[] };
    /** The table that holds the foreign key (child). */
    to: { table: string; columns: string[] };
    cardinality: Cardinality;
    /** The constraint's name, or a description for an inferred one. */
    name: string;
    /** Found by naming convention rather than declared as a foreign key. */
    inferred?: boolean;
    /** For many-to-many: the join table that links the two. */
    viaTable?: string;
    onDelete?: string;
    onUpdate?: string;
    /** Whether every row of the child must have a parent (all key columns are NOT NULL). */
    required?: boolean;
}

export interface ErModel {
    tables: ErTable[];
    relationships: ErRelationship[];
}

export const tableId = (schema: string | undefined, name: string): string =>
    schema ? `${schema}.${name}` : name;

const sameSet = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((c) => set.has(c));
};

const referenceTarget = (text: string, fallbackSchema?: string) => {
    const parts = text.replace(/[`"]/g, '').split('.');
    const name = parts.pop() ?? text;
    return { name, schema: parts.pop() ?? fallbackSchema };
};

const actionOf = (definition: string | undefined, which: 'DELETE' | 'UPDATE') =>
    new RegExp(`ON ${which} (CASCADE|RESTRICT|SET NULL|SET DEFAULT|NO ACTION)`, 'i')
        .exec(definition ?? '')?.[1]
        ?.toUpperCase();

export const buildErModel = (
    inputs: ErInput[],
    options: { inferMissing?: boolean } = {},
): ErModel => {
    const tables: ErTable[] = [];
    const byId = new Map<string, ErInput>();
    const idOfName = new Map<string, string[]>();
    for (const input of inputs) {
        const id = tableId(input.schema, input.name);
        byId.set(id, input);
        idOfName.set(input.name, [...(idOfName.get(input.name) ?? []), id]);
    }

    const uniqueKeys = (input: ErInput): string[][] => {
        const keys: string[][] = [];
        for (const index of input.indexes)
            if (index.unique || index.primary) keys.push(index.columns);
        for (const c of input.constraints)
            if (c.kind === 'PRIMARY KEY' || c.kind === 'UNIQUE') keys.push(c.columns);
        const primary = input.columns.filter((c) => c.primaryKey).map((c) => c.name);
        if (primary.length) keys.push(primary);
        return keys;
    };

    const relationships: ErRelationship[] = [];
    const foreignColumns = new Map<string, Set<string>>();

    for (const input of inputs) {
        const childId = tableId(input.schema, input.name);
        const unique = uniqueKeys(input);
        for (const constraint of input.constraints) {
            if (constraint.kind !== 'FOREIGN KEY' || !constraint.references) continue;
            const target = referenceTarget(constraint.references.table, input.schema);
            const parentId = tableId(target.schema, target.name);
            const resolvedParent = byId.has(parentId)
                ? parentId
                : (idOfName.get(target.name)?.[0] ?? parentId);
            const columns = foreignColumns.get(childId) ?? new Set<string>();
            for (const c of constraint.columns) columns.add(c);
            foreignColumns.set(childId, columns);
            const required = constraint.columns.every(
                (name) => input.columns.find((c) => c.name === name)?.nullable === false,
            );
            relationships.push({
                id: `${childId}.${constraint.name}`,
                from: { table: resolvedParent, columns: constraint.references.columns },
                to: { table: childId, columns: constraint.columns },
                cardinality: unique.some((key) => sameSet(key, constraint.columns))
                    ? 'one-to-one'
                    : 'one-to-many',
                name: constraint.name,
                onDelete: actionOf(constraint.definition, 'DELETE'),
                onUpdate: actionOf(constraint.definition, 'UPDATE'),
                required,
            });
        }
    }

    // Columns named `<table>_id` that point at a table's single-column key, where no foreign key
    // is declared (common in MySQL MyISAM schemas and in dumps without constraints).
    if (options.inferMissing) {
        for (const input of inputs) {
            const childId = tableId(input.schema, input.name);
            for (const column of input.columns) {
                const match = /^(.+?)_id$/i.exec(column.name);
                if (!match || column.primaryKey) continue;
                if (foreignColumns.get(childId)?.has(column.name)) continue;
                const stem = match[1]!.toLowerCase();
                const parent = inputs.find((p) => {
                    const name = p.name.toLowerCase();
                    return (
                        p !== input &&
                        (name === stem ||
                            name === `${stem}s` ||
                            name === `${stem}es` ||
                            `${name}` === `${stem}`)
                    );
                });
                if (!parent) continue;
                const key = parent.columns.filter((c) => c.primaryKey);
                if (key.length !== 1) continue;
                const unique = uniqueKeys(input);
                relationships.push({
                    id: `${childId}.${column.name}~inferred`,
                    from: { table: tableId(parent.schema, parent.name), columns: [key[0]!.name] },
                    to: { table: childId, columns: [column.name] },
                    cardinality: unique.some((k) => sameSet(k, [column.name]))
                        ? 'one-to-one'
                        : 'one-to-many',
                    name: `${column.name} (inferred)`,
                    inferred: true,
                });
            }
        }
    }

    for (const input of inputs) {
        const id = tableId(input.schema, input.name);
        const fks = foreignColumns.get(id) ?? new Set<string>();
        const uniqueSingles = new Set(
            uniqueKeys(input)
                .filter((k) => k.length === 1)
                .map((k) => k[0]!),
        );
        tables.push({
            id,
            schema: input.schema,
            name: input.name,
            columns: input.columns
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((c) => ({
                    name: c.name,
                    type: c.type,
                    nullable: c.nullable,
                    primaryKey: c.primaryKey,
                    foreignKey: fks.has(c.name),
                    unique: uniqueSingles.has(c.name),
                })),
        });
    }

    // A table that exists only to link two others: two foreign keys, and a key made of them.
    const declared = relationships.filter((r) => !r.inferred);
    for (const input of inputs) {
        const id = tableId(input.schema, input.name);
        const own = declared.filter((r) => r.to.table === id);
        if (own.length !== 2) continue;
        const fkColumns = new Set(own.flatMap((r) => r.to.columns));
        const keyColumns = uniqueKeys(input).find(
            (key) => key.every((c) => fkColumns.has(c)) && key.length === fkColumns.size,
        );
        const others = input.columns.filter((c) => !fkColumns.has(c.name) && !c.primaryKey);
        if (!keyColumns || others.length > 2) continue;
        const [a, b] = own as [ErRelationship, ErRelationship];
        if (a.from.table === b.from.table) continue;
        relationships.push({
            id: `${id}~m2m`,
            from: { table: a.from.table, columns: a.from.columns },
            to: { table: b.from.table, columns: b.from.columns },
            cardinality: 'many-to-many',
            name: `via ${input.name}`,
            viaTable: id,
        });
    }

    return { tables, relationships };
};

/** The relationships that touch a table, as parent (it is referenced) or child (it references). */
export const relationshipsOf = (model: ErModel, table: string) => ({
    references: model.relationships.filter(
        (r) => r.to.table === table && r.cardinality !== 'many-to-many',
    ),
    referencedBy: model.relationships.filter(
        (r) => r.from.table === table && r.cardinality !== 'many-to-many',
    ),
    manyToMany: model.relationships.filter(
        (r) => r.cardinality === 'many-to-many' && (r.from.table === table || r.to.table === table),
    ),
});

/* ---------- Layout ---------- */

export interface NodeBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export const NODE_WIDTH = 230;
export const HEADER_HEIGHT = 30;
export const ROW_HEIGHT = 20;
export const MAX_VISIBLE_COLUMNS = 14;

export const nodeSize = (table: ErTable): { width: number; height: number } => ({
    width: NODE_WIDTH,
    height:
        HEADER_HEIGHT +
        ROW_HEIGHT * Math.min(table.columns.length, MAX_VISIBLE_COLUMNS) +
        (table.columns.length > MAX_VISIBLE_COLUMNS ? ROW_HEIGHT : 0) +
        6,
});

/**
 * Lays tables out in layers: a table sits to the right of the tables it references, and within a
 * layer tables are ordered to keep related ones close. Cycles (a self reference, two tables that
 * reference each other) are broken so every table still gets a place. Linear in tables and
 * relationships times a small constant, so a few thousand tables lay out instantly.
 */
export const autoLayout = (model: ErModel, gap = { x: 90, y: 40 }): Map<string, NodeBox> => {
    const ids = model.tables.map((t) => t.id);
    const tableById = new Map(model.tables.map((t) => [t.id, t]));
    const edges = model.relationships
        .filter(
            (r) =>
                r.cardinality !== 'many-to-many' &&
                r.from.table !== r.to.table &&
                tableById.has(r.from.table) &&
                tableById.has(r.to.table),
        )
        .map((r) => [r.from.table, r.to.table] as const);

    // Rank: longest path from a root, ignoring edges that close a cycle.
    const rank = new Map<string, number>(ids.map((id) => [id, 0]));
    const children = new Map<string, string[]>();
    const parents = new Map<string, string[]>();
    for (const [parent, child] of edges) {
        children.set(parent, [...(children.get(parent) ?? []), child]);
        parents.set(child, [...(parents.get(child) ?? []), parent]);
    }
    const state = new Map<string, 0 | 1 | 2>();
    const order: string[] = [];
    const visit = (start: string) => {
        const stack: [string, number][] = [[start, 0]];
        state.set(start, 1);
        while (stack.length) {
            const frame = stack[stack.length - 1]!;
            const next = children.get(frame[0])?.[frame[1]++];
            if (next === undefined) {
                state.set(frame[0], 2);
                order.push(frame[0]);
                stack.pop();
            } else if (!state.get(next)) {
                state.set(next, 1);
                stack.push([next, 0]);
            }
        }
    };
    for (const id of ids) if (!state.get(id)) visit(id);
    const position = new Map(order.reverse().map((id, i) => [id, i]));
    for (const id of order) {
        for (const child of children.get(id) ?? []) {
            // A back edge (child sorts before its parent) is a cycle: ignore it.
            if ((position.get(child) ?? 0) > (position.get(id) ?? 0))
                rank.set(child, Math.max(rank.get(child) ?? 0, (rank.get(id) ?? 0) + 1));
        }
    }

    const layers = new Map<number, string[]>();
    for (const id of ids) layers.set(rank.get(id)!, [...(layers.get(rank.get(id)!) ?? []), id]);
    const layerKeys = [...layers.keys()].sort((a, b) => a - b);

    // Order within layers by the average position of neighbours in the previous layer.
    const slot = new Map<string, number>();
    layerKeys.forEach((key, li) => {
        const members = layers.get(key)!;
        if (li > 0) {
            members.sort((a, b) => {
                const mean = (id: string) => {
                    const near = (parents.get(id) ?? []).filter((p) => slot.has(p));
                    return near.length
                        ? near.reduce((s, p) => s + slot.get(p)!, 0) / near.length
                        : Number.MAX_SAFE_INTEGER;
                };
                return mean(a) - mean(b) || a.localeCompare(b);
            });
        } else
            members.sort(
                (a, b) =>
                    (children.get(b)?.length ?? 0) - (children.get(a)?.length ?? 0) ||
                    a.localeCompare(b),
            );
        members.forEach((id, i) => slot.set(id, i));
    });

    // Tall layers wrap into several columns so ten thousand tables do not make a one-column strip.
    const boxes = new Map<string, NodeBox>();
    let x = 0;
    const maxLayerHeight = 2400;
    for (const key of layerKeys) {
        const members = layers.get(key)!;
        let y = 0;
        let columnX = x;
        let columnWidth = 0;
        for (const id of members) {
            const size = nodeSize(tableById.get(id)!);
            if (y > 0 && y + size.height > maxLayerHeight) {
                columnX += columnWidth + gap.x / 2;
                y = 0;
                columnWidth = 0;
            }
            boxes.set(id, { x: columnX, y, ...size });
            y += size.height + gap.y;
            columnWidth = Math.max(columnWidth, size.width);
        }
        x = columnX + columnWidth + gap.x;
    }
    return boxes;
};

/** Where an edge leaves one box and enters another, as the middles of their facing sides. */
export const edgeEndpoints = (
    from: NodeBox,
    to: NodeBox,
): { x1: number; y1: number; x2: number; y2: number } => {
    const fromCenter = from.x + from.width / 2;
    const toCenter = to.x + to.width / 2;
    if (toCenter >= fromCenter)
        return {
            x1: from.x + from.width,
            y1: from.y + from.height / 2,
            x2: to.x,
            y2: to.y + to.height / 2,
        };
    return {
        x1: from.x,
        y1: from.y + from.height / 2,
        x2: to.x + to.width,
        y2: to.y + to.height / 2,
    };
};

/** The bounds of a set of boxes, for fitting the view. */
export const boundsOf = (boxes: Iterable<NodeBox>): NodeBox => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of boxes) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
