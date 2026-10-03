/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { editor } from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeEditor } from '../../editor/CodeEditor';
import { Text, UnstyledButton, cx } from '../../kit';
import { formatDuration } from '../../format';
import { QueryToolbar } from './QueryToolbar';
import { ResultsPanel } from './ResultsPanel';
import { type ToolbarActionId } from './toolbarActions';
import {
    currentRun,
    useHistory,
    useQueries,
    type BottomTab,
    type QueryTab as Tab,
} from './queryStore';
import { runSummary } from './resultSession';
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
    const shown = currentRun(tab);

    /** The text a statement-level action works on: the selection, or the whole editor. */
    const selectedOrAll = (): string => {
        const model = instance.current?.getModel();
        const selection = instance.current?.getSelection();
        return model && selection && !selection.isEmpty()
            ? model.getValueInRange(selection)
            : tab.text;
    };

    const onAction = (action: ToolbarActionId) => {
        switch (action) {
            case 'run':
                return run('current');
            case 'runAll':
                return run('all');
            case 'stop':
                return void manager.cancel(id);
            case 'explain':
                return void manager.explain(id, selectedOrAll());
            case 'save':
                return void actions.saveTab(id);
            case 'export':
                if (profile)
                    openAdminDialog({
                        kind: 'export',
                        profileId: profile.id,
                        source: { kind: 'query', text: selectedOrAll(), label: tab.title },
                    });
                return;
            case 'begin':
            case 'commit':
            case 'rollback':
                return void manager.transaction(id, action);
        }
    };

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
            <QueryToolbar
                state={{
                    hasConnection: !!profile,
                    running: tab.running,
                    canExplain,
                    canTransact,
                    inTransaction: tab.inTransaction,
                    saved: !isQueryDirty(tab) && !!tab.source,
                    canExport: capabilities.length > 0,
                    statementNoun: layout.statementNoun,
                }}
                profiles={profiles}
                connectionId={tab.profileId}
                database={tab.database}
                schema={tab.schema}
                databases={databases}
                schemas={schemas}
                withSchemas={!!layout.schemas}
                note={profile && !connected ? 'Not connected · connects when you run' : ''}
                onConnection={(value) => manager.setConnection(id, value)}
                onDatabase={(value) => manager.setContext(id, { database: value })}
                onSchema={(value) => manager.setContext(id, { schema: value })}
                onAction={onAction}
            />

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
                    {tab.bottom === 'results' && shown && (
                        <span className="ml-auto pr-3 text-xs text-dimmed">
                            {tab.runs.length > 1
                                ? `${tab.runs.length} statements`
                                : runSummary(shown)}
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

    if (tab.bottom === 'results') return <ResultsPanel tab={tab} />;

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
