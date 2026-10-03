/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect, useMemo, useState } from 'react';
import {
    callStatements,
    dialectOf,
    inputParameters,
    parametersFromDefinition,
    parseCellInput,
    type RoutineParameter,
    type SqlValue,
} from '@httpreq/db-admin';
import { AppModal } from '../../AppModal';
import { Alert, Button, Checkbox, Text, TextInput } from '../../kit';
import type { ExplorerRow } from '../db/explorerRows';
import { useDbManager } from '../db/useDbManager';
import { closeAdminDialog, useAdminDialog } from './dialogStore';
import { RunStatementsDialog } from './RunStatementsDialog';
import { ExportDialog, ImportDialog, ScriptDialog } from '../tasks/TransferDialogs';

/** Draws whichever dialog the explorer's menus asked for. */
export function AdminDialogs() {
    const dialog = useAdminDialog((state) => state.dialog);
    const manager = useDbManager();
    if (!dialog) return null;
    if (dialog.kind === 'statements') {
        return (
            <RunStatementsDialog
                title={dialog.title}
                description={dialog.description}
                statements={dialog.statements}
                profileId={dialog.profileId}
                confirmLabel={dialog.confirmLabel}
                danger={dialog.danger}
                onClose={closeAdminDialog}
                onDone={() => {
                    closeAdminDialog();
                    manager.refresh(dialog.profileId);
                    dialog.onDone?.();
                }}
            />
        );
    }
    if (dialog.kind === 'routine') return <ExecuteRoutineDialog row={dialog.row} />;
    if (dialog.kind === 'export')
        return <ExportDialog profileId={dialog.profileId} source={dialog.source} />;
    if (dialog.kind === 'import')
        return (
            <ImportDialog profileId={dialog.profileId} target={dialog.target} file={dialog.file} />
        );
    if (dialog.kind === 'script')
        return <ScriptDialog profileId={dialog.profileId} file={dialog.file} />;
    return <PromptDialog key={dialog.title} dialog={dialog} />;
}

function PromptDialog({
    dialog,
}: {
    dialog: Extract<
        NonNullable<ReturnType<typeof useAdminDialog.getState>['dialog']>,
        { kind: 'prompt' }
    >;
}) {
    const [value, setValue] = useState(dialog.initial ?? '');
    const error = value.trim() ? (dialog.validate?.(value.trim()) ?? null) : null;
    const submit = () => {
        if (!value.trim() || error) return;
        closeAdminDialog();
        dialog.onSubmit(value.trim());
    };
    return (
        <AppModal
            opened
            onClose={closeAdminDialog}
            title={dialog.title}
            size="sm"
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={closeAdminDialog}>
                        Cancel
                    </Button>
                    <Button size="xs" disabled={!value.trim() || !!error} onClick={submit}>
                        {dialog.confirmLabel ?? 'OK'}
                    </Button>
                </>
            }
        >
            <TextInput
                autoFocus
                label={dialog.label}
                value={value}
                error={error ?? undefined}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
        </AppModal>
    );
}

/**
 * Runs a function or stored procedure: asks for each input value (with NULL as a choice), builds
 * the call for the engine (MySQL OUT parameters go through session variables), and runs it in a new
 * query tab so every result set it returns is shown in the grid.
 */
function ExecuteRoutineDialog({ row }: { row: ExplorerRow }) {
    const manager = useDbManager();
    const [parameters, setParameters] = useState<RoutineParameter[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [values, setValues] = useState<Record<string, { text: string; isNull: boolean }>>({});
    const dialect = useMemo(() => dialectOf(row.engine), [row.engine]);
    const kind = row.routineKind === 'procedure' ? 'procedure' : 'function';

    useEffect(() => {
        let cancelled = false;
        void manager
            .definition(row)
            .then(
                (definition) =>
                    !cancelled && setParameters(parametersFromDefinition(dialect, definition)),
            )
            .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
        return () => {
            cancelled = true;
        };
        // The definition is read once for this routine.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [row.key]);

    const inputs = parameters ? inputParameters(parameters) : [];
    const parsed: Record<string, SqlValue> = {};
    const problems: Record<string, string> = {};
    for (const parameter of inputs) {
        const entry = values[parameter.name] ?? { text: '', isNull: false };
        if (entry.isNull) {
            parsed[parameter.name] = { kind: 'null' };
            continue;
        }
        const result = parseCellInput(parameter.type, entry.text);
        if (result.ok) parsed[parameter.name] = result.value;
        else problems[parameter.name] = result.error;
    }
    const ready = parameters !== null && Object.keys(problems).length === 0;

    const run = () => {
        if (!parameters) return;
        const statements = callStatements(
            dialect,
            {
                name: row.object ?? row.label,
                schema: row.engine === 'postgresql' ? row.schema : undefined,
                database: row.engine === 'mysql' ? row.database : undefined,
                kind,
                parameters,
            },
            parsed,
        );
        const id = manager.newQuery(row.profileId, statements.join('\n'), `${row.label}()`);
        closeAdminDialog();
        void manager.run(id, { text: statements.join('\n'), mode: 'all' });
    };

    return (
        <AppModal
            opened
            onClose={closeAdminDialog}
            title={`Run ${row.label}`}
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={closeAdminDialog}>
                        Cancel
                    </Button>
                    <Button size="xs" disabled={!ready} onClick={run}>
                        Run
                    </Button>
                </>
            }
        >
            {error && <Alert color="red">{error}</Alert>}
            {!parameters && !error && (
                <Text size="sm" className="text-dimmed">
                    Reading the routine…
                </Text>
            )}
            {parameters && inputs.length === 0 && (
                <Text size="sm">This {kind} takes no input values.</Text>
            )}
            <div className="flex flex-col gap-3">
                {inputs.map((parameter) => {
                    const entry = values[parameter.name] ?? { text: '', isNull: false };
                    return (
                        <div key={parameter.name} className="flex items-end gap-2">
                            <TextInput
                                className="min-w-0 flex-1"
                                label={`${parameter.name} (${parameter.mode === 'INOUT' ? 'in/out ' : ''}${parameter.type})`}
                                disabled={entry.isNull}
                                value={entry.text}
                                error={
                                    !entry.isNull && entry.text !== ''
                                        ? problems[parameter.name]
                                        : undefined
                                }
                                onChange={(e) =>
                                    setValues((v) => ({
                                        ...v,
                                        [parameter.name]: { ...entry, text: e.target.value },
                                    }))
                                }
                            />
                            <Checkbox
                                label="NULL"
                                checked={entry.isNull}
                                onChange={(e) =>
                                    setValues((v) => ({
                                        ...v,
                                        [parameter.name]: {
                                            ...entry,
                                            isNull: e.currentTarget.checked,
                                        },
                                    }))
                                }
                            />
                        </div>
                    );
                })}
                {parameters?.some((p) => p.mode !== 'IN') && (
                    <Text size="xs" className="text-dimmed">
                        Output values are shown in the result.
                    </Text>
                )}
            </div>
        </AppModal>
    );
}
