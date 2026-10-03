/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useMemo } from 'react';
import {
    alterViewSql,
    capabilitiesOf,
    createViewTemplate,
    dialectOf,
    dropCollectionStatement,
    dropRoutineSql,
    dropTableSql,
    dropTriggerSql,
    dropViewSql,
    eventFromDefinition,
    functionBodyFromDefinition,
    parametersFromDefinition,
    renameCollectionStatement,
    renameTableSql,
    routineFromDefinition,
    triggerFromDefinition,
    triggerFunctionName,
    truncateTableSql,
    viewQueryFromDefinition,
    type DatabaseCapabilities,
    type ObjectName,
} from '@httpreq/db-admin';
import { notifications } from '../../kit';
import { openAdminTab, type AdminKind } from '../admin/adminStore';
import {
    newCollectionModel,
    newEventModel,
    newParameter,
    newRoutineModel,
    newTriggerModel,
    routineModelFrom,
    type EventModel,
    type TriggerModel,
} from '../admin/forms/models';
import { seedEditorState } from '../admin/forms/useAdminTabState';
import { openAdminDialog } from '../admin/dialogStore';
import type { ExplorerRow } from './explorerRows';
import { useProfiles } from './profiles';
import { useDbManager } from './useDbManager';

/**
 * What the explorer's context menus do, once, in terms of the shared admin tools. A menu asks
 * `capabilitiesOf(engine)` which items to show; choosing one opens the right tab or dialog. The
 * statements an item produces come from `@httpreq/db-admin`'s dialects, so this file never writes a
 * line of SQL itself and never tests an engine's name beyond picking a dialect.
 */
export interface ExplorerActions {
    capabilities: (row: ExplorerRow) => DatabaseCapabilities;
    openData: (row: ExplorerRow) => void;
    design: (row: ExplorerRow) => void;
    newTable: (row: ExplorerRow) => void;
    relationships: (row: ExplorerRow) => void;
    indexes: (row: ExplorerRow) => void;
    triggers: (row: ExplorerRow) => void;
    newObject: (
        row: ExplorerRow,
        kind: 'view' | 'function' | 'procedure' | 'trigger' | 'event' | 'collection',
    ) => void;
    editDefinition: (row: ExplorerRow) => Promise<void>;
    runRoutine: (row: ExplorerRow) => void;
    drop: (row: ExplorerRow) => Promise<void>;
    truncate: (row: ExplorerRow) => void;
    rename: (row: ExplorerRow) => void;
    editValidation: (row: ExplorerRow) => Promise<void>;
    exportData: (row: ExplorerRow) => void;
    importData: (row: ExplorerRow) => void;
}

const nameOf = (row: ExplorerRow, name: string): ObjectName => ({
    database: row.engine === 'mysql' ? row.database : undefined,
    schema: row.engine === 'postgresql' ? row.schema : undefined,
    name,
});

