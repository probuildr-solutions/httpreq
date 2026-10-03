/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconArrowBackUp,
    IconCheck,
    IconDeviceFloppy,
    IconDownload,
    IconPlayerPlay,
    IconPlayerStop,
    IconPlayerTrackNext,
    IconRoute,
    IconTransactionBitcoin,
} from '@tabler/icons-react';
import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeEditor } from '../../editor/CodeEditor';
import { Button, Select, Text, Tooltip, UnstyledButton, cx } from '../../kit';
import { formatDuration } from '../../format';
import { ResultGrid } from './ResultGrid';
import {
    currentResult,
    useHistory,
    useQueries,
    type BottomTab,
    type QueryTab as Tab,
} from './queryStore';
import { useProfiles } from './profiles';
import { useLive } from './queryStore';
import { layoutOf } from './engines';
import { useDbManager } from './useDbManager';
import { useTabActions } from '../tabs/useTabActions';
import { openAdminDialog } from '../admin/dialogStore';
import { handlingFor } from '../largeFile';
import { isQueryDirty } from './queryStore';

const COUNT = new Intl.NumberFormat('en-US');

const BOTTOM_TABS: { id: BottomTab; label: string }[] = [
    { id: 'results', label: 'Results' },
    { id: 'messages', label: 'Messages' },
    { id: 'history', label: 'History' },
    { id: 'explain', label: 'Explain' },
];

/**
 * A SQL editor over a connection, with the statement's results below it. Ctrl+Enter runs the
 * statement at the cursor (or the selection), Ctrl+Shift+Enter runs everything, Escape-free
 * cancellation is the Stop button. Results stream into the grid as they arrive.
 */
