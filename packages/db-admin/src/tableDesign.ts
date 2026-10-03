/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ColumnInfo, ConstraintInfo, IndexInfo } from '@httpreq/db-core';
import type { ObjectName, SqlDialect } from './dialect';

/**
 * The visual table designer's model and the statements it produces. The designer edits a
 * `TableDesign`; this module turns a new design into `CREATE TABLE`, and the difference between
 * two designs into `ALTER TABLE` statements, which the user reads in a preview before anything
 * runs. Nothing here talks to a server.
 */

export interface ColumnDesign {
    /** Stable across renames, so the diff can tell a rename from a drop and an add. */
    id: string;
    name: string;
    /** The type name without its length: `varchar`, `numeric`. */
    type: string;
    /** `255`, or `10,2` for a precision and scale. */
    length?: string;
    unsigned?: boolean;
    nullable: boolean;
    /** A raw SQL expression: `0`, `'new'`, `CURRENT_TIMESTAMP`. */
    default?: string;
    autoIncrement?: boolean;
    generated?: { expression: string; stored: boolean };
    comment?: string;
}

export interface KeyDesign {
    name?: string;
    columns: string[];
}

export type ReferentialAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export interface ForeignKeyDesign {
    name?: string;
    columns: string[];
    refSchema?: string;
    refTable: string;
    refColumns: string[];
    onDelete?: ReferentialAction;
    onUpdate?: ReferentialAction;
}

export interface CheckDesign {
    name?: string;
    expression: string;
}

export interface IndexColumnDesign {
    name: string;
    order?: 'ASC' | 'DESC';
}

export interface IndexDesign {
    name: string;
    columns: IndexColumnDesign[];
    unique: boolean;
    /** `BTREE`, `HASH`, `GIN`… */
    method?: string;
    /** PostgreSQL partial index predicate. */
    where?: string;
}

export interface TableDesign {
    schema?: string;
    database?: string;
    name: string;
    columns: ColumnDesign[];
    primaryKey: string[];
    primaryKeyName?: string;
    foreignKeys: ForeignKeyDesign[];
    uniques: KeyDesign[];
    checks: CheckDesign[];
    indexes: IndexDesign[];
    comment?: string;
}

export const emptyDesign = (name = ''): TableDesign => ({
    name,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    checks: [],
    indexes: [],
});

let counter = 0;
export const newColumnId = (): string => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

/* ---------- Names ---------- */

const nameOf = (design: TableDesign): ObjectName => ({
    schema: design.schema,
    database: design.database,
    name: design.name,
});

const slug = (text: string) => text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const autoName = (prefix: string, table: string, columns: string[]) =>
    `${prefix}_${slug(table)}_${columns.map(slug).join('_')}`.slice(0, 60);

export const foreignKeyName = (design: TableDesign, key: ForeignKeyDesign): string =>
    key.name || autoName('fk', design.name, key.columns);
export const uniqueName = (design: TableDesign, key: KeyDesign): string =>
    key.name || autoName('uq', design.name, key.columns);
export const checkName = (design: TableDesign, check: CheckDesign, index: number): string =>
    check.name || `ck_${slug(design.name)}_${index + 1}`;

/* ---------- Pieces ---------- */

const typeSql = (dialect: SqlDialect, column: ColumnDesign): string => {
    const base = column.type.trim();
    // PostgreSQL puts the digits before the zone: `timestamp(3) with time zone`.
    const zoned = /^(time|timestamp)\s+(with(?:out)?\s+time\s+zone)$/i.exec(base);
    const withLength =
        column.length && dialect.lengthTypes.has(base.toLowerCase())
            ? zoned
                ? `${zoned[1]}(${column.length}) ${zoned[2]}`
                : `${base}(${column.length})`
            : base;
    return dialect.id === 'mysql' && column.unsigned ? `${withLength} UNSIGNED` : withLength;
};

