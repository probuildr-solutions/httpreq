/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconFileText } from '@tabler/icons-react';
import { useState } from 'react';
import { AppModal } from '../AppModal';
import { formatSize } from '../format';
import { Alert, Button, Select, Stack, Text, TextInput } from '../kit';
import { layoutOf } from './db/engines';
import { useQueries } from './db/queryStore';
import { openAdminDialog } from './admin/dialogStore';
import { useProfiles } from './db/profiles';
import { useDbManager } from './db/useDbManager';
import { handlingFor, largeFileLimits } from './largeFile';
import { useStudioStore } from './studioStore';
import { useDbStudio } from './useDbStudio';

const IMPORTABLE = new Set(['csv', 'tsv', 'txt', 'json', 'ndjson', 'jsonl', 'bson']);
const SCRIPT_EXTENSIONS = new Set(['sql', 'txt', 'js', 'json', 'ndjson', 'jsonl']);

const extensionOf = (name: string) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * What to do with a file the user just picked, asked before anything is opened. Opening it in a
 * query tab puts it in the same editor as every other statement, bound to a connection; the file
 * viewer and the preview stay available for files of any size.
 */
export function OpenFileDialog() {
    const api = useDbStudio();
    const manager = useDbManager();
    const pending = useStudioStore((state) => state.pending);
    const opening = useStudioStore((state) => state.opening);
    const error = useStudioStore((state) => state.error);
    const profiles = useProfiles((state) => state.profiles);
    const [profileId, setProfileId] = useState<string | null>(null);
    const [database, setDatabase] = useState('');
    const [schema, setSchema] = useState('');

    if (!pending) return null;

    const extension = extensionOf(pending.name);
    const profile = profiles.find((p) => p.id === profileId);
    const engine = profile?.settings.engine ?? 'mysql';
    const hasSchemas = !!profile && layoutOf(engine).schemas;
    const handling = handlingFor(pending.size);
    const small = handling !== 'stream';
    const canQuery = small && manager.available && SCRIPT_EXTENSIONS.has(extension || 'sql');

    /** Closes this dialog and continues in the dialog for executing or importing the same file. */
    const handOff = (kind: 'script' | 'import') => {
        const chosen = { token: pending.token, name: pending.name, size: pending.size };
        api.cancelPending();
        openAdminDialog(
            kind === 'script'
                ? { kind: 'script', profileId, file: chosen }
                : { kind: 'import', profileId, file: chosen },
        );
    };

    const openInQuery = async () => {
        const file = await api.readPendingText();
        if (file === null) return;
        // The tab keeps the file's token, so Save writes back to the same file.
        const id = manager.newQuery(profileId, file.text, file.name);
        useQueries.setState((state) => ({
            tabs: {
                ...state.tabs,
                [id]: {
                    ...state.tabs[id]!,
                    source: { token: file.token, name: file.name },
                    database: profile ? database.trim() || null : null,
                    schema: profile && hasSchemas ? schema.trim() || null : null,
                },
            },
        }));
    };

    return (
        <AppModal
            opened
            onClose={api.cancelPending}
            title="Open file"
            footer={
                <>
                    <Button variant="subtle" onClick={api.cancelPending} disabled={opening}>
                        Cancel
                    </Button>
                    <Button
                        variant="light"
                        disabled={opening}
                        onClick={() => void api.openPending({ preview: true })}
                    >
                        Preview
                    </Button>
                    <Button
                        variant="light"
                        disabled={opening}
                        onClick={() => void api.openPending()}
                    >
                        Open in file editor
                    </Button>
                    <Button
                        disabled={opening || !canQuery}
                        loading={opening}
                        onClick={() => void openInQuery()}
                    >
                        Open in query editor
                    </Button>
                </>
            }
        >
            <Stack gap="sm">
                <div className="flex items-center gap-3 rounded-sm border border-line px-3 py-2">
                    <IconFileText size={22} className="flex-none text-dimmed" />
                    <div className="min-w-0">
                        <Text size="sm" className="truncate font-medium" title={pending.name}>
                            {pending.name}
                        </Text>
                        <Text size="xs" className="text-dimmed">
                            {extension ? `.${extension}` : 'No extension'} ·{' '}
                            {formatSize(pending.size)}
                        </Text>
                    </div>
                </div>

                {manager.available && (
                    <>
                        <Select
                            size="xs"
                            label="Connection"
                            placeholder="None: open without running"
                            clearable
                            value={profileId}
                            data={profiles.map((p) => ({ value: p.id, label: p.name }))}
                            onChange={setProfileId}
                        />
                        <div className="grid grid-cols-2 gap-2">
                            <TextInput
                                size="xs"
                                label="Database"
                                placeholder="Optional"
                                disabled={!profile}
                                value={database}
                                onChange={(event) => setDatabase(event.target.value)}
                            />
                            <TextInput
                                size="xs"
                                label="Schema"
                                placeholder={hasSchemas ? 'Optional' : 'Not used by this engine'}
                                disabled={!hasSchemas}
                                value={schema}
                                onChange={(event) => setSchema(event.target.value)}
                            />
                        </div>
                    </>
                )}

                {handling === 'large-file-mode' && (
                    <Alert color="yellow" title="Large File Mode">
                        This file is large, so the editor opens it with highlighting, folding,
                        suggestions and other costly features switched off. Stability comes before
                        editor features.
                    </Alert>
                )}
                {!canQuery && (
                    <Alert color="blue">
                        {small
                            ? 'This type of file is opened in the file editor.'
                            : `Files over ${formatSize(largeFileLimits().monacoMaxBytes)} are not loaded into an editor. Preview it in the streaming viewer (it reads only the part you scroll to), execute it, or import it.`}
                    </Alert>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="xs"
                        variant="light"
                        disabled={opening || !manager.available || extension !== 'sql'}
                        title={
                            extension === 'sql'
                                ? 'Run the file against a connection, statement by statement, in the background'
                                : 'Only .sql files can be executed'
                        }
                        onClick={() => handOff('script')}
                    >
                        Execute file…
                    </Button>
                    <Button
                        size="xs"
                        variant="light"
                        disabled={opening || !manager.available || !IMPORTABLE.has(extension)}
                        title={
                            IMPORTABLE.has(extension)
                                ? 'Load the rows or documents of the file into a table or collection'
                                : 'Import reads CSV, JSON, NDJSON and BSON files'
                        }
                        onClick={() => handOff('import')}
                    >
                        Import into database…
                    </Button>
                </div>
                <Text size="xs" className="text-dimmed">
                    Executing and importing read the file in pieces in the background, whatever its
                    size, and show their progress in the task list.
                </Text>
                {error && <Alert color="red">{error}</Alert>}
            </Stack>
        </AppModal>
    );
}
