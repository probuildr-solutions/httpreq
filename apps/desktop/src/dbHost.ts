/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { serveWorker } from '@httpreq/db-workers';
import { DbHostService } from '@httpreq/db-host';
import { mongoProvider } from '@httpreq/mongo-engine';
import { mysqlProvider } from '@httpreq/mysql-engine';
import { postgresProvider } from '@httpreq/postgres-engine';
import { redisProvider } from '@httpreq/redis-engine';

/**
 * Entry point of the Database Host: an Electron utility process that holds every database
 * connection, runs statements and scripts, and stores results on disk. It is separate from the
 * main process and from the file host, so a driver bug, a runaway result or a killed statement
 * cannot take the application, a window or an open file down with it.
 *
 * It is given a folder for temporary result files and nothing else. Passwords arrive inside the
 * requests that need them, from the main process, and are held in memory only.
 */

const port = process.parentPort;
if (!port) throw new Error('The database host must be started as an Electron utility process.');

const host = new DbHostService({
    providers: [mysqlProvider, postgresProvider, mongoProvider, redisProvider],
    spoolDirectory: process.env.HTTPREQ_SPOOL_DIR,
});

serveWorker(
    {
        postMessage: (message) => port.postMessage(message),
        onMessage: (listener) => port.on('message', (event) => listener(event.data)),
    },
    (op, payload, context) => host.handle(op, payload, context),
);

// Close connections and delete result files when the main process asks us to go away.
process.on('SIGTERM', () => void host.dispose().finally(() => process.exit(0)));
process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));