const columnDefinition = (dialect: SqlDialect, column: ColumnDesign): string => {
    const parts = [dialect.quote(column.name), typeSql(dialect, column)];
    if (column.generated) {
        parts.push(
            `GENERATED ALWAYS AS (${column.generated.expression}) ${
                dialect.id === 'postgresql' || column.generated.stored ? 'STORED' : 'VIRTUAL'
            }`,
        );
        if (!column.nullable) parts.push('NOT NULL');
    } else {
        const serial = /serial/i.test(column.type);
        if (dialect.id === 'postgresql' && column.autoIncrement && !serial)
            parts.push(dialect.autoIncrementClause(column.type));
        parts.push(column.nullable && !column.autoIncrement ? 'NULL' : 'NOT NULL');
        if (column.default !== undefined && column.default !== '' && !column.autoIncrement)
            parts.push(`DEFAULT ${column.default}`);
        if (dialect.id === 'mysql' && column.autoIncrement)
            parts.push(dialect.autoIncrementClause(column.type));
    }
    if (dialect.id === 'mysql' && column.comment)
        parts.push(`COMMENT ${dialect.literal({ kind: 'text', value: column.comment })}`);
    return parts.join(' ');
};

const columnList = (dialect: SqlDialect, columns: string[]) =>
    columns.map((column) => dialect.quote(column)).join(', ');

