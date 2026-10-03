/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    BrowserWindow,
    dialog,
    ipcMain,
    utilityProcess,
    webContents,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
} from 'electron';
import { basename, dirname, extname, join } from 'node:path';
import { DbError, toDbError } from '@httpreq/db-core';
import { WorkerSupervisor, type WorkerTransport } from '@httpreq/db-workers';
import { DB_HOST_OPS, redact, type DbResult } from '@httpreq/shared';
import type { CredentialStore } from './ssh/credentials';

/**
 * The privileged half of Database Studio's connections, queries and scripts.
 *
 * Every request from a window is checked against a fixed list of operations. Passwords are
 * looked up here, in the OS credential store, and added to the one request that needs them; they
 * are never sent to a window. A window may only touch connections, queries and scripts it
 * started itself, and what it started is closed when it goes away. Files for scripts are named by
 * an id of a file the user opened, never by a path the window supplies.
 */

export interface DbConnectionsDeps {
    isTrustedSender: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
    /** Absolute path of the bundled database host entry (`dbHost.js`). */
    hostPath: string;
    userDataPath: string;
    credentials: CredentialStore;
    /** The path of a file the given window opened, by file id (for script runs). */
    pathOfFile: (senderId: number, fileId: string) => string | undefined;
    /** The path a file token (from the file dialog) stands for in this window, or undefined. */
    pathOfToken: (senderId: number, token: unknown) => string | undefined;
}

const ALLOWED = new Set<string>(DB_HOST_OPS);

const HEAP_MB = 1024;

const transport = (modulePath: string, spoolDirectory: string): WorkerTransport => {
    const child = utilityProcess.fork(modulePath, [], {
        serviceName: 'HttpReq database host',
        execArgv: [`--max-old-space-size=${HEAP_MB}`],
        env: { ...process.env, HTTPREQ_SPOOL_DIR: spoolDirectory },
        stdio: 'inherit',
    });
    return {
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => void child.on('message', listener),
        onExit: (listener) => void child.once('exit', (code) => listener(code)),
        kill: () => void child.kill(),
    };
};

/** Thrown when the user closes the save dialog: nothing starts, and that is not an error. */
class TaskNotStarted extends Error {}

const isId = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

