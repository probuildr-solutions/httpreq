/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Real database servers for the integration tests, started on demand from binaries already on the
 * machine (nothing is downloaded). Each helper returns `null` when its server is not installed, so
 * the tests that need it skip instead of failing on a machine without it.
 *
 * Servers listen on 127.0.0.1 on a free port and keep their data in a temporary folder that is
 * removed when they stop.
 */

export interface TestServer {
    host: string;
    port: number;
    /** Credentials of accounts created for the tests (password only for the ones that have one). */
    users: Record<string, string>;
    stop(): Promise<void>;
}

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });

const waitForPort = async (port: number, child: ChildProcess, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null)
            throw new Error(`The server exited early (code ${child.exitCode}).`);
        const open = await new Promise<boolean>((resolve) => {
            const socket = connect(port, '127.0.0.1');
            socket.once('connect', () => (socket.destroy(), resolve(true)));
            socket.once('error', () => resolve(false));
        });
        if (open) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('The server did not start in time.');
};

const run = (command: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore' });
        child.once('error', reject);
        child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
        );
    });

const stopProcess = (child: ChildProcess): Promise<void> =>
    new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(() => child.kill('SIGKILL'), 8_000).unref();
    });

const firstExisting = (candidates: (string | undefined)[]): string | null =>
    candidates.find((path): path is string => !!path && existsSync(path)) ?? null;

/** Where a MySQL server binary might be; override with HTTPREQ_MYSQLD. */
export const findMysqld = (): string | null =>
    firstExisting([
        process.env.HTTPREQ_MYSQLD,
        'C:\\Program Files\\MySQL\\MySQL Server 26.7\\bin\\mysqld.exe',
        'C:\\Program Files\\MySQL\\MySQL Server 9.0\\bin\\mysqld.exe',
        'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqld.exe',
        'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe',
        '/usr/local/mysql/bin/mysqld',
        '/usr/sbin/mysqld',
        '/opt/homebrew/opt/mysql/bin/mysqld',
    ]);

/** Where a MongoDB server binary might be; override with HTTPREQ_MONGOD. */
export const findMongod = (): string | null =>
    firstExisting([
        process.env.HTTPREQ_MONGOD,
        'C:\\Program Files\\MongoDB\\Server\\8.2\\bin\\mongod.exe',
        'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe',
        'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe',
        '/usr/bin/mongod',
        '/usr/local/bin/mongod',
        '/opt/homebrew/bin/mongod',
    ]);

/**
 * Starts a throwaway MySQL server with these accounts: `root` (no password), `app` (password
 * `secret`, caching_sha2_password), `blank` (no password) and `limited` (read-only on `shop`).
 */
export const startMysql = async (): Promise<TestServer | null> => {
    const binary = findMysqld();
    if (!binary) return null;
    const directory = await mkdtemp(join(tmpdir(), 'hr-mysql-'));
    const data = join(directory, 'data');
    await mkdir(data);
    await run(binary, ['--initialize-insecure', `--datadir=${data}`, '--console']);
    const init = join(directory, 'init.sql');
    await writeFile(
        init,
        [
            "CREATE USER 'app'@'%' IDENTIFIED BY 'secret';",
            "GRANT ALL ON *.* TO 'app'@'%' WITH GRANT OPTION;",
            "CREATE USER 'blank'@'%';",
            "GRANT ALL ON *.* TO 'blank'@'%';",
            'CREATE DATABASE shop;',
            "CREATE USER 'limited'@'%' IDENTIFIED BY 'readonly';",
            "GRANT SELECT ON shop.* TO 'limited'@'%';",
        ].join('\n'),
    );
    const port = await freePort();
    const child = spawn(
        binary,
        [
            `--datadir=${data}`,
            `--port=${port}`,
            '--bind-address=127.0.0.1',
            '--mysqlx=OFF',
            `--init-file=${init}`,
            '--console',
        ],
        { stdio: 'ignore' },
    );
    try {
        await waitForPort(port, child, 90_000);
        // The init file runs before connections are accepted, so the accounts exist by now.
    } catch (error) {
        await stopProcess(child);
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        host: '127.0.0.1',
        port,
        users: { root: '', app: 'secret', blank: '', limited: 'readonly' },
        stop: async () => {
            await stopProcess(child);
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        },
    };
};

export interface MongoOptions {
    /** Turn on access control. The first user is then created through the localhost exception. */
    auth?: boolean;
    /** Run as a member of a replica set of one; the caller initiates it with `replSetInitiate`. */
    replSet?: string;
}

/** Starts a throwaway MongoDB server, without authentication unless asked. */
export const startMongo = async (options: MongoOptions = {}): Promise<TestServer | null> => {
    const binary = findMongod();
    if (!binary) return null;
    const directory = await mkdtemp(join(tmpdir(), 'hr-mongo-'));
    const port = await freePort();
    const child = spawn(
        binary,
        [
            '--dbpath',
            directory,
            '--port',
            String(port),
            '--bind_ip',
            '127.0.0.1',
            // Windows has no unix sockets, and rejects the option.
            ...(process.platform === 'win32' ? [] : ['--nounixsocket']),
            ...(options.auth ? ['--auth'] : []),
            ...(options.replSet ? ['--replSet', options.replSet] : []),
        ],
        { stdio: 'ignore' },
    );
    try {
        await waitForPort(port, child, 60_000);
    } catch (error) {
        await stopProcess(child);
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        host: '127.0.0.1',
        port,
        users: {},
        stop: async () => {
            await stopProcess(child);
            await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        },
    };
};
export * from './fakeRedis';
export * from './fakePostgres';