const foreignKeyClause = (dialect: SqlDialect, design: TableDesign, key: ForeignKeyDesign) => {
    const target = dialect.qualify({
        schema: key.refSchema ?? design.schema,
        database: key.refSchema ?? design.database,
        name: key.refTable,
    });
    return (
        `CONSTRAINT ${dialect.quote(foreignKeyName(design, key))} FOREIGN KEY (${columnList(dialect, key.columns)}) ` +
        `REFERENCES ${target} (${columnList(dialect, key.refColumns)})` +
        (key.onDelete && key.onDelete !== 'NO ACTION' ? ` ON DELETE ${key.onDelete}` : '') +
        (key.onUpdate && key.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${key.onUpdate}` : '')
    );
};

const uniqueClause = (dialect: SqlDialect, design: TableDesign, key: KeyDesign) =>
    `CONSTRAINT ${dialect.quote(uniqueName(design, key))} UNIQUE (${columnList(dialect, key.columns)})`;

const checkClause = (dialect: SqlDialect, design: TableDesign, check: CheckDesign, index: number) =>
    `CONSTRAINT ${dialect.quote(checkName(design, check, index))} CHECK (${check.expression})`;

const primaryKeyClause = (dialect: SqlDialect, design: TableDesign) =>
    `${design.primaryKeyName ? `CONSTRAINT ${dialect.quote(design.primaryKeyName)} ` : ''}PRIMARY KEY (${columnList(dialect, design.primaryKey)})`;

const indexColumns = (dialect: SqlDialect, index: IndexDesign) =>
    index.columns
        .map((column) => `${dialect.quote(column.name)}${column.order === 'DESC' ? ' DESC' : ''}`)
        .join(', ');

export const createIndexSql = (
    dialect: SqlDialect,
    table: ObjectName,
    index: IndexDesign,
    options: { concurrently?: boolean; ifNotExists?: boolean } = {},
): string => {
    const method = index.method?.trim();
    if (dialect.id === 'postgresql') {
        return (
            `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX${options.concurrently ? ' CONCURRENTLY' : ''}` +
            `${options.ifNotExists ? ' IF NOT EXISTS' : ''} ${dialect.quote(index.name)} ON ${dialect.qualify(table)}` +
            `${method ? ` USING ${method}` : ''} (${indexColumns(dialect, index)})` +
            `${index.where ? ` WHERE ${index.where}` : ''}`
        );
    }
    return (
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${dialect.quote(index.name)} ON ${dialect.qualify(table)} ` +
        `(${indexColumns(dialect, index)})${method ? ` USING ${method}` : ''}`
    );
};

export const dropIndexSql = (
    dialect: SqlDialect,
    table: ObjectName,
    indexName: string,
    ifExists = false,
): string =>
    dialect.id === 'postgresql'
        ? `DROP INDEX ${ifExists ? 'IF EXISTS ' : ''}${dialect.qualify({ schema: table.schema, name: indexName })}`
        : `DROP INDEX ${dialect.quote(indexName)} ON ${dialect.qualify(table)}`;

/* ---------- Validation ---------- */

/** Problems that would make the generated statements wrong; shown next to the designer. */
export const validateDesign = (dialect: SqlDialect, design: TableDesign): string[] => {
    const problems: string[] = [];
    if (!design.name.trim()) problems.push('The table needs a name.');
    if (design.columns.length === 0) problems.push('The table needs at least one column.');
    const seen = new Set<string>();
    for (const column of design.columns) {
        if (!column.name.trim()) problems.push('A column has no name.');
        else if (seen.has(column.name.toLowerCase()))
            problems.push(`The column name “${column.name}” is used twice.`);
        seen.add(column.name.toLowerCase());
        if (!column.type.trim()) problems.push(`Column “${column.name}” has no type.`);
        if (
            column.length &&
            !/^\d+(\s*,\s*\d+)?$/.test(column.length) &&
            !/^(enum|set)$/i.test(column.type)
        )
            problems.push(
                `The length of “${column.name}” must be a number, or precision and scale such as 10,2.`,
            );
        if (
            column.autoIncrement &&
            dialect.id === 'mysql' &&
            !design.primaryKey.includes(column.name)
        )
            problems.push(`MySQL needs the auto increment column “${column.name}” to be a key.`);
    }
    const known = new Set(design.columns.map((c) => c.name));
    const exists = (columns: string[], what: string) => {
        for (const column of columns)
            if (!known.has(column)) problems.push(`${what} uses the unknown column “${column}”.`);
        if (columns.length === 0) problems.push(`${what} has no columns.`);
    };
    if (design.primaryKey.length > 0) exists(design.primaryKey, 'The primary key');
    for (const key of design.foreignKeys) {
        exists(key.columns, 'A foreign key');
        if (!key.refTable) problems.push('A foreign key has no referenced table.');
        if (key.refColumns.length !== key.columns.length)
            problems.push('A foreign key must reference as many columns as it has.');
    }
    for (const key of design.uniques) exists(key.columns, 'A unique constraint');
    for (const index of design.indexes) {
        if (!index.name.trim()) problems.push('An index has no name.');
        exists(
            index.columns.map((c) => c.name),
            `Index “${index.name}”`,
        );
    }
    for (const check of design.checks)
        if (!check.expression.trim()) problems.push('A check constraint has no expression.');
    return problems;
};

/* ---------- Create, drop, rename ---------- */

export const createTableSql = (dialect: SqlDialect, design: TableDesign): string[] => {
    const lines = design.columns.map((column) => `    ${columnDefinition(dialect, column)}`);
    if (design.primaryKey.length > 0) lines.push(`    ${primaryKeyClause(dialect, design)}`);
    for (const key of design.uniques) lines.push(`    ${uniqueClause(dialect, design, key)}`);
    design.checks.forEach((check, index) =>
        lines.push(`    ${checkClause(dialect, design, check, index)}`),
    );
    for (const key of design.foreignKeys)
        lines.push(`    ${foreignKeyClause(dialect, design, key)}`);
    let statement = `CREATE TABLE ${dialect.qualify(nameOf(design))} (\n${lines.join(',\n')}\n)`;
    if (dialect.id === 'mysql' && design.comment)
        statement += ` COMMENT=${dialect.literal({ kind: 'text', value: design.comment })}`;
    const statements = [statement];
    for (const index of design.indexes)
        statements.push(createIndexSql(dialect, nameOf(design), index));
    if (dialect.id === 'postgresql') {
        if (design.comment)
            statements.push(
                `COMMENT ON TABLE ${dialect.qualify(nameOf(design))} IS ${dialect.literal({ kind: 'text', value: design.comment })}`,
            );
        for (const column of design.columns)
            if (column.comment)
                statements.push(
                    `COMMENT ON COLUMN ${dialect.qualify(nameOf(design))}.${dialect.quote(column.name)} IS ${dialect.literal({ kind: 'text', value: column.comment })}`,
                );
    }
    return statements.map((s) => `${s};`);
};

export const dropTableSql = (
    dialect: SqlDialect,
    table: ObjectName,
    options: { ifExists?: boolean; cascade?: boolean } = {},
): string =>
    `DROP TABLE ${options.ifExists ? 'IF EXISTS ' : ''}${dialect.qualify(table)}${
        options.cascade && dialect.id === 'postgresql' ? ' CASCADE' : ''
    };`;

export const renameTableSql = (dialect: SqlDialect, from: ObjectName, to: string): string =>
    dialect.id === 'mysql'
        ? `RENAME TABLE ${dialect.qualify(from)} TO ${dialect.qualify({ ...from, name: to })};`
        : `ALTER TABLE ${dialect.qualify(from)} RENAME TO ${dialect.quote(to)};`;

export const truncateTableSql = (dialect: SqlDialect, table: ObjectName): string =>
    `TRUNCATE TABLE ${dialect.qualify(table)};`;

/* ---------- Alter ---------- */

const sameColumn = (a: ColumnDesign, b: ColumnDesign) =>
    a.type.toLowerCase() === b.type.toLowerCase() &&
    (a.length ?? '') === (b.length ?? '') &&
    !!a.unsigned === !!b.unsigned &&
    a.nullable === b.nullable &&
    (a.default ?? '') === (b.default ?? '') &&
    !!a.autoIncrement === !!b.autoIncrement &&
    (a.generated?.expression ?? '') === (b.generated?.expression ?? '') &&
    !!a.generated?.stored === !!b.generated?.stored &&
    (a.comment ?? '') === (b.comment ?? '');

const sameList = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

const sameForeignKey = (a: ForeignKeyDesign, b: ForeignKeyDesign) =>
    sameList(a.columns, b.columns) &&
    a.refTable === b.refTable &&
    (a.refSchema ?? '') === (b.refSchema ?? '') &&
    sameList(a.refColumns, b.refColumns) &&
    (a.onDelete ?? 'NO ACTION') === (b.onDelete ?? 'NO ACTION') &&
    (a.onUpdate ?? 'NO ACTION') === (b.onUpdate ?? 'NO ACTION');

const sameIndex = (a: IndexDesign, b: IndexDesign) =>
    a.unique === b.unique &&
    (a.method ?? '').toUpperCase() === (b.method ?? '').toUpperCase() &&
    (a.where ?? '') === (b.where ?? '') &&
    a.columns.length === b.columns.length &&
    a.columns.every(
        (c, i) =>
            c.name === b.columns[i]!.name && (c.order ?? 'ASC') === (b.columns[i]!.order ?? 'ASC'),
    );

/**
 * The statements that turn `before` into `after`. Columns are matched by `id`, so renaming a
 * column renames it (keeping its data) instead of dropping one and adding another. Constraints
 * and indexes that changed are dropped and added again; dependents are dropped first and added
 * last, so the order is valid for the server.
 */
export const alterTableSql = (
    dialect: SqlDialect,
    before: TableDesign,
    after: TableDesign,
): string[] => {
    const table = dialect.qualify(nameOf(before));
    const alter = (clause: string) => `ALTER TABLE ${table} ${clause};`;
    const drops: string[] = [];
    const columnChanges: string[] = [];
    const adds: string[] = [];
    const post: string[] = [];

    const afterNames = new Map(after.columns.map((c) => [c.id, c]));
    const beforeNames = new Map(before.columns.map((c) => [c.id, c]));
    const renamed = new Map<string, string>(); // old name -> new name
    for (const column of after.columns) {
        const old = beforeNames.get(column.id);
        if (old && old.name !== column.name) renamed.set(old.name, column.name);
    }
    /** A name from `before`, as it is after the column renames. */
    const current = (name: string) => renamed.get(name) ?? name;

    // Foreign keys, uniques, checks and indexes that are gone or changed come off first.
    const beforeFks = before.foreignKeys.map((k) => ({ ...k, name: foreignKeyName(before, k) }));
    const afterFks = after.foreignKeys.map((k) => ({ ...k, name: foreignKeyName(after, k) }));
    for (const key of beforeFks) {
        const kept = afterFks.find((k) => k.name === key.name);
        const unchanged =
            kept && sameForeignKey({ ...key, columns: key.columns.map(current) }, kept);
        if (!unchanged)
            drops.push(
                alter(
                    dialect.id === 'mysql'
                        ? `DROP FOREIGN KEY ${dialect.quote(key.name)}`
                        : `DROP CONSTRAINT ${dialect.quote(key.name)}`,
                ),
            );
    }
    const beforeUniques = before.uniques.map((k) => ({ ...k, name: uniqueName(before, k) }));
    const afterUniques = after.uniques.map((k) => ({ ...k, name: uniqueName(after, k) }));
    for (const key of beforeUniques) {
        const kept = afterUniques.find((k) => k.name === key.name);
        if (!kept || !sameList(key.columns.map(current), kept.columns))
            drops.push(
                alter(
                    dialect.id === 'mysql'
                        ? `DROP INDEX ${dialect.quote(key.name)}`
                        : `DROP CONSTRAINT ${dialect.quote(key.name)}`,
                ),
            );
    }
    const beforeChecks = before.checks.map((c, i) => ({ ...c, name: checkName(before, c, i) }));
    const afterChecks = after.checks.map((c, i) => ({ ...c, name: checkName(after, c, i) }));
    for (const check of beforeChecks) {
        const kept = afterChecks.find((c) => c.name === check.name);
        if (!kept || kept.expression !== check.expression)
            drops.push(
                alter(
                    dialect.id === 'mysql'
                        ? `DROP CHECK ${dialect.quote(check.name)}`
                        : `DROP CONSTRAINT ${dialect.quote(check.name)}`,
                ),
            );
    }
    for (const index of before.indexes) {
        const kept = after.indexes.find((i) => i.name === index.name);
        const moved = {
            ...index,
            columns: index.columns.map((c) => ({ ...c, name: current(c.name) })),
        };
        if (!kept || !sameIndex(moved, kept))
            drops.push(`${dropIndexSql(dialect, nameOf(before), index.name)};`);
    }
    if (
        before.primaryKey.length > 0 &&
        !sameList(before.primaryKey.map(current), after.primaryKey)
    ) {
        drops.push(
            alter(
                dialect.id === 'mysql'
                    ? 'DROP PRIMARY KEY'
                    : `DROP CONSTRAINT ${dialect.quote(before.primaryKeyName || `${before.name}_pkey`)}`,
            ),
        );
    }

    // Columns.
    for (const old of before.columns) {
        if (!afterNames.has(old.id))
            columnChanges.push(alter(`DROP COLUMN ${dialect.quote(old.name)}`));
    }
    for (const column of after.columns) {
        const old = beforeNames.get(column.id);
        if (!old) {
            adds.push(alter(`ADD COLUMN ${columnDefinition(dialect, column)}`));
            continue;
        }
        const renamedHere = old.name !== column.name;
        const changed = !sameColumn(old, column);
        if (!renamedHere && !changed) continue;
        if (dialect.id === 'mysql') {
            columnChanges.push(
                alter(
                    renamedHere
                        ? `CHANGE COLUMN ${dialect.quote(old.name)} ${columnDefinition(dialect, column)}`
                        : `MODIFY COLUMN ${columnDefinition(dialect, column)}`,
                ),
            );
            continue;
        }
        // PostgreSQL changes one property at a time.
        const quoted = dialect.quote(column.name);
        if (renamedHere)
            columnChanges.push(alter(`RENAME COLUMN ${dialect.quote(old.name)} TO ${quoted}`));
        if (
            old.type.toLowerCase() !== column.type.toLowerCase() ||
            (old.length ?? '') !== (column.length ?? '')
        ) {
            const target = typeSql(dialect, column);
            columnChanges.push(
                alter(`ALTER COLUMN ${quoted} TYPE ${target} USING ${quoted}::${target}`),
            );
        }
        if (old.nullable !== column.nullable)
            columnChanges.push(
                alter(`ALTER COLUMN ${quoted} ${column.nullable ? 'DROP' : 'SET'} NOT NULL`),
            );
        if ((old.default ?? '') !== (column.default ?? '')) {
            columnChanges.push(
                alter(
                    column.default
                        ? `ALTER COLUMN ${quoted} SET DEFAULT ${column.default}`
                        : `ALTER COLUMN ${quoted} DROP DEFAULT`,
                ),
            );
        }
        if (!!old.autoIncrement !== !!column.autoIncrement)
            columnChanges.push(
                alter(
                    column.autoIncrement
                        ? `ALTER COLUMN ${quoted} ADD ${dialect.autoIncrementClause(column.type)}`
                        : `ALTER COLUMN ${quoted} DROP IDENTITY IF EXISTS`,
                ),
            );
        if ((old.comment ?? '') !== (column.comment ?? ''))
            post.push(
                `COMMENT ON COLUMN ${table}.${quoted} IS ${column.comment ? dialect.literal({ kind: 'text', value: column.comment }) : 'NULL'};`,
            );
    }

    // What was dropped above comes back, and what is new is added, after the columns exist.
    const tail: string[] = [];
    if (after.primaryKey.length > 0 && !sameList(before.primaryKey.map(current), after.primaryKey))
        tail.push(alter(`ADD ${primaryKeyClause(dialect, after)}`));
    for (const key of afterUniques) {
        const old = beforeUniques.find((k) => k.name === key.name);
        if (!old || !sameList(old.columns.map(current), key.columns))
            tail.push(alter(`ADD ${uniqueClause(dialect, after, key)}`));
    }
    afterChecks.forEach((check, index) => {
        const old = beforeChecks.find((c) => c.name === check.name);
        if (!old || old.expression !== check.expression)
            tail.push(alter(`ADD ${checkClause(dialect, after, check, index)}`));
    });
    for (const key of afterFks) {
        const old = beforeFks.find((k) => k.name === key.name);
        if (!old || !sameForeignKey({ ...old, columns: old.columns.map(current) }, key))
            tail.push(alter(`ADD ${foreignKeyClause(dialect, after, key)}`));
    }
    for (const index of after.indexes) {
        const old = before.indexes.find((i) => i.name === index.name);
        const moved = old && {
            ...old,
            columns: old.columns.map((c) => ({ ...c, name: current(c.name) })),
        };
        if (!moved || !sameIndex(moved, index))
            tail.push(`${createIndexSql(dialect, nameOf(after), index)};`);
    }

    const statements = [...drops, ...columnChanges, ...adds, ...tail, ...post];
    if (before.comment !== after.comment && (before.comment ?? '') !== (after.comment ?? '')) {
        statements.push(
            dialect.id === 'mysql'
                ? alter(`COMMENT=${dialect.literal({ kind: 'text', value: after.comment ?? '' })}`)
                : `COMMENT ON TABLE ${table} IS ${after.comment ? dialect.literal({ kind: 'text', value: after.comment }) : 'NULL'};`,
        );
    }
    if (before.name !== after.name)
        statements.push(renameTableSql(dialect, nameOf(before), after.name));
    return statements;
};

/* ---------- From what a server reports ---------- */

/** Splits `varchar(255)` / `decimal(10,2) unsigned` / `numeric(10,2)` into the designer's fields. */
export const splitType = (
    display: string,
): { type: string; length?: string; unsigned?: boolean } => {
    const match =
        /^\s*([A-Za-z][A-Za-z0-9 ]*?)\s*(?:\(([^)]*)\))?\s*(unsigned)?\s*(zerofill)?\s*(\[\])?\s*$/i.exec(
            display,
        );
    if (!match) return { type: display.trim() };
    const array = match[5] ? '[]' : '';
    return {
        type: `${match[1]!.trim().toLowerCase()}${array}`,
        ...(match[2] ? { length: match[2].replace(/\s+/g, '') } : {}),
        ...(match[3] ? { unsigned: true } : {}),
    };
};