export const registerDbConnections = ({
    isTrustedSender,
    hostPath,
    userDataPath,
    credentials,
    pathOfFile,
    pathOfToken,
}: DbConnectionsDeps) => {
    const spoolDirectory = join(userDataPath, 'db-spool');
    const host = new WorkerSupervisor({
        name: 'database',
        factory: () => transport(hostPath, spoolDirectory),
        // Statements and scripts can legitimately run for hours.
        cancelGraceMs: 10_000,
        onStatus: (status) => {
            // A host that stopped took its background tasks with it; their windows are told so the
            // task center does not show them running for ever.
            if (status.state === 'crashed' || status.state === 'failed') {
                for (const owner of new Set(taskOwner.values())) {
                    send(owner, {
                        topic: 'task.lost',
                        payload: {
                            reason: 'The database process stopped unexpectedly, so running tasks were stopped.',
                        },
                    });
                }
                taskOwner.clear();
            }
        },
    });

    /** Who owns what, so one window cannot reach another's connections, queries or scripts. */
    const connectionOwner = new Map<string, number>();
    const queryOwner = new Map<string, number>();
    /** Which connection each query runs on, so closing a connection forgets its queries. */
    const queryConnection = new Map<string, string>();
    const scriptOwner = new Map<string, number>();
    /** Which window started each background task. */
    const taskOwner = new Map<string, number>();

    const send = (senderId: number, payload: unknown) => {
        const contents = webContents.fromId(senderId);
        if (contents && !contents.isDestroyed()) contents.send('dbstudio:db-event', payload);
    };

    host.subscribe((topic, payload) => {
        const body = object(payload);
        const owner =
            topic === 'conn.status'
                ? connectionOwner.get(String(body.connectionId))
                : topic === 'query.state'
                  ? queryOwner.get(String(body.queryId))
                  : topic === 'script.progress'
                    ? scriptOwner.get(String(body.scriptId))
                    : topic === 'task.state'
                      ? taskOwner.get(String(object(body.snapshot).id))
                      : undefined;
        if (owner !== undefined) send(owner, { topic, payload });
    });

    const failure = (error: unknown): DbResult<never> => ({
        ok: false,
        error: toDbError(error).toInfo(),
    });

    /** Rewrites a window's request into what the host expects, adding what only main may add. */
    const prepare = async (op: string, raw: unknown, senderId: number): Promise<unknown> => {
        const payload = object(raw);
        const own = (map: Map<string, number>, key: string, what: string) => {
            if (!isId(payload[key]) || map.get(payload[key] as string) !== senderId) {
                throw new DbError('NOT_FOUND', `That ${what} is not open in this window.`);
            }
        };

        if (op === 'conn.test' || op === 'conn.open') {
            const settings = object(payload.settings);
            const profileId = typeof payload.profileId === 'string' ? payload.profileId : '';
            const password = profileId ? await credentials.get(`db:${profileId}`) : null;
            // A typed password for "test" can be passed without being stored: kept out of logs and replies.
            const transient = typeof payload.password === 'string' ? payload.password : undefined;
            const config = {
                ...settings,
                ...(transient !== undefined
                    ? { password: transient }
                    : password !== null
                      ? { password }
                      : {}),
            };
            if (op === 'conn.open') {
                if (!isId(payload.connectionId))
                    throw new DbError('INVALID_REQUEST', 'The connection is invalid.');
                const existing = connectionOwner.get(payload.connectionId);
                if (existing !== undefined && existing !== senderId) {
                    throw new DbError(
                        'PERMISSION_DENIED',
                        'That connection belongs to another window.',
                    );
                }
                return { connectionId: payload.connectionId, config };
            }
            return { config };
        }
        if ('connectionId' in payload) own(connectionOwner, 'connectionId', 'connection');
        if (op.startsWith('query.') && op !== 'query.start' && op !== 'query.explain')
            own(queryOwner, 'queryId', 'query');
        if (op === 'script.cancel' || op === 'script.close') own(scriptOwner, 'scriptId', 'script');
        if (op === 'script.start') {
            if (!isId(payload.fileId))
                throw new DbError('INVALID_REQUEST', 'Choose an open file to run.');
            const path = pathOfFile(senderId, payload.fileId);
            if (!path) throw new DbError('NOT_FOUND', 'That file is not open in this window.');
            const { fileId: _ignored, ...rest } = payload;
            void _ignored;
            return { ...rest, path };
        }
        if (
            op === 'task.cancel' ||
            op === 'task.pause' ||
            op === 'task.resume' ||
            op === 'task.remove'
        ) {
            if (!isId(payload.taskId) || taskOwner.get(payload.taskId) !== senderId)
                throw new DbError('NOT_FOUND', 'That task does not belong to this window.');
        }
        if (op === 'task.export' || op === 'task.import' || op === 'task.script') {
            if (!isId(payload.taskId)) throw new DbError('INVALID_REQUEST', 'The task is invalid.');
            return prepareTask(op, payload, senderId);
        }
        return payload;
    };

    /** Where an export goes is chosen in a native dialog; what an import reads is a file the user picked. */
    const prepareTask = async (op: string, payload: Record<string, unknown>, senderId: number) => {
        const contents = webContents.fromId(senderId);
        const window = contents ? BrowserWindow.fromWebContents(contents) : null;
        if (op === 'task.export') {
            const format = typeof payload.format === 'string' ? payload.format : 'csv';
            const name = (
                typeof payload.suggestedName === 'string' ? payload.suggestedName : 'export'
            )
                .replace(/[^A-Za-z0-9._ -]/g, '_')
                .slice(0, 100);
            const options = {
                title: 'Export to a file',
                defaultPath: `${name || 'export'}.${format}`,
                filters: [
                    { name: format.toUpperCase(), extensions: [format] },
                    { name: 'All files', extensions: ['*'] },
                ],
            };
            const chosen = window
                ? await dialog.showSaveDialog(window, options)
                : await dialog.showSaveDialog(options);
            if (chosen.canceled || !chosen.filePath) throw new TaskNotStarted();
            const { suggestedName: ignored, ...rest } = payload;
            void ignored;
            return { ...rest, path: chosen.filePath };
        }
        const path = pathOfToken(senderId, payload.fileToken);
        if (!path)
            throw new DbError(
                'NOT_FOUND',
                'That file was not chosen in this window. Choose it again.',
            );
        const { fileToken: token, ...rest } = payload;
        void token;
        if (op === 'task.import' && payload.saveRejects === true) {
            const base = basename(path, extname(path));
            return { ...rest, path, rejectsPath: join(dirname(path), `${base}.rejects.ndjson`) };
        }
        return { ...rest, path };
    };

    ipcMain.handle(
        'dbstudio:db:request',
        async (event, op: unknown, raw: unknown): Promise<DbResult<unknown>> => {
            if (!isTrustedSender(event))
                return failure(new DbError('PERMISSION_DENIED', 'This request is not allowed.'));
            if (typeof op !== 'string' || !ALLOWED.has(op))
                return failure(new DbError('UNSUPPORTED', 'That operation is not available.'));
            const senderId = event.sender.id;
            const body = object(raw);
            try {
                const payload = await prepare(op, raw, senderId);
                // The window is told about changes as soon as the host reports them, which can be before
                // this reply, so ownership is recorded first.
                if (op === 'conn.open' && isId(body.connectionId))
                    connectionOwner.set(body.connectionId, senderId);
                if (op === 'query.start' && isId(body.queryId) && isId(body.connectionId)) {
                    queryOwner.set(body.queryId, senderId);
                    queryConnection.set(body.queryId, body.connectionId);
                }
                if (op === 'script.start' && isId(body.scriptId))
                    scriptOwner.set(body.scriptId, senderId);
                if (
                    (op === 'task.export' || op === 'task.import' || op === 'task.script') &&
                    isId(body.taskId)
                )
                    taskOwner.set(body.taskId, senderId);
                // A statement may run for hours; the host's own limits (not a timer here) govern it.
                const value = await host.request(op, payload, {
                    timeoutMs: op === 'conn.test' || op === 'conn.open' ? 130_000 : 0,
                });
                if (op === 'conn.close' && isId(body.connectionId)) {
                    connectionOwner.delete(body.connectionId);
                    for (const [queryId, connectionId] of [...queryConnection]) {
                        if (connectionId !== body.connectionId) continue;
                        queryConnection.delete(queryId);
                        queryOwner.delete(queryId);
                    }
                }
                if (op === 'query.close' && isId(body.queryId)) {
                    queryOwner.delete(body.queryId);
                    queryConnection.delete(body.queryId);
                }
                if (op === 'script.close' && isId(body.scriptId)) scriptOwner.delete(body.scriptId);
                if (op === 'task.export' || op === 'task.import' || op === 'task.script')
                    return { ok: true, value: { started: true, taskId: body.taskId } };
                if (op === 'task.remove' && isId(body.taskId)) taskOwner.delete(body.taskId);
                if (op === 'task.list' && Array.isArray(value))
                    return {
                        ok: true,
                        value: value.filter(
                            (task) => taskOwner.get(String(object(task).id)) === senderId,
                        ),
                    };
                return { ok: true, value };
            } catch (error) {
                if (error instanceof TaskNotStarted) return { ok: true, value: { started: false } };
                // A request that failed to start leaves nothing to own.
                if (
                    (op === 'task.export' || op === 'task.import' || op === 'task.script') &&
                    isId(body.taskId)
                )
                    taskOwner.delete(body.taskId);
                if (op === 'query.start' && isId(body.queryId)) {
                    queryOwner.delete(body.queryId);
                    queryConnection.delete(body.queryId);
                }
                if (op === 'script.start' && isId(body.scriptId)) scriptOwner.delete(body.scriptId);
                // A password must never come back in a message.
                console.error('[db]', redact(error));
                return failure(error);
            }
        },
    );

    const profile = (value: unknown): string | null =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? `db:${value}` : null;

    ipcMain.handle(
        'dbstudio:db:set-password',
        async (event, profileId: unknown, password: unknown): Promise<boolean> => {
            const id = profile(profileId);
            if (
                !isTrustedSender(event) ||
                !id ||
                typeof password !== 'string' ||
                password.length > 1024
            )
                return false;
            try {
                return await credentials.set(id, password);
            } catch (error) {
                console.error('[db]', redact(error));
                return false;
            }
        },
    );
    ipcMain.handle(
        'dbstudio:db:has-password',
        async (event, profileId: unknown): Promise<boolean> => {
            const id = profile(profileId);
            return isTrustedSender(event) && !!id && credentials.has(id);
        },
    );
    ipcMain.handle(
        'dbstudio:db:delete-password',
        async (event, profileId: unknown): Promise<void> => {
            const id = profile(profileId);
            if (isTrustedSender(event) && id) await credentials.delete(id);
        },
    );

    /** A window's connections, queries and scripts are closed with it. */
    const releaseSender = (senderId: number) => {
        for (const [connectionId, owner] of [...connectionOwner]) {
            if (owner !== senderId) continue;
            connectionOwner.delete(connectionId);
            void host.request('conn.close', { connectionId }).catch(() => undefined);
        }
        for (const [queryId, owner] of [...queryOwner]) {
            if (owner !== senderId) continue;
            queryOwner.delete(queryId);
            queryConnection.delete(queryId);
        }
        for (const [scriptId, owner] of [...scriptOwner]) {
            if (owner !== senderId) continue;
            scriptOwner.delete(scriptId);
            void host.request('script.close', { scriptId }).catch(() => undefined);
        }
        // Background tasks belong to the window that started them, and stop with it.
        for (const [taskId, owner] of [...taskOwner]) {
            if (owner !== senderId) continue;
            taskOwner.delete(taskId);
            void host.request('task.cancel', { taskId }).catch(() => undefined);
        }
    };

    const dispose = async () => {
        connectionOwner.clear();
        queryOwner.clear();
        queryConnection.clear();
        scriptOwner.clear();
        taskOwner.clear();
        await host.stop();
    };

    return { releaseSender, dispose };
};
