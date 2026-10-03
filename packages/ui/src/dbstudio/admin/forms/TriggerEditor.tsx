/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useMemo } from 'react';
import {
    checkSqlBody,
    createTriggerSql,
    dropTriggerSql,
    formatSqlBody,
    relationalProfileOf,
    validateTrigger,
    type TriggerDesign,
    type TriggerEvent,
    type TriggerTiming,
} from '@httpreq/db-admin';
import { Checkbox, SegmentedControl, Select, Text, TextInput } from '../../../kit';
import { newTriggerModel, type TriggerModel } from './models';
import { BodyEditor, EditorShell, FIELD_GRID, FormSection } from './formParts';
import { useAdminTabState } from './useAdminTabState';
import { useEditorTab, useMetaNames, useSaveObject, withCurrent } from './useObjectEditor';

/**
 * Creates or edits a trigger through a form: its name, target table, timing, events and the
 * options its engine has, with a code editor only for the body. What is offered comes from the
 * engine's profile (MySQL: one event and an order against another trigger; PostgreSQL: several
 * events, INSTEAD OF, statement-level, a condition), so the form names no engine itself.
 */
export function TriggerEditor({ id }: { id: string }) {
    const { tab, engine, profileId } = useEditorTab(id);
    const profile = useMemo(() => relationalProfileOf(engine), [engine]);
    const { dialect, trigger: options } = profile;
    const [model, setModel] = useAdminTabState<TriggerModel>(id, 'trigger', () =>
        newTriggerModel({ database: tab?.database, schema: tab?.schema, table: tab?.name }),
    );
    const { save, cancel } = useSaveObject(id, profileId);
    const design = model.design;
    const edit = (patch: Partial<TriggerDesign>) =>
        setModel((current) => ({ ...current, design: { ...current.design, ...patch } }));

    const scope = profile.schemas
        ? { database: tab?.database, schema: design.schema }
        : { database: design.database };
    const places = useMetaNames(profileId, profile.schemas ? 'schemas' : 'databases', {
        database: tab?.database,
    });
    const tables = useMetaNames(profileId, 'tables', scope);
    const siblings = useMetaNames(
        profileId,
        'triggers',
        options.ordering && design.table ? scope : null,
    );
    const place = profile.schemas ? design.schema : design.database;

    const problems = useMemo(() => validateTrigger(dialect, design), [dialect, design]);
    const statements = useMemo(() => {
        if (problems.length > 0) return [];
        const create = createTriggerSql(dialect, design);
        return model.original
            ? [
                  dropTriggerSql(dialect, { ...model.original, table: model.original.table }, true),
                  ...create,
              ]
            : create;
    }, [dialect, design, model.original, problems]);

    const setEvents = (events: TriggerEvent[]) => edit({ events });
    const toggleEvent = (event: TriggerEvent, on: boolean) =>
        setEvents(
            on
                ? [...new Set([...design.events, event])]
                : design.events.filter((item) => item !== event),
        );

    return (
        <EditorShell
            testId="trigger-editor"
            header={
                <>
                    <TextInput
                        size="xs"
                        aria-label="Trigger name"
                        placeholder="trigger_name"
                        value={design.name}
                        onChange={(event) => edit({ name: event.target.value })}
                        className="w-64"
                    />
                    <Text size="xs" className="text-dimmed">
                        {model.mode === 'create' ? 'New trigger' : 'Editing trigger'}
                    </Text>
                </>
            }
            problems={design.name || design.body || design.table ? problems : []}
            statements={statements}
            saveLabel={model.mode === 'create' ? 'Create trigger' : 'Save trigger'}
            onSave={() => {
                if (problems.length > 0 || statements.length === 0) return;
                save(
                    model.mode === 'create'
                        ? `Create trigger ${design.name}?`
                        : `Save trigger ${design.name}?`,
                    statements,
                    model.mode === 'create' ? 'Trigger created.' : 'Trigger saved.',
                    model.original
                        ? 'The trigger is dropped and created again with the new definition.'
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
                        label={profile.schemas ? 'Schema' : 'Database'}
                        aria-label={profile.schemas ? 'Schema' : 'Database'}
                        placeholder={profile.schemas ? 'Choose a schema' : 'Choose a database'}
                        value={place ?? null}
                        data={withCurrent(places, place)}
                        onChange={(value) =>
                            edit(
                                profile.schemas
                                    ? { schema: value ?? undefined, table: '' }
                                    : { database: value ?? undefined, table: '' },
                            )
                        }
                    />
                    <Select
                        size="sm"
                        label="Target table"
                        aria-label="Target table"
                        placeholder="Choose a table"
                        value={design.table || null}
                        data={withCurrent(tables, design.table)}
                        onChange={(value) => edit({ table: value ?? '' })}
                    />
                </div>
            </FormSection>

            <FormSection title="Timing and event">
                <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium">Timing</span>
                        <SegmentedControl
                            size="sm"
                            aria-label="Timing"
                            data={options.timings}
                            value={design.timing}
                            onChange={(value) => edit({ timing: value as TriggerTiming })}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium">
                            {options.multipleEvents ? 'Events' : 'Event'}
                        </span>
                        {options.multipleEvents ? (
                            <div role="group" aria-label="Events" className="flex flex-wrap gap-3">
                                {options.events.map((event) => (
                                    <Checkbox
                                        key={event}
                                        label={event}
                                        checked={design.events.includes(event)}
                                        onChange={(e) =>
                                            toggleEvent(event, e.currentTarget.checked)
                                        }
                                    />
                                ))}
                            </div>
                        ) : (
                            <SegmentedControl
                                size="sm"
                                aria-label="Event"
                                data={options.events}
                                value={design.events[0] ?? 'INSERT'}
                                onChange={(value) => setEvents([value as TriggerEvent])}
                            />
                        )}
                    </div>
                    {options.statementLevel && (
                        <div className="flex flex-col gap-1">
                            <span className="text-xs font-medium">Runs</span>
                            <SegmentedControl
                                size="sm"
                                aria-label="Runs for each"
                                data={[
                                    { value: 'ROW', label: 'For each row' },
                                    { value: 'STATEMENT', label: 'For each statement' },
                                ]}
                                value={design.forEachRow === false ? 'STATEMENT' : 'ROW'}
                                onChange={(value) => edit({ forEachRow: value === 'ROW' })}
                            />
                        </div>
                    )}
                </div>
                {options.multipleEvents && design.events.includes('UPDATE') && (
                    <TextInput
                        size="sm"
                        label="Only when these columns change"
                        aria-label="Update columns"
                        placeholder="all columns"
                        description="Comma-separated; leave empty to fire for any UPDATE."
                        value={(design.updateOf ?? []).join(', ')}
                        onChange={(event) =>
                            edit({
                                updateOf: event.target.value
                                    .split(',')
                                    .map((name) => name.trim())
                                    .filter(Boolean),
                            })
                        }
                    />
                )}
            </FormSection>

            {(options.condition || options.ordering) && (
                <FormSection title="Execution options">
                    {options.condition && (
                        <TextInput
                            size="sm"
                            label="Condition (WHEN)"
                            aria-label="Condition"
                            placeholder="NEW.status IS DISTINCT FROM OLD.status"
                            description="Only fire when this expression is true."
                            value={design.when ?? ''}
                            onChange={(event) => edit({ when: event.target.value || undefined })}
                        />
                    )}
                    {options.ordering && (
                        <div className={FIELD_GRID}>
                            <Select
                                size="sm"
                                label="Order"
                                aria-label="Order"
                                placeholder="No ordering"
                                clearable
                                value={design.order?.position ?? null}
                                data={['FOLLOWS', 'PRECEDES']}
                                onChange={(value) =>
                                    edit({
                                        order: value
                                            ? {
                                                  position: value as 'FOLLOWS' | 'PRECEDES',
                                                  trigger: design.order?.trigger ?? '',
                                              }
                                            : undefined,
                                    })
                                }
                            />
                            {design.order && (
                                <Select
                                    size="sm"
                                    label="Other trigger"
                                    aria-label="Other trigger"
                                    placeholder="Choose a trigger"
                                    value={design.order.trigger || null}
                                    data={withCurrent(
                                        siblings.filter((name) => name !== design.name),
                                        design.order.trigger,
                                    )}
                                    onChange={(value) =>
                                        edit({
                                            order: {
                                                position: design.order!.position,
                                                trigger: value ?? '',
                                            },
                                        })
                                    }
                                />
                            )}
                        </div>
                    )}
                </FormSection>
            )}

            <FormSection title="Trigger body">
                <BodyEditor
                    label="Trigger body"
                    language={dialect.language}
                    value={design.body}
                    onChange={(body) => edit({ body })}
                    hint={
                        dialect.id === 'postgresql'
                            ? `The body of the function "${design.name || 'trigger'}_fn" the trigger runs. It must return NEW, OLD or NULL.`
                            : 'The statements between BEGIN and END. Use NEW.column and OLD.column.'
                    }
                />
            </FormSection>
        </EditorShell>
    );
}
