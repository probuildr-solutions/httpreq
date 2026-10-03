/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useMemo } from 'react';
import {
    EVENT_INTERVAL_UNITS,
    alterEventSql,
    checkSqlBody,
    createEventSql,
    formatSqlBody,
    relationalProfileOf,
    validateEvent,
    type EventDesign,
    type EventIntervalUnit,
    type EventStatus,
} from '@httpreq/db-admin';
import { Checkbox, NumberInput, SegmentedControl, Select, Text, TextInput } from '../../../kit';
import { newEventModel, type EventModel } from './models';
import { BodyEditor, EditorShell, FIELD_GRID, FormSection } from './formParts';
import { useAdminTabState } from './useAdminTabState';
import { useEditorTab, useMetaNames, useSaveObject, withCurrent } from './useObjectEditor';

/** The value of a `datetime-local` input for a `YYYY-MM-DD HH:MM[:SS]` string. */
const toInput = (value: string | undefined): string =>
    value ? value.trim().replace(' ', 'T').slice(0, 16) : '';

const STATUS: { value: EventStatus; label: string }[] = [
    { value: 'ENABLE', label: 'Enabled' },
    { value: 'DISABLE', label: 'Disabled' },
    { value: 'DISABLE ON SLAVE', label: 'Disabled on replicas' },
];

/**
 * Creates or edits a scheduled event through a form: a name, a schedule built from date and time
 * pickers and an interval, its status and what happens when it finishes, and the body in a code
 * editor. The user never writes `ON SCHEDULE EVERY …`; the statement is generated and previewed.
 */
export function EventEditor({ id }: { id: string }) {
    const { tab, engine, profileId } = useEditorTab(id);
    const profile = useMemo(() => relationalProfileOf(engine), [engine]);
    const { dialect } = profile;
    const [model, setModel] = useAdminTabState<EventModel>(id, 'event', () =>
        newEventModel({ database: tab?.database }),
    );
    const { save, cancel } = useSaveObject(id, profileId);
    const design = model.design;
    const edit = (patch: Partial<EventDesign>) =>
        setModel((current) => ({ ...current, design: { ...current.design, ...patch } }));

    const databases = useMetaNames(profileId, 'databases', {});
    const problems = useMemo(() => validateEvent(design), [design]);
    const statements = useMemo(() => {
        if (problems.length > 0) return [];
        return model.mode === 'edit'
            ? alterEventSql(dialect, design)
            : createEventSql(dialect, design);
    }, [dialect, design, model.mode, problems]);
    const interval = design.interval ?? { every: 1, unit: 'DAY' as EventIntervalUnit };

    return (
        <EditorShell
            testId="event-editor"
            header={
                <>
                    <TextInput
                        size="xs"
                        aria-label="Event name"
                        placeholder="event_name"
                        value={design.name}
                        onChange={(event) => edit({ name: event.target.value })}
                        className="w-64"
                    />
                    <Text size="xs" className="text-dimmed">
                        {model.mode === 'create' ? 'New event' : 'Editing event'}
                    </Text>
                </>
            }
            problems={design.name || design.body ? problems : []}
            statements={statements}
            saveLabel={model.mode === 'create' ? 'Create event' : 'Save event'}
            onSave={() => {
                if (problems.length > 0 || statements.length === 0) return;
                save(
                    `${model.mode === 'create' ? 'Create' : 'Save'} event ${design.name}?`,
                    statements,
                    model.mode === 'create' ? 'Event created.' : 'Event saved.',
                    model.mode === 'edit'
                        ? 'The event is dropped and created again with the new schedule.'
                        : undefined,
                );
            }}
            onCancel={cancel}
            onFormat={() => edit({ body: formatSqlBody(design.body) })}
            onValidate={() => [...problems, ...checkSqlBody(design.body)]}
        >
            <FormSection title="General">
                <div className={FIELD_GRID}>
                    <Select
                        size="sm"
                        label="Database"
                        aria-label="Database"
                        placeholder="Choose a database"
                        value={design.database ?? null}
                        data={withCurrent(databases, design.database)}
                        onChange={(value) => edit({ database: value ?? undefined })}
                    />
                    <Select
                        size="sm"
                        label="Status"
                        aria-label="Status"
                        withCheckIcon={false}
                        value={design.status}
                        data={STATUS}
                        onChange={(value) => value && edit({ status: value as EventStatus })}
                    />
                </div>
                <TextInput
                    size="sm"
                    label="Comment"
                    aria-label="Comment"
                    value={design.comment ?? ''}
                    onChange={(event) => edit({ comment: event.target.value || undefined })}
                />
            </FormSection>

            <FormSection title="Schedule">
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Runs</span>
                    <SegmentedControl
                        size="sm"
                        aria-label="Schedule type"
                        data={[
                            { value: 'once', label: 'Once' },
                            { value: 'recurring', label: 'Recurring' },
                        ]}
                        value={design.schedule}
                        onChange={(value) =>
                            edit({
                                schedule: value as EventDesign['schedule'],
                                ...(value === 'recurring' && !design.interval
                                    ? { interval: { every: 1, unit: 'DAY' as EventIntervalUnit } }
                                    : {}),
                            })
                        }
                    />
                </div>
                <div className={FIELD_GRID}>
                    <TextInput
                        size="sm"
                        type="datetime-local"
                        step={1}
                        label={design.schedule === 'once' ? 'Run at' : 'Start'}
                        aria-label={design.schedule === 'once' ? 'Run at' : 'Start'}
                        description={
                            design.schedule === 'recurring'
                                ? 'Empty: starts when created.'
                                : undefined
                        }
                        value={toInput(design.start)}
                        onChange={(event) => edit({ start: event.target.value || undefined })}
                    />
                    {design.schedule === 'recurring' && (
                        <TextInput
                            size="sm"
                            type="datetime-local"
                            step={1}
                            label="End"
                            aria-label="End"
                            description="Empty: never ends."
                            value={toInput(design.end)}
                            onChange={(event) => edit({ end: event.target.value || undefined })}
                        />
                    )}
                </div>
                {design.schedule === 'recurring' && (
                    <div className="flex items-end gap-2">
                        <NumberInput
                            size="sm"
                            label="Every"
                            aria-label="Interval"
                            min={1}
                            step={1}
                            w={96}
                            value={interval.every}
                            onChange={(value) =>
                                edit({
                                    interval: { ...interval, every: Number(value) || 0 },
                                })
                            }
                        />
                        <Select
                            size="sm"
                            aria-label="Interval unit"
                            withCheckIcon={false}
                            value={interval.unit}
                            data={EVENT_INTERVAL_UNITS.map((unit) => ({
                                value: unit,
                                label: unit.toLowerCase(),
                            }))}
                            onChange={(value) =>
                                value &&
                                edit({
                                    interval: { ...interval, unit: value as EventIntervalUnit },
                                })
                            }
                            className="w-36"
                        />
                    </div>
                )}
                <Checkbox
                    label="Keep the event after its last run (ON COMPLETION PRESERVE)"
                    checked={design.preserve}
                    onChange={(event) => edit({ preserve: event.currentTarget.checked })}
                />
            </FormSection>

            <FormSection title="Event body">
                <BodyEditor
                    label="Event body"
                    language={dialect.language}
                    value={design.body}
                    onChange={(body) => edit({ body })}
                    hint="The statement the event runs. Several statements are wrapped in BEGIN … END for you."
                />
            </FormSection>
        </EditorShell>
    );
}
