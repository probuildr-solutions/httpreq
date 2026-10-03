/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconChevronRight, IconListTree, IconPlus } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import {
    BSON_TYPES,
    addChildField,
    alterCollectionStatements,
    createCollectionFromDesign,
    dialectProfileOf,
    duplicateFieldIn,
    flattenFields,
    jsonSchemaFromFields,
    moveFieldIn,
    newField,
    removeFieldIn,
    updateFieldIn,
    updateItemsIn,
    validateCollection,
    validationKeywords,
    validatorText,
    type BsonTypeName,
    type CollectionDesign,
    type FieldDesign,
    type FlatField,
} from '@httpreq/db-admin';
import { EditableGrid, type GridColumn } from '../../../editor/EditableGrid';
import {
    Button,
    Checkbox,
    NumberInput,
    Popover,
    Select,
    Switch,
    Text,
    TextInput,
    Tooltip,
    cx,
} from '../../../kit';
import { newCollectionModel, type CollectionModel } from './models';
import { BodyEditor, EditorShell, FIELD_GRID, FormSection, SqlPreview } from './formParts';
import { useAdminTabState } from './useAdminTabState';
import { useEditorTab, useMetaNames, useSaveObject, withCurrent } from './useObjectEditor';

const MB = 1024 * 1024;

const BSON_OPTIONS = BSON_TYPES.map((type) => ({ value: type, label: type }));

/**
 * Designs a MongoDB collection. A collection has no columns, so this is not a table designer: it
 * edits the collection's options (capped, time series, collation, clustered index) and a
 * `$jsonSchema` validator, which a nested field grid generates. Objects hold child fields and
 * arrays describe their items, so the grid is a tree. The generated `createCollection` or
 * `collMod` command is previewed before it runs.
 */
