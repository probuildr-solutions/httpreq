/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect, useMemo, useState } from 'react';
import { capabilitiesOf } from '@httpreq/db-admin';
import type {
    DbExportFormat,
    DbExportRequest,
    DbImportFormat,
    DbImportRequest,
    DbScriptTaskRequest,
    DbTableInfo,
} from '@httpreq/shared';
import { AppModal } from '../../AppModal';
import { formatSize } from '../../format';
import {
    Alert,
    Button,
    Checkbox,
    NumberInput,
    Select,
    Text,
    TextInput,
    notifications,
} from '../../kit';
import { closeAdminDialog } from '../admin/dialogStore';
import { layoutOf } from '../db/engines';
import { useProfiles } from '../db/profiles';
import { useDbManager } from '../db/useDbManager';
import { useDbStudio } from '../useDbStudio';
import { newTaskId, rememberTaskRequest, setTaskCenterOpen } from './taskStore';

const FORMAT_LABEL: Record<string, string> = {
    csv: 'CSV (comma separated values)',
    json: 'JSON (one array)',
    ndjson: 'NDJSON / JSON Lines (one document per line)',
    sql: 'SQL (INSERT statements)',
    bson: 'BSON (MongoDB dump)',
};

const DELIMITERS = [
    { value: ',', label: 'Comma ( , )' },
    { value: ';', label: 'Semicolon ( ; )' },
    { value: '\t', label: 'Tab' },
    { value: '|', label: 'Pipe ( | )' },
];

const started = (message: string) => {
    notifications.show({ color: 'teal', message, autoClose: 4000 });
    setTaskCenterOpen(true);
};