export function QueryTab({ id }: { id: string }) {
    const manager = useDbManager();
    const tab = useQueries((state) => state.tabs[id]);
    const profiles = useProfiles((state) => state.profiles);
    const status = useLive((state) => state.status);
    const instance = useRef<editor.IStandaloneCodeEditor | null>(null);

    const actions = useTabActions();
    const profile = profiles.find((p) => p.id === tab?.profileId);
    const layout = layoutOf(profile?.settings.engine ?? 'mysql');
    const engineId = profile?.settings.engine;
    const connectedProfile = tab?.profileId ? status[tab.profileId]?.state === 'connected' : false;

    // The databases and schemas this tab can choose from, read when the connection is open.
    const [databases, setDatabases] = useState<string[]>([]);
    const [schemas, setSchemas] = useState<string[]>([]);
    const profileId = tab?.profileId ?? null;
    const database = tab?.database ?? null;
    const { listMeta } = manager;
    useEffect(() => {
        let cancelled = false;
        if (!profileId || !connectedProfile) {
            setDatabases([]);
            return;
        }
        void listMeta(profileId, 'databases')
            .then((items) => {
                if (cancelled) return;
                let names = (items as { name: string; system: boolean }[])
                    .filter((d) => !d.system)
                    .map((d) => d.name);
                // PostgreSQL statements run on the database the connection was opened with.
                if (engineId === 'postgresql') {
                    const own = profile?.settings.database || profile?.settings.username;
                    names = names.filter((name) => name === own);
                }
                setDatabases(names);
            })
            .catch(() => !cancelled && setDatabases([]));
        return () => {
            cancelled = true;
        };
        // The profile's own settings only matter through the connection that was opened.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profileId, connectedProfile, engineId, listMeta]);
    useEffect(() => {
        let cancelled = false;
        const schemaDatabase = database ?? (engineId === 'postgresql' ? databases[0] : undefined);
        if (!profileId || !connectedProfile || !layout.schemas || !schemaDatabase) {
            setSchemas([]);
            return;
        }
        void listMeta(profileId, 'schemas', { database: schemaDatabase })
            .then((items) => {
                if (!cancelled)
                    setSchemas(
                        (items as { name: string; system: boolean }[])
                            .filter((schema) => !schema.system)
                            .map((schema) => schema.name),
                    );
            })
            .catch(() => !cancelled && setSchemas([]));
        return () => {
            cancelled = true;
        };
    }, [profileId, connectedProfile, database, databases, layout.schemas, engineId, listMeta]);
    const capabilities =
        manager.engines.find((engine) => engine.id === profile?.settings.engine)?.capabilities ??
        [];
    const canExplain = capabilities.includes('explain');
    const canTransact = capabilities.includes('transactions');

    const run = useCallback(
        (mode: 'current' | 'all') => {
            const current = useQueries.getState().tabs[id];
            if (!current) return;
            const editorInstance = instance.current;
            const selection = editorInstance?.getSelection();
            const model = editorInstance?.getModel();
            if (mode === 'current' && selection && model && !selection.isEmpty()) {
                void manager.run(id, { text: model.getValueInRange(selection), mode: 'selection' });
                return;
            }
            const offset =
                editorInstance && model && editorInstance.getPosition()
                    ? model.getOffsetAt(editorInstance.getPosition()!)
                    : 0;
            void manager.run(id, { text: current.text, mode, offset });
        },
        [id, manager],
    );

    if (!tab) return null;

    const connected = tab.profileId ? status[tab.profileId]?.state === 'connected' : false;
    const result = currentResult(tab);
    const snapshot = tab.snapshot;

    const onKeyDown = (event: React.KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            event.stopPropagation();
            void actions.saveTab(id, { as: event.shiftKey });
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            // Captured, so the editor's own "insert line below" does not get the key first.
            event.preventDefault();
            event.stopPropagation();
            run(event.shiftKey ? 'all' : 'current');
        }
    };

    return (
        <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            onKeyDownCapture={onKeyDown}
            data-testid="query-tab"
        >
            <div className="box-border flex h-9 flex-none items-center gap-1.5 overflow-x-auto overflow-y-hidden border-b border-line bg-chrome px-2 whitespace-nowrap">
                <Select
                    size="xs"
                    aria-label="Connection"
                    placeholder="Choose a connection"
                    value={tab.profileId}
                    data={profiles.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(value) => manager.setConnection(id, value)}
                    className="w-44 flex-none"
                />
                {databases.length > 0 && (
                    <Select
                        size="xs"
                        aria-label="Database"
                        placeholder="Database"
                        clearable
                        value={tab.database}
                        data={databases.map((name) => ({ value: name, label: name }))}
                        onChange={(value) => manager.setContext(id, { database: value })}
                        className="w-36 flex-none"
                    />
                )}
                {layout.schemas && schemas.length > 0 && (
                    <Select
                        size="xs"
                        aria-label="Schema"
                        placeholder="Schema"
                        clearable
                        value={tab.schema}
                        data={schemas.map((name) => ({ value: name, label: name }))}
                        onChange={(value) => manager.setContext(id, { schema: value })}
                        className="w-32 flex-none"
                    />
                )}
                {/* Run, Run all and Stop are always mounted, in fixed places: starting a query only
                    toggles which of them is enabled, so the toolbar never changes width or wraps,
                    and nothing beside or below it moves. */}
                <Tooltip
                    label={`Run the ${layout.statementNoun} at the cursor, or the selection (Ctrl+Enter)`}
                >
                    <Button
                        size="xs"
                        leftSection={<IconPlayerPlay size={14} />}
                        disabled={!profile || tab.running}
                        onClick={() => run('current')}
                    >
                        Run
                    </Button>
                </Tooltip>
                <Tooltip label={`Run every ${layout.statementNoun} (Ctrl+Shift+Enter)`}>
                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlayerTrackNext size={14} />}
                        disabled={!profile || tab.running}
                        onClick={() => run('all')}
                    >
                        Run all
                    </Button>
                </Tooltip>
                <Button
                    size="xs"
                    color="red"
                    variant="light"
                    leftSection={<IconPlayerStop size={14} />}
                    disabled={!tab.running}
                    onClick={() => void manager.cancel(id)}
                >
                    Stop
                </Button>
                {canExplain && (
                    <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconRoute size={14} />}
                        disabled={!profile || tab.running}
                        onClick={() => {
                            const model = instance.current?.getModel();
                            const selection = instance.current?.getSelection();
                            const text =
                                model && selection && !selection.isEmpty()
                                    ? model.getValueInRange(selection)
                                    : tab.text;
                            void manager.explain(id, text);
                        }}
                    >
                        Explain
                    </Button>
                )}
                <Tooltip label="Save to a file (Ctrl+S)">
                    <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconDeviceFloppy size={14} />}
                        disabled={!isQueryDirty(tab) && !!tab.source}
                        onClick={() => void actions.saveTab(id)}
                    >
                        Save
                    </Button>
                </Tooltip>
                <Tooltip label="Export the result of this statement to a file">
                    <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconDownload size={14} />}
                        disabled={!profile || tab.running || !capabilities.length}
                        onClick={() => {
                            const model = instance.current?.getModel();
                            const selection = instance.current?.getSelection();
                            const text =
                                model && selection && !selection.isEmpty()
                                    ? model.getValueInRange(selection)
                                    : tab.text;
                            if (profile)
                                openAdminDialog({
                                    kind: 'export',
                                    profileId: profile.id,
                                    source: { kind: 'query', text, label: tab.title },
                                });
                        }}
                    >
                        Export
                    </Button>
                </Tooltip>
                <Tooltip label="Export the result of this statement to a file">
                    <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconDownload size={14} />}
                        disabled={!profile || tab.running}
                        onClick={() => {
                            const model = instance.current?.getModel();
                            const selection = instance.current?.getSelection();
                            const text =
                                model && selection && !selection.isEmpty()
                                    ? model.getValueInRange(selection)
                                    : tab.text;
                            if (profile)
                                openAdminDialog({
                                    kind: 'export',
                                    profileId: profile.id,
                                    source: { kind: 'query', text, label: tab.title },
                                });
                        }}
                    >
                        Export
                    </Button>
                </Tooltip>
                <span className="mx-1 h-4 w-px bg-line" />
                {canTransact && tab.inTransaction ? (
                    <>
                        <Button
                            size="xs"
                            variant="light"
                            color="teal"
                            leftSection={<IconCheck size={14} />}
                            onClick={() => void manager.transaction(id, 'commit')}
                        >
                            Commit
                        </Button>
                        <Button
                            size="xs"
                            variant="light"
                            color="yellow"
                            leftSection={<IconArrowBackUp size={14} />}
                            onClick={() => void manager.transaction(id, 'rollback')}
                        >
                            Roll back
                        </Button>
                    </>
                ) : canTransact ? (
                    <Tooltip label="Statements run in a transaction until you commit or roll back">
                        <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconTransactionBitcoin size={14} />}
                            disabled={!profile || tab.running}
                            onClick={() => void manager.transaction(id, 'begin')}
                        >
                            Begin
                        </Button>
                    </Tooltip>
                ) : null}
                <span className="ml-auto flex-none text-xs text-dimmed">
                    {profile && !connected ? 'Not connected · connects when you run' : ''}
                </span>
            </div>

            <div className="min-h-24 min-w-0 flex-[2] overflow-hidden border-b border-line">
                <CodeEditor
                    value={tab.text}
                    onChange={(text) => manager.setText(id, text)}
                    language={layout.language}
                    ariaLabel={
                        layout.language === 'plaintext' ? 'Command editor' : 'Statement editor'
                    }
                    purpose={{ kind: 'output' }}
                    largeFile={handlingFor(tab.text.length) !== 'editor'}
                    className="h-full"
                    onEditor={(next) => {
                        instance.current = next;
                    }}
                />
            </div>

            <div className="flex min-h-24 min-w-0 flex-[3] flex-col overflow-hidden">
                <div
                    role="tablist"
                    className="box-border flex h-8 flex-none items-center border-b border-line bg-chrome"
                >
                    {BOTTOM_TABS.map((item) => (
                        <UnstyledButton
                            key={item.id}
                            role="tab"
                            aria-selected={tab.bottom === item.id}
                            className={cx(
                                'px-3 py-1.5 text-xs',
                                tab.bottom === item.id
                                    ? 'border-b-2 border-primary font-medium'
                                    : 'text-dimmed hover:text-fg',
                            )}
                            onClick={() => manager.setBottom(id, item.id)}
                        >
                            {item.label}
                        </UnstyledButton>
                    ))}
                    {snapshot && result && (
                        <span className="ml-auto pr-3 text-xs text-dimmed">
                            {COUNT.format(result.rowCount)} row{result.rowCount === 1 ? '' : 's'}
                            {!result.complete && snapshot.state === 'running' && !snapshot.paused
                                ? ' so far'
                                : ''}
                            {!result.complete && snapshot.paused ? ' loaded' : ''}
                            {' · '}
                            {formatDuration(snapshot.elapsedMs)}
                        </span>
                    )}
                </div>
                <div
                    className={cx(
                        'min-h-0 flex-1',
                        // The grid scrolls itself; a second scrollbar here would appear and
                        // disappear with the result and shift the grid.
                        tab.bottom === 'results'
                            ? 'overflow-hidden'
                            : 'overflow-auto [scrollbar-gutter:stable]',
                    )}
                >
                    <BottomPanel tab={tab} />
                </div>
            </div>
        </div>
    );
}