export interface TableMetadata {
    /** Needed to read a column's default the way that engine reports it. */
    dialect?: 'mysql' | 'postgresql';
    schema?: string;
    database?: string;
    name: string;
    columns: ColumnInfo[];
    indexes: IndexInfo[];
    constraints: ConstraintInfo[];
    comment?: string;
}

const referenceOf = (text: string) => {
    // `schema.table` or `table`, possibly quoted
    const parts = text.replace(/[`"]/g, '').split('.');
    return { refTable: parts.pop() ?? text, refSchema: parts.pop() };
};

/**
 * A column default as SQL. PostgreSQL reports an expression (`'none'::text`, `nextval(...)`) that is
 * valid as it stands. MySQL reports the value: `none` for a string default, `0.00`, or
 * `CURRENT_TIMESTAMP`, so a string has to be quoted again and numbers, keywords and functions left.
 */
const defaultExpression = (value: string, dialect?: 'mysql' | 'postgresql'): string => {
    if (dialect !== 'mysql') return value;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return value;
    if (/^'.*'$/s.test(value) || /^\(.*\)$/s.test(value)) return value;
    if (/^(?:null|true|false)$/i.test(value)) return value;
    if (/^[A-Za-z_]+\(.*\)$/s.test(value) || /^current_(?:timestamp|date|time)\b/i.test(value))
        return value;
    return `'${value.replace(/'/g, "''")}'`;
};