export function CollectionDesigner({ id }: { id: string }) {
    const { tab, engine, profileId } = useEditorTab(id);
    const profile = dialectProfileOf(engine);
    const features = profile?.kind === 'document' ? profile.collection : null;
    const [model, setModel] = useAdminTabState<CollectionModel>(id, 'collection', () =>
        newCollectionModel({ database: tab?.database, name: tab?.name }),
    );
    const { save, cancel } = useSaveObject(id, profileId);
    const design = model.design;
    const creating = model.mode === 'create';
    const edit = (patch: Partial<CollectionDesign>) =>
        setModel((current) => ({ ...current, design: { ...current.design, ...patch } }));
    const setFields = (fields: FieldDesign[]) => edit({ fields });

    const databases = useMetaNames(profileId, 'databases', {});
    const problems = useMemo(() => validateCollection(design), [design]);
    const statements = useMemo(() => {
        if (problems.length > 0) return [];
        return creating ? createCollectionFromDesign(design) : alterCollectionStatements(design);
    }, [design, creating, problems]);
    const schema = useMemo(
        () =>
            jsonSchemaFromFields(design.fields, {
                additionalProperties: design.additionalProperties,
            }),
        [design.fields, design.additionalProperties],
    );
    const rows = useMemo(() => flattenFields(design.fields), [design.fields]);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const visibleRows = useMemo(() => {
        const hidden = new Set<string>();
        const shown: FlatField[] = [];
        for (const row of rows) {
            if (row.parentId && (collapsed.has(row.parentId) || hidden.has(row.parentId))) {
                hidden.add(row.id);
                continue;
            }
            shown.push(row);
        }
        return shown;
    }, [rows, collapsed]);

    if (!features) return null;

    const typeOf = (row: FlatField): BsonTypeName =>
        row.kind === 'items' ? (row.field.items?.bsonType ?? 'string') : row.field.bsonType;

    const columns: GridColumn<FlatField>[] = [
        {
            id: 'field',
            header: 'Field',
            width: 'minmax(180px, 1.4fr)',
            cell: (row, { index }) => (
                <div className="flex min-w-0 items-center" style={{ paddingLeft: row.depth * 16 }}>
                    {row.canNest || (row.kind === 'field' && row.field.bsonType === 'array') ? (
                        <button
                            type="button"
                            aria-label={`${collapsed.has(row.id) ? 'Expand' : 'Collapse'} ${row.field.name || 'field'}`}
                            aria-expanded={!collapsed.has(row.id)}
                            className="grid size-5 flex-none place-items-center border-0 bg-transparent p-0 text-dimmed"
                            onClick={() =>
                                setCollapsed((current) => {
                                    const next = new Set(current);
                                    if (next.has(row.id)) next.delete(row.id);
                                    else next.add(row.id);
                                    return next;
                                })
                            }
                        >
                            <IconChevronRight
                                size={12}
                                className={cx(!collapsed.has(row.id) && 'rotate-90')}
                            />
                        </button>
                    ) : (
                        <span className="size-5 flex-none" aria-hidden />
                    )}
                    {row.kind === 'items' ? (
                        <span className="truncate px-1 text-xs text-dimmed italic">items</span>
                    ) : (
                        <TextInput
                            size="xs"
                            variant="unstyled"
                            aria-label={`Field ${index + 1} name`}
                            placeholder="field_name"
                            value={row.field.name}
                            onChange={(event) =>
                                setFields(
                                    updateFieldIn(design.fields, row.id, {
                                        name: event.target.value,
                                    }),
                                )
                            }
                        />
                    )}
                </div>
            ),
        },
        {
            id: 'type',
            header: 'BSON type',
            width: '120px',
            cell: (row, { index }) => (
                <Select
                    size="xs"
                    variant="unstyled"
                    aria-label={`Field ${index + 1} type`}
                    withCheckIcon={false}
                    value={typeOf(row)}
                    data={BSON_OPTIONS}
                    onChange={(value) => {
                        if (!value) return;
                        setFields(
                            row.kind === 'items'
                                ? updateItemsIn(design.fields, row.field.id, value as BsonTypeName)
                                : updateFieldIn(design.fields, row.id, {
                                      bsonType: value as BsonTypeName,
                                  }),
                        );
                    }}
                />
            ),
        },
        {
            id: 'required',
            header: 'Required',
            width: '72px',
            center: true,
            cell: (row, { index }) =>
                row.kind === 'items' ? null : (
                    <Checkbox
                        size="xs"
                        aria-label={`Field ${index + 1} required`}
                        checked={row.field.required}
                        onChange={(event) =>
                            setFields(
                                updateFieldIn(design.fields, row.id, {
                                    required: event.currentTarget.checked,
                                }),
                            )
                        }
                    />
                ),
        },
        {
            id: 'default',
            header: 'Default',
            width: 'minmax(80px, 0.7fr)',
            cell: (row, { index }) =>
                row.kind === 'items' ? null : (
                    <TextInput
                        size="xs"
                        variant="unstyled"
                        aria-label={`Field ${index + 1} default`}
                        placeholder="note only"
                        value={row.field.default ?? ''}
                        onChange={(event) =>
                            setFields(
                                updateFieldIn(design.fields, row.id, {
                                    default: event.target.value,
                                }),
                            )
                        }
                    />
                ),
        },
        {
            id: 'description',
            header: 'Description',
            width: 'minmax(120px, 1fr)',
            cell: (row, { index }) =>
                row.kind === 'items' ? null : (
                    <TextInput
                        size="xs"
                        variant="unstyled"
                        aria-label={`Field ${index + 1} description`}
                        value={row.field.description ?? ''}
                        onChange={(event) =>
                            setFields(
                                updateFieldIn(design.fields, row.id, {
                                    description: event.target.value,
                                }),
                            )
                        }
                    />
                ),
        },
        {
            id: 'validation',
            header: 'Validation',
            width: '96px',
            cell: (row, { index }) =>
                row.kind === 'items' ? null : (
                    <RulesEditor
                        field={row.field}
                        label={`Field ${index + 1} validation`}
                        onChange={(rules) =>
                            setFields(updateFieldIn(design.fields, row.id, { rules }))
                        }
                    />
                ),
        },
    ];

    return (
        <EditorShell
            testId="collection-designer"
            header={
                <>
                    <TextInput
                        size="xs"
                        aria-label="Collection name"
                        placeholder="collection_name"
                        value={design.name}
                        disabled={!creating}
                        onChange={(event) => edit({ name: event.target.value })}
                        className="w-64"
                    />
                    <Text size="xs" className="text-dimmed">
                        {creating ? 'New collection' : 'Editing validation'}
                    </Text>
                </>
            }
            problems={design.name || design.fields.length ? problems : []}
            statements={statements}
            saveLabel={creating ? 'Create collection' : 'Save validation'}
            onSave={() => {
                if (problems.length > 0 || statements.length === 0) return;
                save(
                    creating
                        ? `Create collection ${design.name}?`
                        : `Change validation of ${design.name}?`,
                    statements,
                    creating ? 'Collection created.' : 'Validation saved.',
                    creating
                        ? undefined
                        : 'The collection’s validation rules are replaced by these.',
                );
            }}
            onCancel={cancel}
            onValidate={() => problems}
        >
            <FormSection title="General">
                <div className={FIELD_GRID}>
                    <Select
                        size="sm"
                        label="Database"
                        aria-label="Database"
                        placeholder="Choose a database"
                        disabled={!creating}
                        value={design.database ?? null}
                        data={withCurrent(databases, design.database)}
                        onChange={(value) => edit({ database: value ?? undefined })}
                    />
                </div>
            </FormSection>

            <FormSection
                title="Collection options"
                description={
                    creating ? undefined : 'Options are fixed when a collection is created.'
                }
            >
                {features.capped && (
                    <div className="flex flex-col gap-2">
                        <Switch
                            label="Capped collection"
                            description="A fixed-size collection that overwrites its oldest documents."
                            checked={design.capped}
                            disabled={!creating || !!design.timeSeries}
                            onChange={(event) => edit({ capped: event.currentTarget.checked })}
                        />
                        {design.capped && (
                            <div className={FIELD_GRID}>
                                <NumberInput
                                    size="sm"
                                    label="Size (MB)"
                                    aria-label="Size in megabytes"
                                    min={1}
                                    disabled={!creating}
                                    value={design.sizeBytes ? design.sizeBytes / MB : ''}
                                    onChange={(value) =>
                                        edit({
                                            sizeBytes:
                                                value === '' ? undefined : Number(value) * MB,
                                        })
                                    }
                                />
                                <NumberInput
                                    size="sm"
                                    label="Maximum documents"
                                    aria-label="Maximum documents"
                                    min={1}
                                    disabled={!creating}
                                    value={design.maxDocuments ?? ''}
                                    onChange={(value) =>
                                        edit({
                                            maxDocuments: value === '' ? undefined : Number(value),
                                        })
                                    }
                                />
                            </div>
                        )}
                    </div>
                )}
                {features.timeSeries && (
                    <div className="flex flex-col gap-2">
                        <Switch
                            label="Time series"
                            description="Optimised storage for measurements over time."
                            checked={!!design.timeSeries}
                            disabled={!creating || design.capped || !!design.clusteredIndex}
                            onChange={(event) =>
                                edit({
                                    timeSeries: event.currentTarget.checked
                                        ? { timeField: '', granularity: 'seconds' }
                                        : undefined,
                                })
                            }
                        />
                        {design.timeSeries && (
                            <div className={FIELD_GRID}>
                                <TextInput
                                    size="sm"
                                    label="Time field"
                                    aria-label="Time field"
                                    placeholder="timestamp"
                                    disabled={!creating}
                                    value={design.timeSeries.timeField}
                                    onChange={(event) =>
                                        edit({
                                            timeSeries: {
                                                ...design.timeSeries!,
                                                timeField: event.target.value,
                                            },
                                        })
                                    }
                                />
                                <TextInput
                                    size="sm"
                                    label="Meta field"
                                    aria-label="Meta field"
                                    placeholder="optional"
                                    disabled={!creating}
                                    value={design.timeSeries.metaField ?? ''}
                                    onChange={(event) =>
                                        edit({
                                            timeSeries: {
                                                ...design.timeSeries!,
                                                metaField: event.target.value || undefined,
                                            },
                                        })
                                    }
                                />
                                <Select
                                    size="sm"
                                    label="Granularity"
                                    aria-label="Granularity"
                                    withCheckIcon={false}
                                    disabled={!creating}
                                    value={design.timeSeries.granularity ?? 'seconds'}
                                    data={['seconds', 'minutes', 'hours']}
                                    onChange={(value) =>
                                        value &&
                                        edit({
                                            timeSeries: {
                                                ...design.timeSeries!,
                                                granularity: value as
                                                    'seconds' | 'minutes' | 'hours',
                                            },
                                        })
                                    }
                                />
                                <NumberInput
                                    size="sm"
                                    label="Expire after (seconds)"
                                    aria-label="Expire after seconds"
                                    min={0}
                                    disabled={!creating}
                                    value={design.timeSeries.expireAfterSeconds ?? ''}
                                    onChange={(value) =>
                                        edit({
                                            timeSeries: {
                                                ...design.timeSeries!,
                                                expireAfterSeconds:
                                                    value === '' ? undefined : Number(value),
                                            },
                                        })
                                    }
                                />
                            </div>
                        )}
                    </div>
                )}
                {features.clusteredIndex && (
                    <Switch
                        label="Clustered index on _id"
                        description="Stores documents in _id order."
                        checked={!!design.clusteredIndex}
                        disabled={!creating || !!design.timeSeries}
                        onChange={(event) => edit({ clusteredIndex: event.currentTarget.checked })}
                    />
                )}
                {features.collation && (
                    <div className={FIELD_GRID}>
                        <TextInput
                            size="sm"
                            label="Collation locale"
                            aria-label="Collation locale"
                            placeholder="default (binary)"
                            disabled={!creating}
                            value={design.collation?.locale ?? ''}
                            onChange={(event) =>
                                edit({
                                    collation: event.target.value
                                        ? {
                                              locale: event.target.value,
                                              strength: design.collation?.strength,
                                          }
                                        : undefined,
                                })
                            }
                        />
                        {design.collation && (
                            <Select
                                size="sm"
                                label="Strength"
                                aria-label="Collation strength"
                                withCheckIcon={false}
                                disabled={!creating}
                                value={String(design.collation.strength ?? 3)}
                                data={[
                                    { value: '1', label: '1 · base letters' },
                                    { value: '2', label: '2 · ignore case' },
                                    { value: '3', label: '3 · default' },
                                    { value: '4', label: '4 · punctuation' },
                                    { value: '5', label: '5 · identical' },
                                ]}
                                onChange={(value) =>
                                    value &&
                                    edit({
                                        collation: {
                                            ...design.collation!,
                                            strength: Number(value),
                                        },
                                    })
                                }
                            />
                        )}
                    </div>
                )}
            </FormSection>

            {features.validation && (
                <FormSection
                    title="Validation schema"
                    description="Documents that do not match are rejected or logged. Fields can nest; an array describes its items."
                >
                    <div className={FIELD_GRID}>
                        <Select
                            size="sm"
                            label="Validation level"
                            aria-label="Validation level"
                            withCheckIcon={false}
                            value={design.validationLevel}
                            data={[
                                { value: 'strict', label: 'Strict · all inserts and updates' },
                                {
                                    value: 'moderate',
                                    label: 'Moderate · only valid existing documents',
                                },
                                { value: 'off', label: 'Off' },
                            ]}
                            onChange={(value) =>
                                value &&
                                edit({
                                    validationLevel: value as CollectionDesign['validationLevel'],
                                })
                            }
                        />
                        <Select
                            size="sm"
                            label="When a document is invalid"
                            aria-label="Validation action"
                            withCheckIcon={false}
                            value={design.validationAction}
                            data={[
                                { value: 'error', label: 'Reject the write' },
                                { value: 'warn', label: 'Allow it and log a warning' },
                            ]}
                            onChange={(value) =>
                                value &&
                                edit({
                                    validationAction: value as CollectionDesign['validationAction'],
                                })
                            }
                        />
                    </div>
                    <Switch
                        label="Allow fields that are not listed"
                        checked={design.additionalProperties}
                        disabled={model.handWritten}
                        onChange={(event) =>
                            edit({ additionalProperties: event.currentTarget.checked })
                        }
                    />
                    <Switch
                        label="Write the validator by hand"
                        description="Replaces the fields below with a validator you write."
                        checked={model.handWritten}
                        onChange={(event) => {
                            const on = event.currentTarget.checked;
                            setModel((current) => ({
                                ...current,
                                handWritten: on,
                                design: {
                                    ...current.design,
                                    customValidator: on
                                        ? (validatorText(current.design) ??
                                          '{ $jsonSchema: { bsonType: "object" } }')
                                        : undefined,
                                },
                            }));
                        }}
                    />
                    {model.handWritten ? (
                        <BodyEditor
                            label="Validator"
                            language="javascript"
                            value={design.customValidator ?? ''}
                            onChange={(customValidator) => edit({ customValidator })}
                            height="h-48"
                        />
                    ) : (
                        <>
                            <EditableGrid
                                label="Fields"
                                rows={visibleRows}
                                columns={columns}
                                onChange={() => undefined}
                                onRemoveRow={(row) =>
                                    setFields(removeFieldIn(design.fields, row.id))
                                }
                                onCopyRow={(row) =>
                                    setFields(duplicateFieldIn(design.fields, row.id))
                                }
                                onMoveRow={(row, _index, delta) =>
                                    setFields(moveFieldIn(design.fields, row.id, delta))
                                }
                                canRemove={(row) => row.kind === 'field'}
                                canMove={(row) => row.kind === 'field'}
                                rowLabel={(row, index) =>
                                    row.kind === 'items'
                                        ? `Items of ${row.field.name || 'array'}`
                                        : `Field ${row.field.name || index + 1}`
                                }
                                rowActions={(row) =>
                                    row.canNest ? (
                                        <Tooltip label="Add a child field">
                                            <button
                                                type="button"
                                                aria-label={`Add a field inside ${row.kind === 'items' ? 'items' : row.field.name || 'field'}`}
                                                className="grid size-[22px] place-items-center rounded-sm border-0 bg-transparent p-0 text-dimmed hover:bg-hover hover:text-fg"
                                                onClick={() =>
                                                    setFields(
                                                        addChildField(
                                                            design.fields,
                                                            row.kind === 'items'
                                                                ? row.id
                                                                : row.field.id,
                                                        ),
                                                    )
                                                }
                                            >
                                                <IconListTree size={13} />
                                            </button>
                                        </Tooltip>
                                    ) : null
                                }
                                emptyText="No fields. Without any, documents are not validated."
                            />
                            <Button
                                size="compact-sm"
                                variant="light"
                                leftSection={<IconPlus size={13} />}
                                onClick={() =>
                                    setFields(addChildField(design.fields, null, newField()))
                                }
                                className="self-start"
                            >
                                Add field
                            </Button>
                            <details className="text-xs">
                                <summary className="cursor-pointer text-dimmed">
                                    Generated JSON Schema
                                </summary>
                                <SqlPreview
                                    className="mt-1"
                                    statements={schema ? [JSON.stringify(schema, null, 2)] : []}
                                    empty="No schema: add a named field."
                                />
                            </details>
                        </>
                    )}
                </FormSection>
            )}
        </EditorShell>
    );
}