function BottomPanel({ tab }: { tab: Tab }) {
    const manager = useDbManager();
    const history = useHistory((state) => state.entries);
    const enabled = useHistory((state) => state.enabled);
    const snapshot = tab.snapshot;
    const result = currentResult(tab);

    if (tab.bottom === 'results') {
        if (!snapshot || !result || !manager.db || !tab.runId) {
            return (
                <Text size="sm" className="p-3 text-dimmed">
                    {tab.running ? 'Running…' : 'Run a statement to see its result here.'}
                </Text>
            );
        }
        return (
            <div className="flex h-full flex-col">
                {snapshot.results.length > 1 && (
                    <div className="flex flex-none gap-1 border-b border-line px-2 py-1">
                        {snapshot.results.map((item, index) => (
                            <UnstyledButton
                                key={item.index}
                                className={cx(
                                    'rounded-sm px-2 py-0.5 text-xs',
                                    index === tab.resultIndex
                                        ? 'bg-primary-soft'
                                        : 'hover:bg-hover',
                                )}
                                onClick={() => manager.setResult(tab.id, index)}
                            >
                                Result {index + 1}
                            </UnstyledButton>
                        ))}
                    </div>
                )}
                <div className="min-h-0 flex-1">
                    <ResultGrid
                        api={manager.db}
                        runId={tab.runId}
                        result={result}
                        onDemand={(rows) => manager.demand(tab.id, rows)}
                    />
                </div>
                {snapshot.paused && !result.complete && (
                    <div className="flex flex-none items-center gap-2 border-t border-line px-3 py-1 text-xs text-dimmed">
                        The server has more rows; they are read as you scroll.
                        <Button size="xs" variant="subtle" onClick={() => manager.fetchAll(tab.id)}>
                            Load all
                        </Button>
                    </div>
                )}
            </div>
        );
    }

    if (tab.bottom === 'messages') {
        if (tab.log.length === 0) {
            return (
                <Text size="sm" className="p-3 text-dimmed">
                    Nothing has run yet.
                </Text>
            );
        }
        return (
            <ul className="m-0 list-none p-0 font-mono text-xs">
                {tab.log.map((entry) => (
                    <li
                        key={entry.index}
                        className="flex gap-2 border-b border-line/60 px-3 py-1.5"
                    >
                        <span
                            className={cx(
                                'w-14 flex-none',
                                entry.state === 'failed' && 'text-red-500',
                                entry.state === 'done' && 'text-teal-600',
                                entry.state === 'running' && 'text-dimmed',
                            )}
                        >
                            {entry.state}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate">{entry.sql}</span>
                            <span className="block text-dimmed">
                                {entry.message ??
                                    [
                                        entry.rows !== undefined
                                            ? `${COUNT.format(entry.rows)} rows`
                                            : null,
                                        entry.affectedRows !== undefined
                                            ? `${COUNT.format(entry.affectedRows)} affected`
                                            : null,
                                        entry.elapsedMs !== undefined
                                            ? formatDuration(entry.elapsedMs)
                                            : null,
                                    ]
                                        .filter(Boolean)
                                        .join(' · ')}
                            </span>
                        </span>
                    </li>
                ))}
            </ul>
        );
    }

    if (tab.bottom === 'explain') {
        if (tab.explainError)
            return (
                <Text size="sm" className="p-3 text-red-500">
                    {tab.explainError}
                </Text>
            );
        if (!tab.explain)
            return (
                <Text size="sm" className="p-3 text-dimmed">
                    Choose Explain to see how the server runs a statement.
                </Text>
            );
        return (
            <pre className="m-0 p-3 font-mono text-xs whitespace-pre-wrap">{tab.explain.text}</pre>
        );
    }

    const own = history.filter((entry) => entry.profileId === tab.profileId);
    return (
        <div>
            {!enabled && (
                <Text size="xs" className="p-3 text-dimmed">
                    History is turned off.
                </Text>
            )}
            {own.length === 0 && enabled && (
                <Text size="sm" className="p-3 text-dimmed">
                    No statements yet on this connection.
                </Text>
            )}
            <ul className="m-0 list-none p-0 font-mono text-xs">
                {own.map((entry) => (
                    <li key={entry.id}>
                        <UnstyledButton
                            className="block w-full border-b border-line/60 px-3 py-1.5 text-left hover:bg-hover"
                            title="Put this statement in the editor"
                            onClick={() => manager.setText(tab.id, entry.sql)}
                        >
                            <span className="block truncate">{entry.sql.replace(/\s+/g, ' ')}</span>
                            <span
                                className={cx(
                                    'block text-dimmed',
                                    entry.state === 'failed' && 'text-red-500',
                                )}
                            >
                                {new Date(entry.at).toLocaleTimeString()} · {entry.state}
                                {entry.error
                                    ? ` · ${entry.error}`
                                    : ` · ${formatDuration(entry.elapsedMs)}`}
                            </span>
                        </UnstyledButton>
                    </li>
                ))}
            </ul>
        </div>
    );
}
