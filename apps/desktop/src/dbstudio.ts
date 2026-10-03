/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    utilityProcess,
    webContents,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
} from 'electron';
import { join } from 'node:path';
import { DbError, STUDIO_BUDGETS, toDbError } from '@httpreq/db-core';
import { WorkerSupervisor, type WorkerTransport } from '@httpreq/db-workers';
import { FileHandleRegistry, displayName, statFile } from '@httpreq/file-engine';
import {
    redact,
    type DbFileOpened,
    type DbFileRef,
    type DbHostStatus,
    type DbFileText,
    type DbItemFormat,
    type DbItemsAnalyzed,
    type DbItemsList,
    type DbItemText,
    type DbLinesResult,
    type DbReplaced,
    type DbSaved,
    type DbSearchQuery,
    type DbResult,
} from '@httpreq/shared';

/**
 * The privileged half of Database Studio's large-file tools.
 *
 * It follows the same rules as `services.ts`: every handler re-checks the sender, validates its
 * payload, never throws across IPC (it returns an `IpcResult`), and never logs an unredacted
 * error. Files are opened by token, never by a path the renderer supplies, and all reading
 * happens in the File Host utility process, not here.
 */

export interface DbStudioDeps {
    isTrustedSender: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
    /** Absolute path of the bundled File Host entry (`fileHost.js`). */
    fileHostPath: string;
}

const failure = (error: unknown): DbResult<never> => ({
    ok: false,
    error: toDbError(error).toInfo(),
});

/** Electron's `utilityProcess` as the supervisor's transport. */
const utilityTransport = (modulePath: string, indexDirectory: string): WorkerTransport => {
    const child = utilityProcess.fork(modulePath, [], {
        serviceName: 'HttpReq file host',
        // The heap limit is what turns "a malformed 3 GB file ate all memory" into one dead
        // worker instead of a slow machine.
        execArgv: [`--max-old-space-size=${STUDIO_BUDGETS.fileHostHeapMb}`],
        env: { ...process.env, HTTPREQ_INDEX_DIR: indexDirectory },
        stdio: 'inherit',
    });
    return {
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => void child.on('message', listener),
        onExit: (listener) => void child.once('exit', (code) => listener(code)),
        kill: () => void child.kill(),
    };
};

const ITEM_FORMATS: readonly string[] = [
    'auto',
    'sql-mysql',
    'sql-postgresql',
    'jsonl',
    'json-array',
    'json-sequence',
];

/** Validates a search request from the renderer; unknown fields are dropped. */
const parseSearchQuery = (value: unknown): DbSearchQuery => {
    const query = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    if (typeof query.text !== 'string' || query.text.length === 0 || query.text.length > 1_000) {
        throw new DbError('INVALID_REQUEST', 'Enter something to search for.');
    }
    return {
        text: query.text,
        caseSensitive: query.caseSensitive === true,
        regex: query.regex === true,
        wholeWord: query.wholeWord === true,
    };
};

const isFileId = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

