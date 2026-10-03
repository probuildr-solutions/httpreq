/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    createTriggerSql,
    dialectOf,
    dropTriggerSql,
    setTriggerEnabledSql,
    triggerOptions,
    type TriggerEvent,
    type TriggerTiming,
} from '@httpreq/db-admin';
import type { DbTriggerInfo } from '@httpreq/shared';
import { AppModal } from '../../AppModal';
import {
    ActionIcon,
    Alert,
    Button,
    Checkbox,
    Select,
    Text,
    TextInput,
    Textarea,
    Tooltip,
} from '../../kit';
import { useProfiles } from '../db/profiles';
import { useDbManager } from '../db/useDbManager';
import { useAdmin } from './adminStore';
import { RunStatementsDialog } from './RunStatementsDialog';

const EVENTS: TriggerEvent[] = ['INSERT', 'UPDATE', 'DELETE'];

/**
 * Triggers of a table (or of a whole schema): list, create, enable and disable (PostgreSQL), edit
 * and drop. A MySQL trigger has one event and its own body; a PostgreSQL trigger can fire on several
 * events and runs a function, which the form writes for you from the body. Editing opens the
 * server's definition in a query tab, because rewriting a trigger is rewriting its code.
 */
export function TriggerManager({ id }: { id: string }) {
    const manager = useDbManager();
    const tab = useAdmin((state) => state.tabs[id]);
    const profile = useProfiles((state) => state.profiles.find((p) => p.id === tab?.profileId));
    const engine = profile?.settings.engine ?? 'mysql';
    const dialect = useMemo(() => dialectOf(engine), [engine]);
    const options = useMemo(() => triggerOptions(dialect), [dialect]);
    const profileId = tab?.profileId ?? '';
    const { listMeta } = manager;

    const [triggers, setTriggers] = useState<DbTriggerInfo[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [pending, setPending] = useState<{
        title: string;
        statements: string[];
        danger?: boolean;
        confirm: string;
    } | null>(null);

    const load = useCallback(async () => {
        if (!profileId) return;
        setError(null);
        try {
            const all = (await listMeta(profileId, 'triggers', {
                ...(tab?.database ? { database: tab.database } : {}),
                ...(tab?.schema ? { schema: tab.schema } : {}),
            })) as DbTriggerInfo[];
            setTriggers(tab?.name ? all.filter((t) => t.table === tab.name) : all);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [profileId, tab?.database, tab?.schema, tab?.name, listMeta]);

    useEffect(() => {
        void load();
    }, [load]);

    const ref = (trigger: DbTriggerInfo) => ({
        name: trigger.name,
        table: trigger.table,
        schema: engine === 'postgresql' ? tab?.schema : undefined,
        database: engine === 'mysql' ? tab?.database : undefined,
    });

    const edit = async (trigger: DbTriggerInfo) => {
        try {
            const definition = await manager.definition({
                key: trigger.name,
                kind: 'trigger',
                depth: 0,
                label: trigger.name,
                expandable: false,
                expanded: false,
                profileId,
                engine,
                database: tab?.database,
                schema: tab?.schema,
                object: trigger.name,
            });
            const drop =
                engine === 'mysql' ? `${dropTriggerSql(dialect, ref(trigger), true)}\n\n` : '';
            manager.newQuery(profileId, `${drop}${definition}`, trigger.name);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    if (!tab) return null;
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="trigger-manager">
            <div className="box-border flex h-9 flex-none items-center gap-1 border-b border-line bg-chrome px-2">
                <Text size="sm" className="font-medium">
                    Triggers{tab.name ? ` on ${tab.name}` : ''}
                </Text>
                <span className="ml-auto" />
                <Tooltip label="Reload">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Reload"
                        onClick={() => void load()}
                    >
                        <IconRefresh size={15} />
                    </ActionIcon>
                </Tooltip>
                {tab.name && (
                    <Button
                        size="xs"
                        leftSection={<IconPlus size={14} />}
                        onClick={() => setCreating(true)}
                    >
                        New trigger
                    </Button>
                )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
                {error && (
                    <Alert color="red" className="mb-2">
                        {error}
                    </Alert>
                )}
                {triggers && triggers.length === 0 && (
                    <Text size="sm" className="text-dimmed">
                        No triggers.
                    </Text>
                )}
                {triggers && triggers.length > 0 && (
                    <table className="w-full border-collapse text-xs" aria-label="Triggers">
                        <thead>
                            <tr className="text-left text-dimmed">
                                <th className="px-2 py-1 font-medium">Name</th>
                                {!tab.name && <th className="px-2 py-1 font-medium">Table</th>}
                                <th className="px-2 py-1 font-medium">Fires</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {triggers.map((trigger) => (
                                <tr
                                    key={`${trigger.table}.${trigger.name}`}
                                    className="border-t border-line/60"
                                >
                                    <td className="px-2 py-1 font-medium">{trigger.name}</td>
                                    {!tab.name && <td className="px-2 py-1">{trigger.table}</td>}
                                    <td className="px-2 py-1">
                                        {trigger.timing} {trigger.event}
                                    </td>
                                    <td className="flex justify-end gap-1 px-2 py-1">
                                        <Button
                                            size="compact-xs"
                                            variant="subtle"
                                            onClick={() => void edit(trigger)}
                                        >
                                            Edit…
                                        </Button>
                                        {options.canEnable && (
                                            <>
                                                <Button
                                                    size="compact-xs"
                                                    variant="subtle"
                                                    onClick={() =>
                                                        setPending({
                                                            title: `Enable ${trigger.name}`,
                                                            statements: [
                                                                setTriggerEnabledSql(
                                                                    dialect,
                                                                    ref(trigger),
                                                                    true,
                                                                )!,
                                                            ],
                                                            confirm: 'Enable',
                                                        })
                                                    }
                                                >
                                                    Enable
                                                </Button>
                                                <Button
                                                    size="compact-xs"
                                                    variant="subtle"
                                                    onClick={() =>
                                                        setPending({
                                                            title: `Disable ${trigger.name}`,
                                                            statements: [
                                                                setTriggerEnabledSql(
                                                                    dialect,
                                                                    ref(trigger),
                                                                    false,
                                                                )!,
                                                            ],
                                                            confirm: 'Disable',
                                                        })
                                                    }
                                                >
                                                    Disable
                                                </Button>
                                            </>
                                        )}
                                        <ActionIcon
                                            size="sm"
                                            variant="subtle"
                                            color="red"
                                            aria-label={`Drop trigger ${trigger.name}`}
                                            onClick={() =>
                                                setPending({
                                                    title: `Drop trigger ${trigger.name}?`,
                                                    statements: [
                                                        dropTriggerSql(dialect, ref(trigger)),
                                                    ],
                                                    danger: true,
                                                    confirm: 'Drop trigger',
                                                })
                                            }
                                        >
                                            <IconTrash size={14} />
                                        </ActionIcon>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {creating && tab.name && (
                <NewTriggerForm
                    multipleEvents={options.multipleEvents}
                    timings={options.timings}
                    onClose={() => setCreating(false)}
                    onPreview={(form) => {
                        setCreating(false);
                        setPending({
                            title: 'Create trigger',
                            confirm: 'Create trigger',
                            statements: createTriggerSql(dialect, {
                                name: form.name,
                                table: tab.name!,
                                schema: engine === 'postgresql' ? tab.schema : undefined,
                                database: engine === 'mysql' ? tab.database : undefined,
                                timing: form.timing,
                                events: form.events,
                                body: form.body,
                                forEachRow: true,
                            }),
                        });
                    }}
                />
            )}
            {pending && (
                <RunStatementsDialog
                    title={pending.title}
                    statements={pending.statements}
                    profileId={profileId}
                    danger={pending.danger}
                    confirmLabel={pending.confirm}
                    onClose={() => setPending(null)}
                    onDone={() => {
                        setPending(null);
                        void load();
                        manager.refresh(profileId);
                    }}
                />
            )}
        </div>
    );
}

function NewTriggerForm({
    multipleEvents,
    timings,
    onClose,
    onPreview,
}: {
    multipleEvents: boolean;
    timings: TriggerTiming[];
    onClose: () => void;
    onPreview: (form: {
        name: string;
        timing: TriggerTiming;
        events: TriggerEvent[];
        body: string;
    }) => void;
}) {
    const [name, setName] = useState('');
    const [timing, setTiming] = useState<TriggerTiming>('BEFORE');
    const [events, setEvents] = useState<TriggerEvent[]>(['INSERT']);
    const [body, setBody] = useState('');
    const valid = name.trim() !== '' && events.length > 0 && body.trim() !== '';
    return (
        <AppModal
            opened
            onClose={onClose}
            title="New trigger"
            size="lg"
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        size="xs"
                        disabled={!valid}
                        onClick={() => onPreview({ name: name.trim(), timing, events, body })}
                    >
                        Preview SQL
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
                <Select
                    label="When"
                    value={timing}
                    data={timings.map((t) => ({ value: t, label: t }))}
                    onChange={(v) => v && setTiming(v as TriggerTiming)}
                />
                {multipleEvents ? (
                    <div className="flex gap-4">
                        {EVENTS.map((event) => (
                            <Checkbox
                                key={event}
                                label={event}
                                checked={events.includes(event)}
                                onChange={(e) =>
                                    setEvents((current) =>
                                        e.currentTarget.checked
                                            ? [...current, event]
                                            : current.filter((x) => x !== event),
                                    )
                                }
                            />
                        ))}
                    </div>
                ) : (
                    <Select
                        label="Event"
                        value={events[0] ?? 'INSERT'}
                        data={EVENTS.map((e) => ({ value: e, label: e }))}
                        onChange={(v) => v && setEvents([v as TriggerEvent])}
                    />
                )}
                <Textarea
                    label="Body"
                    description={
                        multipleEvents
                            ? 'The body of the function the trigger runs, including BEGIN … END and RETURN NEW;'
                            : 'Statements that run for each row; NEW and OLD refer to the row'
                    }
                    minRows={8}
                    autosize
                    className="font-mono"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                />
            </div>
        </AppModal>
    );
}