/** Builds the designer's model of an existing table from what the server reported about it. */
export const designFromMetadata = (meta: TableMetadata): TableDesign => {
    const design = emptyDesign(meta.name);
    design.schema = meta.schema;
    design.database = meta.database;
    design.comment = meta.comment;
    design.columns = meta.columns
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((column): ColumnDesign => {
            const type = splitType(column.type);
            return {
                id: `existing:${column.name}`,
                name: column.name,
                type: type.type,
                ...(type.length ? { length: type.length } : {}),
                ...(type.unsigned ? { unsigned: true } : {}),
                nullable: column.nullable,
                ...(column.default !== undefined && column.default !== null && column.default !== ''
                    ? { default: defaultExpression(column.default, meta.dialect) }
                    : {}),
                ...(column.autoIncrement ? { autoIncrement: true } : {}),
                ...(column.comment ? { comment: column.comment } : {}),
            };
        });
    const primary = meta.constraints.find((c) => c.kind === 'PRIMARY KEY');
    design.primaryKey = primary
        ? primary.columns
        : meta.columns.filter((c) => c.primaryKey).map((c) => c.name);
    if (primary && primary.name !== 'PRIMARY') design.primaryKeyName = primary.name;
    for (const constraint of meta.constraints) {
        if (constraint.kind === 'FOREIGN KEY' && constraint.references) {
            const target = referenceOf(constraint.references.table);
            design.foreignKeys.push({
                name: constraint.name,
                columns: constraint.columns,
                refTable: target.refTable,
                ...(target.refSchema ? { refSchema: target.refSchema } : {}),
                refColumns: constraint.references.columns,
                ...parseActions(constraint.definition),
            });
        } else if (constraint.kind === 'UNIQUE') {
            design.uniques.push({ name: constraint.name, columns: constraint.columns });
        } else if (constraint.kind === 'CHECK' && constraint.definition) {
            design.checks.push({
                name: constraint.name,
                expression: constraint.definition.replace(/^CHECK\s*\((.*)\)$/is, '$1'),
            });
        }
    }
    const uniqueNames = new Set(design.uniques.map((u) => u.name));
    for (const index of meta.indexes) {
        if (index.primary || uniqueNames.has(index.name)) continue;
        // MySQL builds an index for a foreign key (named after it) when none exists. It belongs to
        // the key, cannot be dropped while the key exists, and is not the person's design.
        const supportsKey = design.foreignKeys.some(
            (key) =>
                key.name === index.name &&
                key.columns.length === index.columns.length &&
                key.columns.every((column, i) => column === index.columns[i]),
        );
        if (supportsKey && !index.unique) continue;
        design.indexes.push({
            name: index.name,
            columns: index.columns.map((name) => ({ name })),
            unique: index.unique,
            ...(index.method ? { method: index.method } : {}),
        });
    }
    return design;
};

const parseActions = (definition?: string): Partial<ForeignKeyDesign> => {
    if (!definition) return {};
    const result: Partial<ForeignKeyDesign> = {};
    const del = /ON DELETE (CASCADE|RESTRICT|SET NULL|SET DEFAULT|NO ACTION)/i.exec(definition);
    const upd = /ON UPDATE (CASCADE|RESTRICT|SET NULL|SET DEFAULT|NO ACTION)/i.exec(definition);
    if (del) result.onDelete = del[1]!.toUpperCase() as ReferentialAction;
    if (upd) result.onUpdate = upd[1]!.toUpperCase() as ReferentialAction;
    return result;
};
