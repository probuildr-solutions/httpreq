/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/** What a statement is, judged from its first keyword. */
export const StatementKind = {
    Other: 0,
    Select: 1,
    Insert: 2,
    Update: 3,
    Delete: 4,
    Create: 5,
    Alter: 6,
    Drop: 7,
    Truncate: 8,
    Transaction: 9,
    Set: 10,
    Use: 11,
    Show: 12,
    Explain: 13,
    Call: 14,
    Grant: 15,
    With: 16,
    /** A `DELIMITER x` directive: a client command, not something to send to the server. */
    Delimiter: 17,
} as const;

export type StatementKindValue = (typeof StatementKind)[keyof typeof StatementKind];

/** Bits of an index entry's flags byte beyond the kind. */
export const KIND_MASK = 0b0001_1111;
/** The statement ended at the end of the file without its terminator. */
export const FLAG_UNTERMINATED = 0b0010_0000;
/** The file ended inside a quote, comment or dollar-quoted body. */
export const FLAG_ERROR = 0b0100_0000;

export const kindOf = (flags: number): StatementKindValue =>
    (flags & KIND_MASK) as StatementKindValue;

const KIND_NAMES: Record<number, string> = Object.fromEntries(
    Object.entries(StatementKind).map(([name, value]) => [value, name.toUpperCase()]),
);

export const kindName = (kind: number): string => KIND_NAMES[kind] ?? 'OTHER';

const BY_KEYWORD: Record<string, StatementKindValue> = {
    SELECT: StatementKind.Select,
    VALUES: StatementKind.Select,
    TABLE: StatementKind.Select,
    INSERT: StatementKind.Insert,
    REPLACE: StatementKind.Insert,
    UPDATE: StatementKind.Update,
    DELETE: StatementKind.Delete,
    CREATE: StatementKind.Create,
    ALTER: StatementKind.Alter,
    DROP: StatementKind.Drop,
    TRUNCATE: StatementKind.Truncate,
    BEGIN: StatementKind.Transaction,
    START: StatementKind.Transaction,
    COMMIT: StatementKind.Transaction,
    ROLLBACK: StatementKind.Transaction,
    SAVEPOINT: StatementKind.Transaction,
    RELEASE: StatementKind.Transaction,
    END: StatementKind.Transaction,
    SET: StatementKind.Set,
    USE: StatementKind.Use,
    SHOW: StatementKind.Show,
    EXPLAIN: StatementKind.Explain,
    DESCRIBE: StatementKind.Explain,
    DESC: StatementKind.Explain,
    CALL: StatementKind.Call,
    GRANT: StatementKind.Grant,
    REVOKE: StatementKind.Grant,
    WITH: StatementKind.With,
    DELIMITER: StatementKind.Delimiter,
};

/** Classifies an upper-case first keyword. */
export const kindFromKeyword = (keyword: string): StatementKindValue =>
    BY_KEYWORD[keyword] ?? StatementKind.Other;

/**
 * Statements that cannot change data or schema, judged by kind alone. A statement that begins a
 * `WITH` may still write, and `EXPLAIN ANALYZE` executes its statement, so neither is on the list. This is a courtesy for a read-only mode, not a
 * security boundary: the server-side read-only transaction is what actually enforces it.
 */
export const isReadOnlyKind = (kind: number): boolean =>
    kind === StatementKind.Select ||
    kind === StatementKind.Show ||
    kind === StatementKind.Use ||
    kind === StatementKind.Set;