const isCount = (value: unknown, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

export const registerDbStudio = ({ isTrustedSender, fileHostPath }: DbStudioDeps) => {
    const registry = new FileHandleRegistry();
    /** Which window opened each file, so progress goes to it and it can only read its own. */
    const owners = new Map<string, number>();
    /** The path of each file a window opened, for running it as a script. Never sent to a window. */
    const filePaths = new Map<string, string>();
    /** Which window started each search, so only it can cancel it. */
    const searchOwners = new Map<string, number>();
    const indexDirectory = join(app.getPath('userData'), 'db-index');

    const send = (senderId: number, channel: string, payload: unknown) => {
        const contents = webContents.fromId(senderId);
        if (contents && !contents.isDestroyed()) contents.send(channel, payload);
    };
    const broadcast = (channel: string, payload: unknown) => {
        for (const contents of webContents.getAllWebContents()) {
            if (!contents.isDestroyed()) contents.send(channel, payload);
        }
    };

    const host = new WorkerSupervisor({
        name: 'file',
        factory: () => utilityTransport(fileHostPath, indexDirectory),
        onStatus: (status: DbHostStatus) => broadcast('dbstudio:host-status', status),
    });

    // Every event the host emits names its file; it goes only to the window that opened it.
    const EVENT_CHANNELS: Record<string, string> = {
        'file.progress': 'dbstudio:file-progress',
        'items.progress': 'dbstudio:items-progress',
        'search.hits': 'dbstudio:search-hits',
        'search.progress': 'dbstudio:search-progress',
        'edit.progress': 'dbstudio:edit-progress',
    };
    host.subscribe((topic, payload) => {
        const channel = EVENT_CHANNELS[topic];
        const fileId = (payload as { fileId?: unknown } | null)?.fileId;
        if (!channel || typeof fileId !== 'string') return;
        const owner = owners.get(fileId);
        if (owner !== undefined) send(owner, channel, payload);
    });

    /** The file id, provided this window opened it. */
    const owned = (event: IpcMainInvokeEvent, fileId: unknown): string => {
        if (!isFileId(fileId) || owners.get(fileId) !== event.sender.id) {
            throw new DbError('NOT_FOUND', 'That file is no longer open.');
        }
        return fileId;
    };

    const guard = async <T>(
        event: IpcMainInvokeEvent,
        work: () => Promise<T>,
    ): Promise<DbResult<T>> => {
        if (!isTrustedSender(event)) {
            return failure(new DbError('PERMISSION_DENIED', 'This request is not allowed.'));
        }
        try {
            return { ok: true, value: await work() };
        } catch (error) {
            console.error('[dbstudio]', redact(error));
            return failure(error);
        }
    };

    ipcMain.handle('dbstudio:status', (event): DbHostStatus =>
        isTrustedSender(event) ? host.status : { state: 'idle', restarts: 0 },
    );

    ipcMain.handle('dbstudio:file:pick', (event) =>
        guard(event, async (): Promise<DbFileRef | null> => {
            const window = BrowserWindow.fromWebContents(event.sender);
            const options = {
                title: 'Open a large file',
                properties: ['openFile' as const],
                filters: [
                    {
                        name: 'SQL, JSON and delimited text',
                        extensions: ['sql', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'txt', 'log'],
                    },
                    { name: 'All files', extensions: ['*'] },
                ],
            };
            const result = window
                ? await dialog.showOpenDialog(window, options)
                : await dialog.showOpenDialog(options);
            const path = result.filePaths[0];
            if (result.canceled || !path) return null;
            const { size } = await statFile(path);
            // The renderer gets a token and the file name; the directory stays here.
            return { token: registry.grant(path, event.sender.id), name: displayName(path), size };
        }),
    );

    ipcMain.handle('dbstudio:file:open', (event, token: unknown) =>
        guard(event, async (): Promise<DbFileOpened> => {
            const path = registry.resolve(token, event.sender.id);
            const opened = await host.request<DbFileOpened>('file.open', { path });
            owners.set(opened.fileId, event.sender.id);
            filePaths.set(opened.fileId, path);
            return opened;
        }),
    );

    ipcMain.handle('dbstudio:file:lines', (event, fileId: unknown, from: unknown, count: unknown) =>
        guard(event, async (): Promise<DbLinesResult> => {
            const id = owned(event, fileId);
            if (
                !isCount(from, Number.MAX_SAFE_INTEGER) ||
                !isCount(count, STUDIO_BUDGETS.maxLinesPerRead)
            ) {
                throw new DbError('INVALID_REQUEST', 'Invalid line range.');
            }
            return host.request<DbLinesResult>(
                'file.lines',
                { fileId: id, from, count },
                { timeoutMs: 30_000 },
            );
        }),
    );

    ipcMain.handle('dbstudio:items:analyze', (event, fileId: unknown, format: unknown) =>
        guard(event, async (): Promise<DbItemsAnalyzed> => {
            const id = owned(event, fileId);
            const requested = format === undefined ? 'auto' : format;
            if (typeof requested !== 'string' || !ITEM_FORMATS.includes(requested)) {
                throw new DbError('INVALID_REQUEST', 'Unknown file format.');
            }
            return host.request<DbItemsAnalyzed>('items.analyze', {
                fileId: id,
                format: requested as DbItemFormat | 'auto',
            });
        }),
    );

    ipcMain.handle('dbstudio:items:list', (event, fileId: unknown, from: unknown, count: unknown) =>
        guard(event, async (): Promise<DbItemsList> => {
            const id = owned(event, fileId);
            if (!isCount(from, Number.MAX_SAFE_INTEGER) || !isCount(count, 200)) {
                throw new DbError('INVALID_REQUEST', 'Invalid range.');
            }
            return host.request<DbItemsList>(
                'items.list',
                { fileId: id, from, count },
                { timeoutMs: 30_000 },
            );
        }),
    );

    ipcMain.handle('dbstudio:items:read', (event, fileId: unknown, index: unknown) =>
        guard(event, async (): Promise<DbItemText> => {
            const id = owned(event, fileId);
            if (!isCount(index, Number.MAX_SAFE_INTEGER)) {
                throw new DbError('INVALID_REQUEST', 'Invalid item.');
            }
            return host.request<DbItemText>(
                'items.read',
                { fileId: id, index },
                { timeoutMs: 30_000 },
            );
        }),
    );

    ipcMain.handle('dbstudio:items:at', (event, fileId: unknown, offset: unknown) =>
        guard(event, async (): Promise<{ index: number }> => {
            const id = owned(event, fileId);
            if (!isCount(offset, Number.MAX_SAFE_INTEGER)) {
                throw new DbError('INVALID_REQUEST', 'Invalid offset.');
            }
            return host.request<{ index: number }>('items.at', { fileId: id, offset });
        }),
    );

    ipcMain.handle(
        'dbstudio:search:start',
        (event, fileId: unknown, searchId: unknown, query: unknown, maxHits: unknown) =>
            guard(event, async (): Promise<{ searchId: string }> => {
                const id = owned(event, fileId);
                if (!isFileId(searchId)) throw new DbError('INVALID_REQUEST', 'Invalid search.');
                const parsed = parseSearchQuery(query);
                if (maxHits !== undefined && !isCount(maxHits, 1_000_000)) {
                    throw new DbError('INVALID_REQUEST', 'Invalid hit limit.');
                }
                searchOwners.set(searchId, event.sender.id);
                try {
                    return await host.request<{ searchId: string }>('search.start', {
                        fileId: id,
                        searchId,
                        query: parsed,
                        maxHits,
                    });
                } catch (error) {
                    searchOwners.delete(searchId);
                    throw error;
                }
            }),
    );

    ipcMain.handle('dbstudio:search:cancel', (event, searchId: unknown) =>
        guard(event, async (): Promise<void> => {
            if (typeof searchId !== 'string' || searchOwners.get(searchId) !== event.sender.id) {
                throw new DbError('NOT_FOUND', 'That search is not running.');
            }
            searchOwners.delete(searchId);
            await host.request('search.cancel', { searchId });
        }),
    );

    ipcMain.handle('dbstudio:edit:read-text', (event, fileId: unknown) =>
        guard(event, async (): Promise<DbFileText> => {
            const id = owned(event, fileId);
            return host.request<DbFileText>('file.readText', { fileId: id }, { timeoutMs: 60_000 });
        }),
    );

    const SAVE_TIMEOUT_MS = 30 * 60_000;
    const parseEol = (value: unknown) => (value === '\r\n' || value === '\n' ? value : undefined);

    ipcMain.handle('dbstudio:edit:save', (event, fileId: unknown, pieces: unknown, eol: unknown) =>
        guard(event, async (): Promise<DbSaved> => {
            const id = owned(event, fileId);
            return host.request<DbSaved>(
                'edit.save',
                { fileId: id, pieces, eol: parseEol(eol) },
                { timeoutMs: SAVE_TIMEOUT_MS },
            );
        }),
    );

    ipcMain.handle(
        'dbstudio:edit:save-as',
        (event, fileId: unknown, pieces: unknown, eol: unknown) =>
            guard(event, async (): Promise<DbSaved | null> => {
                const id = owned(event, fileId);
                const window = BrowserWindow.fromWebContents(event.sender);
                const options = { title: 'Save a copy' };
                const chosen = window
                    ? await dialog.showSaveDialog(window, options)
                    : await dialog.showSaveDialog(options);
                // The destination comes from the native dialog, never from the renderer.
                if (chosen.canceled || !chosen.filePath) return null;
                return host.request<DbSaved>(
                    'edit.save',
                    { fileId: id, pieces, eol: parseEol(eol), path: chosen.filePath },
                    { timeoutMs: SAVE_TIMEOUT_MS },
                );
            }),
    );

    ipcMain.handle(
        'dbstudio:edit:replace-all',
        (event, fileId: unknown, query: unknown, replacement: unknown) =>
            guard(event, async (): Promise<DbReplaced> => {
                const id = owned(event, fileId);
                if (typeof replacement !== 'string' || replacement.length > 10_000) {
                    throw new DbError('INVALID_REQUEST', 'The replacement text is invalid.');
                }
                return host.request<DbReplaced>(
                    'edit.replaceAll',
                    { fileId: id, query: parseSearchQuery(query), replacement },
                    { timeoutMs: SAVE_TIMEOUT_MS },
                );
            }),
    );

    ipcMain.handle('dbstudio:file:close', (event, fileId: unknown) =>
        guard(event, async (): Promise<void> => {
            const id = owned(event, fileId);
            owners.delete(id);
            filePaths.delete(id);
            await host.request('file.close', { fileId: id });
        }),
    );

    /** A window's files and tokens go away with it. */
    const releaseSender = (senderId: number) => {
        registry.revokeOwner(senderId);
        for (const [searchId, owner] of searchOwners) {
            if (owner === senderId) searchOwners.delete(searchId);
        }
        for (const [fileId, owner] of owners) {
            if (owner !== senderId) continue;
            owners.delete(fileId);
            filePaths.delete(fileId);
            void host.request('file.close', { fileId }).catch(() => undefined);
        }
    };

    const dispose = async () => {
        owners.clear();
        await host.stop();
    };

    /** The path of a file the given window opened (main process only). */
    const pathOfFile = (senderId: number, fileId: string): string | undefined =>
        owners.get(fileId) === senderId ? filePaths.get(fileId) : undefined;

    return { releaseSender, dispose, pathOfFile };
};
