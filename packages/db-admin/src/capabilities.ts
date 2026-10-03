/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * What each engine can do, as data. The window asks `capabilitiesOf(engine)` which actions to
 * offer instead of comparing engine names, so a feature an engine lacks (stored procedures in
 * MongoDB, an ER diagram for Redis) is simply never offered, and a new engine needs one entry here
 * rather than a search through the UI for `if (engine === …)`.
 */
export interface DatabaseCapabilities {
    supportsSchemas: boolean;
    supportsTables: boolean;
    supportsViews: boolean;
    supportsMaterializedViews: boolean;
    supportsProcedures: boolean;
    supportsFunctions: boolean;
    supportsTriggers: boolean;
    supportsEvents: boolean;
    supportsSequences: boolean;
    supportsExtensions: boolean;
    supportsIndexes: boolean;
    supportsForeignKeys: boolean;
    supportsTransactions: boolean;
    supportsERDiagram: boolean;
    /** Rows of a table can be browsed and edited in a grid. */
    supportsTableEditor: boolean;
    /** The structure of a table can be designed visually. */
    supportsTableDesigner: boolean;
    /** Documents can be edited as JSON or a tree. */
    supportsDocumentEditor: boolean;
    /** Collections can carry validation rules. */
    supportsValidation: boolean;
    supportsImport: boolean;
    supportsExport: boolean;
    /** Formats a table or collection can be imported from and exported to. */
    importFormats: ExchangeFormat[];
    exportFormats: ExchangeFormat[];
}

export type ExchangeFormat = 'sql' | 'csv' | 'json' | 'ndjson' | 'bson';

const NONE: DatabaseCapabilities = {
    supportsSchemas: false,
    supportsTables: false,
    supportsViews: false,
    supportsMaterializedViews: false,
    supportsProcedures: false,
    supportsFunctions: false,
    supportsTriggers: false,
    supportsEvents: false,
    supportsSequences: false,
    supportsExtensions: false,
    supportsIndexes: false,
    supportsForeignKeys: false,
    supportsTransactions: false,
    supportsERDiagram: false,
    supportsTableEditor: false,
    supportsTableDesigner: false,
    supportsDocumentEditor: false,
    supportsValidation: false,
    supportsImport: false,
    supportsExport: false,
    importFormats: [],
    exportFormats: [],
};

const RELATIONAL: DatabaseCapabilities = {
    ...NONE,
    supportsTables: true,
    supportsViews: true,
    supportsProcedures: true,
    supportsFunctions: true,
    supportsTriggers: true,
    supportsIndexes: true,
    supportsForeignKeys: true,
    supportsTransactions: true,
    supportsERDiagram: true,
    supportsTableEditor: true,
    supportsTableDesigner: true,
    supportsImport: true,
    supportsExport: true,
    importFormats: ['sql', 'csv', 'json', 'ndjson'],
    exportFormats: ['sql', 'csv', 'json', 'ndjson'],
};

const CAPABILITIES: Record<string, DatabaseCapabilities> = {
    mysql: { ...RELATIONAL, supportsEvents: true },
    postgresql: {
        ...RELATIONAL,
        supportsSchemas: true,
        supportsMaterializedViews: true,
        supportsSequences: true,
        supportsExtensions: true,
    },
    mongodb: {
        ...NONE,
        supportsTables: true, // collections
        supportsViews: true,
        supportsIndexes: true,
        supportsTransactions: true,
        supportsDocumentEditor: true,
        supportsValidation: true,
        supportsImport: true,
        supportsExport: true,
        importFormats: ['json', 'ndjson', 'bson'],
        exportFormats: ['json', 'ndjson', 'bson'],
    },
    redis: {
        ...NONE,
        supportsTransactions: true,
        supportsExport: true,
        exportFormats: ['json', 'ndjson'],
    },
};

/** The capabilities of an engine; an unknown engine can do nothing beyond running statements. */
export const capabilitiesOf = (engine: string): DatabaseCapabilities =>
    CAPABILITIES[engine] ?? NONE;

/** Whether the engine speaks SQL (and so has SQL dialect services). */
export const isSqlEngine = (engine: string): engine is 'mysql' | 'postgresql' =>
    engine === 'mysql' || engine === 'postgresql';