/** The validation keywords of one field's type, in a popover: min/max, pattern, allowed values. */
function RulesEditor({
    field,
    label,
    onChange,
}: {
    field: FieldDesign;
    label: string;
    onChange: (rules: Record<string, string>) => void;
}) {
    const [open, setOpen] = useState(false);
    const keywords = validationKeywords(field.bsonType);
    const count = keywords.filter((keyword) => field.rules[keyword.key]?.trim()).length;
    return (
        <Popover
            opened={open}
            onClose={() => setOpen(false)}
            position="bottom-start"
            width={260}
            closeOnClickOutside
        >
            <Popover.Target>
                <Button
                    size="compact-xs"
                    variant="subtle"
                    aria-label={label}
                    aria-expanded={open}
                    disabled={keywords.length === 0}
                    onClick={() => setOpen((value) => !value)}
                >
                    {keywords.length === 0
                        ? 'None'
                        : count
                          ? `${count} rule${count === 1 ? '' : 's'}`
                          : 'Add rules'}
                </Button>
            </Popover.Target>
            <Popover.Dropdown className="flex flex-col gap-2 p-2">
                {keywords.map((keyword) =>
                    keyword.key === 'uniqueItems' ? (
                        <Checkbox
                            key={keyword.key}
                            label={keyword.label}
                            checked={field.rules[keyword.key] === 'true'}
                            onChange={(event) =>
                                onChange({
                                    ...field.rules,
                                    [keyword.key]: event.currentTarget.checked ? 'true' : '',
                                })
                            }
                        />
                    ) : (
                        <TextInput
                            key={keyword.key}
                            size="xs"
                            label={keyword.label}
                            aria-label={keyword.label}
                            description={keyword.kind === 'list' ? 'Comma-separated.' : undefined}
                            value={field.rules[keyword.key] ?? ''}
                            onChange={(event) =>
                                onChange({ ...field.rules, [keyword.key]: event.target.value })
                            }
                        />
                    ),
                )}
            </Popover.Dropdown>
        </Popover>
    );
}