export function useExplorerActions(): ExplorerActions {
    const manager = useDbManager();
    const profiles = useProfiles((state) => state.profiles);
    return useMemo(() => {
        const { newQuery } = manager;
        const engineOf = (row: ExplorerRow) =>
            profiles.find((p) => p.id === row.profileId)?.settings.engine ?? row.engine;

        const open = (
            kind: 'table' | 'design' | 'er' | 'documents' | 'indexes' | 'triggers',
            row: ExplorerRow,
            title: string,
            name?: string,
        ) =>
            openAdminTab({
                kind,
                title,
                profileId: row.profileId,
                database: row.database,
                schema: row.schema,
                name,
            });

        const confirmStatements = (
            row: ExplorerRow,
            title: string,
            statements: string[],
            options: { description?: string; confirmLabel?: string; danger?: boolean } = {},
        ) =>
            openAdminDialog({
                kind: 'statements',
                title,
                statements,
                profileId: row.profileId,
                ...options,
            });

        const definitionOf = (row: ExplorerRow) => manager.definition(row);

        /** Opens a form editor tab. A new object always gets its own tab. */
        const openEditor = (
            kind: AdminKind,
            row: ExplorerRow,
            title: string,
            options: { name?: string; seed: Record<string, unknown> },
        ) =>
            openAdminTab(
                {
                    kind,
                    title,
                    profileId: row.profileId,
                    database: row.database,
                    schema: row.schema,
                    name: options.name,
                    state: options.seed,
                },
                { fresh: !options.name || title.startsWith('New') },
            );

        /** Opens an existing routine, trigger or event in its form; false when it cannot be read. */
        const editInForm = async (
            row: ExplorerRow,
            engine: string,
            definition: string,
        ): Promise<boolean> => {
            if (engine !== 'mysql' && engine !== 'postgresql') return false;
            const dialect = dialectOf(engine);
            const label = row.object ?? row.label;
            const name = nameOf(row, label);
            if (row.kind === 'routine') {
                const kind = row.routineKind === 'procedure' ? 'procedure' : 'function';
                const design = routineFromDefinition(dialect, definition, name, kind);
                if (!design) return false;
                const model = routineModelFrom(design);
                // A parameter with no name in the definition still needs one to be edited.
                model.parameters = model.parameters.map((p, i) => ({
                    ...(p.name ? p : { ...newParameter(), ...p, name: `arg${i + 1}` }),
                }));
                openEditor(`${kind}-editor`, row, `${label} (${kind})`, {
                    name: label,
                    seed: seedEditorState('routine', model),
                });
                return true;
            }
            if (row.kind === 'trigger') {
                const table = row.table ?? '';
                let body: string | undefined;
                if (engine === 'postgresql') {
                    // The body is that of the function the trigger runs.
                    const fn = triggerFunctionName(definition);
                    if (!fn) return false;
                    const text = await manager.db?.definition(row.profileId, {
                        database: row.database,
                        schema: fn.schema ?? row.schema,
                        name: fn.name,
                        kind: 'function',
                    });
                    body = (text && functionBodyFromDefinition(text)) || undefined;
                    if (body === undefined) return false;
                }
                const design = triggerFromDefinition(dialect, definition, name, table, body);
                if (!design) return false;
                const model: TriggerModel = { mode: 'edit', original: design, design };
                openEditor('trigger-editor', row, `${label} (trigger)`, {
                    name: label,
                    seed: seedEditorState('trigger', model),
                });
                return true;
            }
            if (row.kind === 'event' && engine === 'mysql') {
                const design = eventFromDefinition(definition, name);
                const model: EventModel = { mode: 'edit', original: design, design };
                openEditor('event-editor', row, `${label} (event)`, {
                    name: label,
                    seed: seedEditorState('event', model),
                });
                return true;
            }
            return false;
        };

        const actions: ExplorerActions = {
            capabilities: (row) => capabilitiesOf(engineOf(row)),

            openData: (row) => {
                const table = row.table ?? row.label;
                if (engineOf(row) === 'mongodb') open('documents', row, table, table);
                else open('table', row, table, table);
            },
            design: (row) => {
                const table = row.table ?? row.label;
                open('design', row, `${table} (structure)`, table);
            },
            newTable: (row) => {
                openAdminTab(
                    {
                        kind: 'design',
                        title: 'New table',
                        profileId: row.profileId,
                        database: row.database,
                        schema: row.schema,
                    },
                    { fresh: true },
                );
            },
            relationships: (row) => {
                const where = [row.database, row.schema].filter(Boolean).join('.');
                open(
                    'er',
                    row,
                    `Relationships${where ? ` · ${where}` : ''}`,
                    row.kind === 'table' ? (row.table ?? undefined) : undefined,
                );
            },
            indexes: (row) => {
                const table = row.table ?? row.label;
                open('indexes', row, `${table} (indexes)`, table);
            },
            triggers: (row) => {
                const table =
                    row.kind === 'table' ? (row.table ?? row.label) : (row.table ?? undefined);
                open('triggers', row, table ? `${table} (triggers)` : 'Triggers', table);
            },

            newObject: (row, kind) => {
                const engine = engineOf(row);
                const scope = {
                    database: row.database,
                    schema: engine === 'postgresql' ? row.schema : undefined,
                };
                // Triggers, routines, events and collections are made in a form, not a SQL tab.
                if (kind === 'collection') {
                    openEditor('collection-designer', row, 'New collection', {
                        seed: seedEditorState(
                            'collection',
                            newCollectionModel({ database: row.database }),
                        ),
                    });
                    return;
                }
                if (kind === 'trigger') {
                    openEditor('trigger-editor', row, 'New trigger', {
                        name: row.table ?? undefined,
                        seed: seedEditorState(
                            'trigger',
                            newTriggerModel({
                                database: engine === 'mysql' ? row.database : undefined,
                                schema: scope.schema,
                                table: row.table ?? undefined,
                            }),
                        ),
                    });
                    return;
                }
                if (kind === 'event') {
                    openEditor('event-editor', row, 'New event', {
                        seed: seedEditorState('event', newEventModel({ database: row.database })),
                    });
                    return;
                }
                if (kind === 'function' || kind === 'procedure') {
                    openEditor(`${kind}-editor`, row, `New ${kind}`, {
                        seed: seedEditorState(
                            'routine',
                            newRoutineModel(kind, {
                                database: engine === 'mysql' ? row.database : undefined,
                                schema: scope.schema,
                            }),
                        ),
                    });
                    return;
                }
                const dialect = dialectOf(engine);
                newQuery(
                    row.profileId,
                    createViewTemplate(dialect, {
                        database: engine === 'mysql' ? row.database : undefined,
                        schema: scope.schema,
                    }),
                    'New view',
                );
            },

            editDefinition: async (row) => {
                try {
                    const engine = engineOf(row);
                    const definition = await definitionOf(row);
                    // A routine, trigger or event opens in its form when its definition can be read
                    // back; one that cannot is shown as SQL instead of being guessed at.
                    if (await editInForm(row, engine, definition)) return;
                    let text = definition;
                    if (row.kind === 'view') {
                        const dialect = dialectOf(engine);
                        text = alterViewSql(dialect, {
                            ...nameOf(row, row.table ?? row.label),
                            query: viewQueryFromDefinition(definition),
                            materialized: row.objectKind === 'materialized view',
                        }).join('\n\n');
                    } else if (row.kind === 'routine' && engine === 'mysql') {
                        const dialect = dialectOf(engine);
                        text = `${dropRoutineSql(dialect, { ...nameOf(row, row.object ?? row.label), kind: row.routineKind === 'procedure' ? 'procedure' : 'function' }, true)}\n\n${definition}`;
                    } else if (row.kind === 'trigger' && engine === 'mysql') {
                        text = `${dropTriggerSql(dialectOf(engine), { ...nameOf(row, row.object ?? row.label), table: row.table ?? '' }, true)}\n\n${definition}`;
                    }
                    newQuery(row.profileId, text, row.object ?? row.table ?? row.label);
                } catch (error) {
                    notifications.show({
                        color: 'red',
                        title: 'Could not read the definition',
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            },

            runRoutine: (row) => openAdminDialog({ kind: 'routine', row }),

            drop: async (row) => {
                const engine = engineOf(row);
                const label = row.object ?? row.table ?? row.label;
                if (engine === 'mongodb') {
                    confirmStatements(
                        row,
                        `Drop ${row.kind === 'view' ? 'view' : 'collection'} ${label}?`,
                        [dropCollectionStatement(row.database, label)],
                        {
                            description:
                                'Its documents and indexes are deleted. This cannot be undone.',
                            confirmLabel: 'Drop',
                            danger: true,
                        },
                    );
                    return;
                }
                const dialect = dialectOf(engine);
                if (row.kind === 'table') {
                    confirmStatements(
                        row,
                        `Drop table ${label}?`,
                        [dropTableSql(dialect, nameOf(row, label))],
                        {
                            description:
                                'The table and all its rows are deleted. This cannot be undone.',
                            confirmLabel: 'Drop table',
                            danger: true,
                        },
                    );
                } else if (row.kind === 'view') {
                    confirmStatements(
                        row,
                        `Drop view ${label}?`,
                        [
                            dropViewSql(dialect, {
                                ...nameOf(row, label),
                                materialized: row.objectKind === 'materialized view',
                            }),
                        ],
                        {
                            confirmLabel: 'Drop view',
                            danger: true,
                        },
                    );
                } else if (row.kind === 'routine') {
                    let parameters;
                    try {
                        parameters = parametersFromDefinition(dialect, await definitionOf(row));
                    } catch {
                        parameters = undefined;
                    }
                    const kind = row.routineKind === 'procedure' ? 'procedure' : 'function';
                    confirmStatements(
                        row,
                        `Drop ${kind} ${label}?`,
                        [dropRoutineSql(dialect, { ...nameOf(row, label), kind, parameters })],
                        {
                            confirmLabel: `Drop ${kind}`,
                            danger: true,
                        },
                    );
                } else if (row.kind === 'trigger') {
                    confirmStatements(
                        row,
                        `Drop trigger ${label}?`,
                        [
                            dropTriggerSql(dialect, {
                                ...nameOf(row, label),
                                table: row.table ?? '',
                            }),
                        ],
                        {
                            confirmLabel: 'Drop trigger',
                            danger: true,
                        },
                    );
                }
            },

            truncate: (row) => {
                const label = row.table ?? row.label;
                confirmStatements(
                    row,
                    `Delete every row of ${label}?`,
                    [truncateTableSql(dialectOf(engineOf(row)), nameOf(row, label))],
                    {
                        description:
                            'All rows are removed and cannot be recovered. The table itself stays.',
                        confirmLabel: 'Delete all rows',
                        danger: true,
                    },
                );
            },

            rename: (row) => {
                const label = row.table ?? row.label;
                const engine = engineOf(row);
                openAdminDialog({
                    kind: 'prompt',
                    title: `Rename ${label}`,
                    label: 'New name',
                    initial: label,
                    confirmLabel: 'Preview',
                    validate: (value) => (value === label ? 'Enter a different name.' : null),
                    onSubmit: (value) =>
                        confirmStatements(
                            row,
                            `Rename ${label} to ${value}?`,
                            [
                                engine === 'mongodb'
                                    ? renameCollectionStatement(row.database, label, value)
                                    : renameTableSql(dialectOf(engine), nameOf(row, label), value),
                            ],
                            { confirmLabel: 'Rename' },
                        ),
                });
            },

            exportData: (row) =>
                openAdminDialog({
                    kind: 'export',
                    profileId: row.profileId,
                    source: {
                        kind: 'table',
                        database: row.database,
                        schema: row.schema,
                        name: row.table ?? row.label,
                    },
                }),
            importData: (row) =>
                openAdminDialog({
                    kind: 'import',
                    profileId: row.profileId,
                    target:
                        row.kind === 'table'
                            ? {
                                  database: row.database,
                                  schema: row.schema,
                                  name: row.table ?? row.label,
                              }
                            : undefined,
                }),

            editValidation: async (row) => {
                const label = row.table ?? row.label;
                openEditor('collection-designer', row, `${label} (validation)`, {
                    name: label,
                    seed: seedEditorState(
                        'collection',
                        newCollectionModel({ database: row.database, name: label }),
                    ),
                });
            },
        };
        return actions;
    }, [manager, profiles]);
}
