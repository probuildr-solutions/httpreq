/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useMemo } from 'react';
import {
    checkSqlBody,
    createRoutineSql,
    findType,
    formatSqlBody,
    relationalProfileOf,
    validateRoutine,
} from '@httpreq/db-admin';
import { EditableGrid, type GridColumn } from '../../../editor/EditableGrid';
import { Checkbox, Select, Text, TextInput } from '../../../kit';
import {
    newParameter,
    newRoutineModel,
    rowId,
    routineDesignOf,
    type ParameterRow,
    type RoutineModel,
} from './models';
import { BodyEditor, EditorShell, FIELD_GRID, FormSection } from './formParts';
import { TypeSelect } from './TypeSelect';
import { useAdminTabState } from './useAdminTabState';
import { useEditorTab, useMetaNames, useSaveObject, withCurrent } from './useObjectEditor';

/**
 * Creates or edits a stored procedure or function through a form: general details, an editable
 * parameter table (like the request headers table), the body in a code editor, and the options the
 * engine has. Parameter modes, languages, defaults, ownership and the rest come from the engine's
 * profile.
 */
export function RoutineEditor({ id, kind }: { id: string; kind: 'function' | 'procedure' }) {
    const { tab, engine, profileId } = useEditorTab(id);
    const profile = useMemo(() => relationalProfileOf(engine), [engine]);
    const { dialect } = profile;
    const options = kind === 'function' ? profile.function : profile.procedure;
    const [model, setModel] = useAdminTabState<RoutineModel>(id, 'routine', () =>
        newRoutineModel(kind, { database: tab?.database, schema: tab?.schema }),
    );
    const { save, cancel } = useSaveObject(id, profileId);
    const edit = (patch: Partial<RoutineModel>) =>
        setModel((current) => ({ ...current, ...patch }));

    const places = useMetaNames(profileId, profile.schemas ? 'schemas' : 'databases', {
        database: tab?.database,
    });
    const place = profile.schemas ? model.schema : model.database;

    const design = useMemo(() => routineDesignOf(model), [model]);
    const problems = useMemo(() => validateRoutine(dialect, design), [dialect, design]);
    const statements = useMemo(
        () => (problems.length > 0 ? [] : createRoutineSql(dialect, design, { replace: true })),
        [dialect, design, problems],
    );

    const columns: GridColumn<ParameterRow>[] = [
        {
            id: 'name',
            header: 'Name',
            width: 'minmax(120px, 1fr)',
            cell: (row, { index, update }) => (
                <TextInput
                    size="xs"
                    variant="unstyled"
                    aria-label={`Parameter ${index + 1} name`}
                    placeholder="name"
                    value={row.name}
                    onChange={(event) => update({ name: event.target.value })}
                />
            ),
        },
        {
            id: 'mode',
            header: 'Mode',
            width: '88px',
            cell: (row, { index, update }) => (
                <Select
                    size="xs"
                    variant="unstyled"
                    aria-label={`Parameter ${index + 1} mode`}
                    withCheckIcon={false}
                    value={row.mode}
                    data={options.modes}
                    onChange={(value) => value && update({ mode: value as ParameterRow['mode'] })}
                />
            ),
        },
        {
            id: 'type',
            header: 'Data type',
            width: 'minmax(140px, 1.2fr)',
            cell: (row, { index, update }) => (
                <TypeSelect
                    inCell
                    catalog={dialect.typeCatalog}
                    ariaLabel={`Parameter ${index + 1} data type`}
                    value={row.dataType}
                    onChange={(dataType) => update({ dataType })}
                />
            ),
        },
        {
            id: 'length',
            header: 'Length / precision',
            width: '120px',
            cell: (row, { index, update }) => {
                const takes = findType(dialect.typeCatalog, row.dataType)?.params ?? 'none';
                return (
                    <TextInput
                        size="xs"
                        variant="unstyled"
                        aria-label={`Parameter ${index + 1} length`}
                        placeholder={
                            takes === 'precisionScale' ? '10,2' : takes === 'none' ? '' : '255'
                        }
                        disabled={takes === 'none'}
                        value={row.length}
                        onChange={(event) => update({ length: event.target.value })}
                    />
                );
            },
        },
        {
            id: 'default',
            header: 'Default',
            width: 'minmax(90px, 0.8fr)',
            hidden: !options.parameterDefaults,
            cell: (row, { index, update }) => (
                <TextInput
                    size="xs"
                    variant="unstyled"
                    aria-label={`Parameter ${index + 1} default`}
                    placeholder="expression"
                    disabled={row.mode === 'OUT'}
                    value={row.default}
                    onChange={(event) => update({ default: event.target.value })}
                />
            ),
        },
    ];

    return (
        <EditorShell
            testId={`${kind}-editor`}
            header={
                <>
                    <TextInput
                        size="xs"
                        aria-label={`${kind === 'function' ? 'Function' : 'Procedure'} name`}
                        placeholder={`${kind}_name`}
                        value={model.name}
                        onChange={(event) => edit({ name: event.target.value })}
                        className="w-64"
                    />
                    <Text size="xs" className="text-dimmed">
                        {model.mode === 'create' ? `New ${kind}` : `Editing ${kind}`}
                    </Text>
                </>
            }
            problems={model.name || model.body || model.parameters.length ? problems : []}
            statements={statements}
            saveLabel={model.mode === 'create' ? `Create ${kind}` : `Save ${kind}`}
            onSave={() => {
                if (problems.length > 0 || statements.length === 0) return;
                save(
                    `${model.mode === 'create' ? 'Create' : 'Save'} ${kind} ${model.name}?`,
                    statements,
                    `${kind === 'function' ? 'Function' : 'Procedure'} ${model.mode === 'create' ? 'created' : 'saved'}.`,
                    dialect.id === 'mysql' && model.mode === 'edit'
                        ? `MySQL cannot replace a ${kind}: it is dropped and created again.`
                        : undefined,
                );
            }}
            onCancel={cancel}
            onFormat={() => edit({ body: formatSqlBody(model.body) })}
            onValidate={() => [...problems, ...checkSqlBody(model.body)]}
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
                                    ? { schema: value ?? undefined }
                                    : { database: value ?? undefined },
                            )
                        }
                    />
                    {options.languages.length > 0 && (
                        <Select
                            size="sm"
                            label="Language"
                            aria-label="Language"
                            value={model.language}
                            data={options.languages}
                            onChange={(value) => value && edit({ language: value })}
                        />
                    )}
                    {options.owner && (
                        <TextInput
                            size="sm"
                            label="Owner"
                            aria-label="Owner"
                            placeholder="current role"
                            value={model.owner}
                            onChange={(event) => edit({ owner: event.target.value })}
                        />
                    )}
                    {kind === 'function' && (
                        <div className="flex items-end gap-2">
                            <div className="min-w-0 flex-1">
                                <span className="mb-1 block text-xs font-medium">Returns</span>
                                <div className="h-[var(--control-h)] rounded-sm border border-line bg-field">
                                    <TypeSelect
                                        inCell
                                        catalog={dialect.typeCatalog}
                                        ariaLabel="Return type"
                                        placeholder="Return type"
                                        value={model.returns}
                                        onChange={(returns) => edit({ returns })}
                                    />
                                </div>
                            </div>
                            <TextInput
                                size="sm"
                                aria-label="Return length"
                                placeholder="length"
                                value={model.returnsLength}
                                onChange={(event) => edit({ returnsLength: event.target.value })}
                                className="w-24"
                            />
                        </div>
                    )}
                </div>
            </FormSection>

            <FormSection
                title="Parameters"
                description={
                    kind === 'function' && !options.modes.includes('OUT')
                        ? 'A function takes input parameters only.'
                        : undefined
                }
            >
                <EditableGrid
                    label="Parameters"
                    rows={model.parameters}
                    columns={columns}
                    onChange={(parameters) => edit({ parameters })}
                    createRow={newParameter}
                    addLabel="Add parameter"
                    copyRow={(row) => ({
                        ...row,
                        id: rowId(),
                        name: row.name ? `${row.name}_copy` : '',
                    })}
                    reorderable
                    rowLabel={(row, index) => `Parameter ${row.name || index + 1}`}
                    emptyText="No parameters."
                />
            </FormSection>

            <FormSection title={`${kind === 'function' ? 'Function' : 'Procedure'} body`}>
                <BodyEditor
                    label={`${kind === 'function' ? 'Function' : 'Procedure'} body`}
                    language={dialect.language}
                    value={model.body}
                    onChange={(body) => edit({ body })}
                    hint={
                        dialect.id === 'postgresql'
                            ? `Written in ${model.language}; it goes between the $$ markers.`
                            : 'The statements between BEGIN and END.'
                    }
                />
            </FormSection>

            <FormSection title="Additional options">
                <div className={FIELD_GRID}>
                    {options.security && (
                        <Select
                            size="sm"
                            label="Runs with the privileges of"
                            aria-label="Security"
                            placeholder="Default"
                            clearable
                            value={model.security || null}
                            data={[
                                { value: 'DEFINER', label: 'The definer' },
                                { value: 'INVOKER', label: 'The caller (invoker)' },
                            ]}
                            onChange={(value) =>
                                edit({ security: (value ?? '') as RoutineModel['security'] })
                            }
                        />
                    )}
                    {options.comment && (
                        <TextInput
                            size="sm"
                            label="Comment"
                            aria-label="Comment"
                            value={model.comment}
                            onChange={(event) => edit({ comment: event.target.value })}
                        />
                    )}
                </div>
                {options.deterministic && (
                    <Checkbox
                        label="Deterministic: the same input always gives the same result"
                        checked={model.deterministic}
                        onChange={(event) => edit({ deterministic: event.currentTarget.checked })}
                    />
                )}
            </FormSection>
        </EditorShell>
    );
}