/** Choose a format and options, then start an export as a background task. */
export function ExportDialog({
    profileId,
    source,
}: {
    profileId: string;
    source: DbExportRequest['source'];
}) {
    const manager = useDbManager();
    const profile = useProfiles((s) => s.profiles.find((p) => p.id === profileId));
    const engine = profile?.settings.engine ?? 'mysql';
    const formats = capabilitiesOf(engine).exportFormats.filter(
        // SQL INSERTs only make sense for a table's rows.
        (f) => f !== 'sql' || source.kind === 'table',
    );
    const [format, setFormat] = useState<DbExportFormat>((formats[0] as DbExportFormat) ?? 'csv');
    const [delimiter, setDelimiter] = useState(',');
    const [header, setHeader] = useState(true);
    const [bom, setBom] = useState(false);
    const [nullText, setNullText] = useState('');
    const [rows, setRows] = useState<number | string>(100);
    const [create, setCreate] = useState(true);
    const [drop, setDrop] = useState(false);
    const [fetchSize, setFetchSize] = useState<number | string>(1000);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const label = source.kind === 'table' ? source.name : (source.label ?? 'query');

    const start = async () => {
        if (!manager.db) return;
        setBusy(true);
        setError(null);
        const request: DbExportRequest = {
            connectionId: profileId,
            taskId: newTaskId(),
            source,
            format,
            fetchSize: Number(fetchSize) || 1000,
            suggestedName: label,
            ...(format === 'csv' ? { csv: { delimiter, header, bom, nullText } } : {}),
            ...(format === 'sql'
                ? {
                      sql: {
                          rowsPerStatement: Number(rows) || 100,
                          includeCreate: create,
                          includeDrop: drop,
                      },
                  }
                : {}),
        };
        try {
            if (!(await manager.connect(profileId)))
                throw new Error('Could not connect to the database.');
            const result = await manager.db.startExport(request);
            if (result.started) {
                rememberTaskRequest(request.taskId, 'export', request);
                closeAdminDialog();
                started(`Export of ${label} started.`);
            } else setBusy(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };

    return (
        <AppModal
            opened
            onClose={closeAdminDialog}
            title={`Export ${label}`}
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={closeAdminDialog}>
                        Cancel
                    </Button>
                    <Button size="xs" loading={busy} onClick={() => void start()}>
                        Choose a file and start…
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <Select
                    label="Format"
                    value={format}
                    data={formats.map((f) => ({ value: f, label: FORMAT_LABEL[f] ?? f }))}
                    onChange={(v) => v && setFormat(v as DbExportFormat)}
                />
                {format === 'csv' && (
                    <>
                        <Select
                            label="Delimiter"
                            value={delimiter}
                            data={DELIMITERS}
                            onChange={(v) => setDelimiter(v ?? ',')}
                        />
                        <Checkbox
                            label="First line holds the column names"
                            checked={header}
                            onChange={(e) => setHeader(e.currentTarget.checked)}
                        />
                        <Select
                            label="Write NULL as"
                            description="CSV cannot tell an empty value from NULL unless NULL is written as something else; the importer can read it back."
                            value={nullText}
                            data={[
                                { value: '', label: 'An empty field' },
                                { value: 'NULL', label: 'NULL' },
                                { value: '\\N', label: 'A backslash and N (as MySQL dumps do)' },
                            ]}
                            onChange={(v) => setNullText(v ?? '')}
                        />
                        <Checkbox
                            label="Add a byte order mark (Excel needs it for accented text)"
                            checked={bom}
                            onChange={(e) => setBom(e.currentTarget.checked)}
                        />
                    </>
                )}
                {format === 'sql' && (
                    <>
                        <NumberInput
                            label="Rows per INSERT statement"
                            min={1}
                            max={10000}
                            value={rows}
                            onChange={setRows}
                        />
                        <Checkbox
                            label="Include the CREATE TABLE statement"
                            checked={create}
                            onChange={(e) => setCreate(e.currentTarget.checked)}
                        />
                        <Checkbox
                            label="Add DROP TABLE IF EXISTS before it"
                            checked={drop}
                            onChange={(e) => setDrop(e.currentTarget.checked)}
                        />
                    </>
                )}
                <NumberInput
                    label="Rows fetched at a time"
                    description="Larger is faster; smaller uses less memory. The file is written as the rows arrive, so its size does not matter."
                    min={1}
                    max={100000}
                    value={fetchSize}
                    onChange={setFetchSize}
                />
                <Text size="xs" className="text-dimmed">
                    The export runs in the background on its own connection. You can keep working
                    and cancel it from the task list.
                </Text>
                {error && <Alert color="red">{error}</Alert>}
            </div>
        </AppModal>
    );
}

const formatOf = (name: string): DbImportFormat | null => {
    const ext = name.toLowerCase().split('.').pop();
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
    if (ext === 'ndjson' || ext === 'jsonl') return 'ndjson';
    if (ext === 'json') return 'json';
    if (ext === 'bson') return 'bson';
    return null;
};

/** Choose a file, a target and how to handle errors, then start an import as a background task. */
export function ImportDialog({
    profileId: initialProfile,
    target: initialTarget,
    file: initialFile,
}: {
    profileId: string | null;
    target?: { database?: string; schema?: string; name: string };
    file?: { token: string; name: string; size: number };
}) {
    const manager = useDbManager();
    const studio = useDbStudio();
    const profiles = useProfiles((s) => s.profiles);
    const [profileId, setProfileId] = useState<string | null>(initialProfile);
    const [file, setFile] = useState(initialFile ?? null);
    const [format, setFormat] = useState<DbImportFormat>(
        formatOf(initialFile?.name ?? '') ?? 'csv',
    );
    const [database, setDatabase] = useState(initialTarget?.database ?? '');
    const [schema, setSchema] = useState(initialTarget?.schema ?? '');
    const [name, setName] = useState(initialTarget?.name ?? '');
    const [databases, setDatabases] = useState<string[]>([]);
    const [schemas, setSchemas] = useState<string[]>([]);
    const [tables, setTables] = useState<string[]>([]);
    const [mode, setMode] = useState<'append' | 'truncate'>('append');
    const [batch, setBatch] = useState<number | string>(500);
    const [onError, setOnError] = useState<'stop' | 'skip'>('stop');
    const [transaction, setTransaction] = useState<'none' | 'batch' | 'all'>('batch');
    const [delimiter, setDelimiter] = useState('');
    const [header, setHeader] = useState(true);
    const [nullToken, setNullToken] = useState('');
    const [emptyAsNull, setEmptyAsNull] = useState(false);
    const [saveRejects, setSaveRejects] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const profile = profiles.find((p) => p.id === profileId);
    const engine = profile?.settings.engine ?? 'mysql';
    const caps = capabilitiesOf(engine);
    const formats = caps.importFormats.filter((f): f is DbImportFormat => f !== 'sql');
    const hasSchemas = layoutOf(engine).schemas;
    const mongo = engine === 'mongodb';
    const { listMeta } = manager;

    useEffect(() => {
        if (!profileId) return;
        let off = false;
        void listMeta(profileId, 'databases')
            .then(
                (items) =>
                    !off &&
                    setDatabases(
                        (items as { name: string; system: boolean }[])
                            .filter((d) => !d.system)
                            .map((d) => d.name),
                    ),
            )
            .catch(() => undefined);
        return () => {
            off = true;
        };
    }, [profileId, listMeta]);

    useEffect(() => {
        if (!profileId || !hasSchemas || !database) return setSchemas([]);
        let off = false;
        void listMeta(profileId, 'schemas', { database })
            .then((items) => !off && setSchemas((items as { name: string }[]).map((s) => s.name)))
            .catch(() => undefined);
        return () => {
            off = true;
        };
    }, [profileId, hasSchemas, database, listMeta]);

    useEffect(() => {
        if (!profileId || !database || (hasSchemas && !schema)) return setTables([]);
        let off = false;
        void listMeta(profileId, 'tables', { database, ...(hasSchemas ? { schema } : {}) })
            .then(
                (items) =>
                    !off &&
                    setTables(
                        (items as DbTableInfo[])
                            .filter((t) => t.kind === 'table')
                            .map((t) => t.name),
                    ),
            )
            .catch(() => undefined);
        return () => {
            off = true;
        };
    }, [profileId, database, schema, hasSchemas, listMeta]);

    const choose = async () => {
        const picked = await studio.pickFile();
        if (!picked) return;
        setFile(picked);
        const guess = formatOf(picked.name);
        if (guess) setFormat(guess);
    };

    const valid =
        !!profileId &&
        !!file &&
        database !== '' &&
        name.trim() !== '' &&
        (!hasSchemas || schema !== '') &&
        formats.includes(format);
    const batchHint = useMemo(
        () =>
            transaction === 'all'
                ? 'The whole file is one transaction: any error undoes everything, and the import cannot be resumed.'
                : transaction === 'batch'
                  ? 'Each batch is its own transaction.'
                  : 'Each statement stands alone.',
        [transaction],
    );

    const start = async () => {
        if (!manager.db || !profileId || !file) return;
        setBusy(true);
        setError(null);
        const request: DbImportRequest = {
            connectionId: profileId,
            taskId: newTaskId(),
            fileToken: file.token,
            format,
            target: { database, ...(hasSchemas ? { schema } : {}), name: name.trim() },
            mode,
            batchSize: Number(batch) || 500,
            onError,
            transaction: mongo ? 'none' : transaction,
            saveRejects,
            ...(format === 'csv'
                ? {
                      csv: {
                          header,
                          ...(delimiter ? { delimiter } : {}),
                          ...(nullToken ? { nullToken } : {}),
                          emptyAsNull,
                      },
                  }
                : {}),
        };
        try {
            if (!(await manager.connect(profileId)))
                throw new Error('Could not connect to the database.');
            if (mode === 'truncate') {
                // Emptying a table is not undone by an error later, so it is said plainly first.
                const { confirmAction } = await import('../../confirm');
                const answer = await confirmAction({
                    title: `Delete the existing rows of ${name.trim()}?`,
                    message:
                        'The table is emptied before the file is imported. This cannot be undone.',
                    confirmLabel: 'Delete rows and import',
                    danger: true,
                });
                if (answer !== 'confirm') return setBusy(false);
            }
            const result = await manager.db.startImport(request);
            if (result.started) {
                rememberTaskRequest(request.taskId, 'import', request);
                closeAdminDialog();
                started(`Import of ${file.name} started.`);
            } else setBusy(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };

    return (
        <AppModal
            opened
            onClose={closeAdminDialog}
            title={`Import into ${mongo ? 'a collection' : 'a table'}`}
            size="lg"
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={closeAdminDialog}>
                        Cancel
                    </Button>
                    <Button size="xs" loading={busy} disabled={!valid} onClick={() => void start()}>
                        Start import
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                        <div className="mb-1 text-sm font-medium">File</div>
                        <div className="truncate rounded-sm border border-line px-2 py-1.5 text-sm">
                            {file ? `${file.name} · ${formatSize(file.size)}` : 'No file chosen'}
                        </div>
                    </div>
                    <Button size="xs" variant="light" onClick={() => void choose()}>
                        Choose…
                    </Button>
                </div>
                <Select
                    label="Connection"
                    value={profileId}
                    data={profiles.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(v) => {
                        setProfileId(v);
                        setDatabase('');
                        setSchema('');
                        setName('');
                    }}
                />
                <div className="grid grid-cols-3 gap-2">
                    <Select
                        label="Database"
                        placeholder="Choose"
                        value={database || null}
                        data={databases.map((d) => ({ value: d, label: d }))}
                        onChange={(v) => {
                            setDatabase(v ?? '');
                            setSchema('');
                            setName(initialTarget?.name ?? '');
                        }}
                    />
                    {hasSchemas ? (
                        <Select
                            label="Schema"
                            placeholder="Choose"
                            value={schema || null}
                            data={schemas.map((d) => ({ value: d, label: d }))}
                            onChange={(v) => setSchema(v ?? '')}
                        />
                    ) : (
                        <div />
                    )}
                    {mongo ? (
                        <TextInput
                            label="Collection"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    ) : (
                        <Select
                            label="Table"
                            placeholder="Choose"
                            value={name || null}
                            data={tables.map((d) => ({ value: d, label: d }))}
                            onChange={(v) => setName(v ?? '')}
                        />
                    )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <Select
                        label="File format"
                        value={format}
                        data={formats.map((f) => ({ value: f, label: FORMAT_LABEL[f] ?? f }))}
                        onChange={(v) => v && setFormat(v as DbImportFormat)}
                    />
                    <Select
                        label="Existing rows"
                        value={mode}
                        data={[
                            { value: 'append', label: 'Keep them; add the new rows' },
                            { value: 'truncate', label: 'Delete them first' },
                        ]}
                        onChange={(v) => v && setMode(v as 'append' | 'truncate')}
                    />
                </div>
                {format === 'csv' && (
                    <div className="grid grid-cols-2 gap-2">
                        <Select
                            label="Delimiter"
                            value={delimiter}
                            data={[{ value: '', label: 'Detect from the file' }, ...DELIMITERS]}
                            onChange={(v) => setDelimiter(v ?? '')}
                        />
                        <TextInput
                            label="Text that means NULL"
                            placeholder="for example NULL or \N"
                            value={nullToken}
                            onChange={(e) => setNullToken(e.target.value)}
                        />
                        <Checkbox
                            label="First line holds the column names"
                            checked={header}
                            onChange={(e) => setHeader(e.currentTarget.checked)}
                        />
                        <Checkbox
                            label="Treat empty text as NULL"
                            checked={emptyAsNull}
                            onChange={(e) => setEmptyAsNull(e.currentTarget.checked)}
                        />
                    </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                    <NumberInput
                        label={mongo ? 'Documents per batch' : 'Rows per batch'}
                        min={1}
                        max={50000}
                        value={batch}
                        onChange={setBatch}
                    />
                    <Select
                        label="When a record fails"
                        value={onError}
                        data={[
                            { value: 'stop', label: 'Stop the import' },
                            { value: 'skip', label: 'Skip it and carry on' },
                        ]}
                        onChange={(v) => v && setOnError(v as 'stop' | 'skip')}
                    />
                </div>
                {!mongo && (
                    <Select
                        label="Transactions"
                        description={batchHint}
                        value={transaction}
                        data={[
                            { value: 'batch', label: 'One per batch' },
                            { value: 'all', label: 'One for the whole import' },
                            { value: 'none', label: 'None' },
                        ]}
                        onChange={(v) => v && setTransaction(v as 'none' | 'batch' | 'all')}
                    />
                )}
                <Checkbox
                    label="Save rejected records to a file beside the original"
                    checked={saveRejects}
                    onChange={(e) => setSaveRejects(e.currentTarget.checked)}
                />
                <Text size="xs" className="text-dimmed">
                    The file is read in pieces and written in batches on its own connection, so its
                    size does not matter and you can keep working.
                </Text>
                {error && <Alert color="red">{error}</Alert>}
            </div>
        </AppModal>
    );
}

/** Run an SQL file as a background task: streamed statement by statement, never loaded whole. */
export function ScriptDialog({
    profileId: initialProfile,
    file,
}: {
    profileId: string | null;
    file: { token: string; name: string; size: number };
}) {
    const manager = useDbManager();
    const profiles = useProfiles((s) => s.profiles).filter((p) =>
        ['mysql', 'postgresql'].includes(p.settings.engine),
    );
    const [profileId, setProfileId] = useState<string | null>(initialProfile);
    const [onError, setOnError] = useState<'stop' | 'continue'>('stop');
    const [transaction, setTransaction] = useState<'none' | 'single'>('none');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const profile = profiles.find((p) => p.id === profileId);

    const start = async () => {
        if (!manager.db || !profile) return;
        setBusy(true);
        const request: DbScriptTaskRequest = {
            connectionId: profile.id,
            taskId: newTaskId(),
            fileToken: file.token,
            dialect: profile.settings.engine as 'mysql' | 'postgresql',
            onError,
            transaction,
        };
        try {
            if (!(await manager.connect(profile.id)))
                throw new Error('Could not connect to the database.');
            const result = await manager.db.startScriptTask(request);
            if (result.started) {
                rememberTaskRequest(request.taskId, 'script', request);
                closeAdminDialog();
                started(`Running ${file.name}.`);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <AppModal
            opened
            onClose={closeAdminDialog}
            title={`Execute ${file.name}`}
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={closeAdminDialog}>
                        Cancel
                    </Button>
                    <Button
                        size="xs"
                        loading={busy}
                        disabled={!profile}
                        onClick={() => void start()}
                    >
                        Execute
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <Text size="sm">
                    {formatSize(file.size)} of SQL, read and run one statement at a time. Nothing is
                    loaded into an editor.
                </Text>
                <Select
                    label="Connection"
                    value={profileId}
                    data={profiles.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={setProfileId}
                />
                <Select
                    label="When a statement fails"
                    value={onError}
                    data={[
                        { value: 'stop', label: 'Stop' },
                        { value: 'continue', label: 'Carry on with the next one' },
                    ]}
                    onChange={(v) => v && setOnError(v as 'stop' | 'continue')}
                />
                <Select
                    label="Transaction"
                    description={
                        transaction === 'single'
                            ? 'Everything is committed at the end, or rolled back if a statement fails.'
                            : 'Each statement is committed as it runs.'
                    }
                    value={transaction}
                    data={[
                        { value: 'none', label: 'None (autocommit)' },
                        { value: 'single', label: 'One transaction for the whole file' },
                    ]}
                    onChange={(v) => v && setTransaction(v as 'none' | 'single')}
                />
                {error && <Alert color="red">{error}</Alert>}
            </div>
        </AppModal>
    );
}
