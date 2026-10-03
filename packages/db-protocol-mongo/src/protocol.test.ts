// @vitest-environment node
/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findMongod, startMongo, type TestServer } from '@httpreq/test-servers';
import { DbError } from '@httpreq/db-core';
import {
    MongoConnection,
    scramCredentials,
    scramStart,
    type BsonDocument,
    type MongoConnectOptions,
} from './index';

const available = findMongod() !== null;

const options = (
    server: TestServer,
    extra: Partial<MongoConnectOptions> = {},
): MongoConnectOptions => ({
    host: server.host,
    port: server.port,
    tls: { mode: 'disable' },
    connectTimeoutMs: 5000,
    ...extra,
});

describe('SCRAM (against a server written from the RFC)', () => {
    it('reproduces the example conversation of RFC 7677', async () => {
        const client = scramStart(
            'SCRAM-SHA-256',
            'user',
            'pencil',
            Buffer.from('rOprNGfwEbeRWgbNEkqO', 'base64'),
        );
        expect(client.payload.toString()).toBe('n,,n=user,r=rOprNGfwEbeRWgbNEkqO');
        const final = await client.next(
            Buffer.from(
                'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
            ),
        );
        expect(final.toString()).toBe(
            'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
        );
        expect(() =>
            client.finish(Buffer.from('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=')),
        ).not.toThrow();
    });

    for (const mechanism of ['SCRAM-SHA-1', 'SCRAM-SHA-256'] as const) {
        it(`${mechanism} proves the password both ways`, async () => {
            const salt = Buffer.from('0123456789abcdef');
            const iterations = 4096;
            const stored = await scramCredentials(mechanism, 'user', 'pencil', salt, iterations);
            const { createHmac, createHash } = await import('node:crypto');
            const algorithm = mechanism === 'SCRAM-SHA-1' ? 'sha1' : 'sha256';

            const client = scramStart(
                mechanism,
                'user',
                'pencil',
                Buffer.from('client-nonce-bytes-0123456789'),
            );
            const clientFirst = client.payload.toString();
            expect(clientFirst.startsWith('n,,n=user,r=')).toBe(true);
            const clientNonce = clientFirst.split('r=')[1]!;
            const serverFirst = `r=${clientNonce}SERVERPART,s=${salt.toString('base64')},i=${iterations}`;
            const clientFinal = (await client.next(Buffer.from(serverFirst))).toString();

            // The server verifies the proof.
            const withoutProof = clientFinal.slice(0, clientFinal.lastIndexOf(',p='));
            const proof = Buffer.from(
                clientFinal.slice(clientFinal.lastIndexOf(',p=') + 3),
                'base64',
            );
            const authMessage = `n=user,r=${clientNonce},${serverFirst},${withoutProof}`;
            const signature = createHmac(algorithm, stored.storedKey).update(authMessage).digest();
            const clientKey = Buffer.from(proof.map((byte, i) => byte ^ signature[i]!));
            expect(createHash(algorithm).update(clientKey).digest().equals(stored.storedKey)).toBe(
                true,
            );

            // And the client verifies the server.
            const serverSignature = createHmac(algorithm, stored.serverKey)
                .update(authMessage)
                .digest();
            expect(() =>
                client.finish(Buffer.from(`v=${serverSignature.toString('base64')}`)),
            ).not.toThrow();
        });
    }

    it('refuses a server that cannot prove it knows the password', async () => {
        const client = scramStart(
            'SCRAM-SHA-256',
            'user',
            'pencil',
            Buffer.from('abcdefghijklmnopqrstuvwx'),
        );
        const nonce = client.payload.toString().split('r=')[1]!;
        await client.next(
            Buffer.from(`r=${nonce}xyz,s=${Buffer.from('salt').toString('base64')},i=4096`),
        );
        expect(() =>
            client.finish(Buffer.from(`v=${Buffer.alloc(32).toString('base64')}`)),
        ).toThrow(/could not prove/);
        expect(() => client.finish(Buffer.from('e=invalid-proof'))).toThrow(/refused/);
    });

    it('refuses a server that changes the nonce or asks for too few iterations', async () => {
        const make = () =>
            scramStart('SCRAM-SHA-256', 'user', 'pencil', Buffer.from('abcdefghijklmnopqrstuvwx'));
        const first = make();
        await expect(first.next(Buffer.from('r=other,s=c2FsdA==,i=4096'))).rejects.toThrow(/nonce/);
        const second = make();
        const nonce = second.payload.toString().split('r=')[1]!;
        await expect(second.next(Buffer.from(`r=${nonce}x,s=c2FsdA==,i=10`))).rejects.toThrow(
            /iterations/,
        );
        await expect(make().next(Buffer.from('garbage'))).rejects.toBeInstanceOf(DbError);
    });

    it('escapes = and , in user names', () => {
        expect(
            scramStart('SCRAM-SHA-256', 'a=b,c', 'x', Buffer.alloc(24)).payload.toString(),
        ).toContain('n=a=3Db=2Cc,');
    });
});

describe.skipIf(!available)('against a real mongod', () => {
    let server: TestServer;
    beforeAll(async () => {
        server = (await startMongo())!;
    }, 120_000);
    afterAll(async () => {
        await server?.stop();
    });

    const open = async (extra: Partial<MongoConnectOptions> = {}) =>
        MongoConnection.connect(options(server, extra));

    it('reports what the server is', async () => {
        const connection = await open();
        try {
            expect(connection.hello.version).toMatch(/^\d+\.\d+/);
            expect(connection.hello.maxWireVersion).toBeGreaterThanOrEqual(17);
            expect(connection.hello.writable).toBe(true);
            expect(connection.hello.process).toBe('mongod');
            await connection.ping();
        } finally {
            await connection.close();
        }
    });

    it('stores and reads documents of every type', async () => {
        const connection = await open();
        try {
            const document: BsonDocument = {
                _id: { $type: 'objectId', $value: '507f1f77bcf86cd799439011' },
                text: 'héllo 日本',
                int: 42,
                long: 2 ** 45,
                double: 1.25,
                yes: true,
                nothing: null,
                when: new Date('2024-05-01T10:20:30.123Z'),
                bytes: new Uint8Array([1, 2, 3]),
                list: [1, { a: 'b' }],
                money: { $type: 'decimal128', $value: '12345.6700' },
                pattern: { $type: 'regex', $value: '/^a/i' },
                id: { $type: 'uuid', $value: '123e4567-e89b-12d3-a456-426614174000' },
            };
            const inserted = await connection.command('studio_types', {
                insert: 'docs',
                documents: [document],
            });
            expect(inserted.n).toBe(1);
            const found = await connection.command('studio_types', { find: 'docs', filter: {} });
            const batch = (found.cursor as { firstBatch: BsonDocument[] }).firstBatch;
            expect(batch).toHaveLength(1);
            expect(batch[0]).toEqual(document);
        } finally {
            await connection.close();
        }
    });

    it('reports a server error with its code', async () => {
        const connection = await open();
        try {
            const failure = await connection
                .command('studio_errors', { nosuchcommand: 1 })
                .catch((e: unknown) => e);
            expect(failure).toBeInstanceOf(DbError);
            expect((failure as DbError).code).toBe('QUERY_FAILED');
            expect((failure as DbError).server?.number).toBe(59);
            // The connection survives a failed command.
            await connection.ping();
        } finally {
            await connection.close();
        }
    });

    it('reads a cursor batch by batch with getMore, and kills it', async () => {
        const connection = await open();
        try {
            const documents = Array.from({ length: 250 }, (_, i) => ({
                n: i,
                pad: 'x'.repeat(100),
            }));
            await connection.command('studio_cursor', { insert: 'rows', documents });
            const first = await connection.command('studio_cursor', {
                find: 'rows',
                filter: {},
                sort: { n: 1 },
                batchSize: 100,
            });
            const cursor = first.cursor as {
                id: number | bigint;
                firstBatch: BsonDocument[];
                ns: string;
            };
            expect(cursor.firstBatch).toHaveLength(100);
            expect(BigInt(cursor.id)).not.toBe(0n);
            const second = await connection.command('studio_cursor', {
                getMore: cursor.id as unknown as number,
                collection: 'rows',
                batchSize: 100,
            });
            const next = (second.cursor as { nextBatch: BsonDocument[] }).nextBatch;
            expect(next[0]!.n).toBe(100);
            const killed = await connection.command('studio_cursor', {
                killCursors: 'rows',
                cursors: [cursor.id as unknown as number],
            });
            expect((killed.cursorsKilled as unknown[]).length).toBe(1);
        } finally {
            await connection.close();
        }
    });

    it('moves a large document in both directions', async () => {
        const connection = await open();
        try {
            const big = 'y'.repeat(12 * 1024 * 1024);
            await connection.command('studio_big', {
                insert: 'blobs',
                documents: [{ _id: 1, big }],
            });
            const found = await connection.command('studio_big', {
                find: 'blobs',
                filter: { _id: 1 },
            });
            expect(
                ((found.cursor as { firstBatch: BsonDocument[] }).firstBatch[0] as { big: string })
                    .big.length,
            ).toBe(big.length);
        } finally {
            await connection.close();
        }
    });

    it('refuses to run two commands at once', async () => {
        const connection = await open();
        try {
            const slow = connection.command('admin', { ping: 1 });
            await expect(connection.command('admin', { ping: 1 })).rejects.toMatchObject({
                code: 'INTERNAL',
            });
            await slow;
        } finally {
            await connection.close();
        }
    });

    it('reports a dropped connection', async () => {
        const connection = await open();
        connection.destroy();
        await expect(connection.ping()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    });

    it('cannot connect to a port nobody listens on', async () => {
        await expect(
            MongoConnection.connect({
                host: '127.0.0.1',
                port: 1,
                tls: { mode: 'disable' },
                connectTimeoutMs: 1500,
            }),
        ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    });
});

describe.skipIf(!available)('login against a real mongod with access control', () => {
    let server: TestServer;
    beforeAll(async () => {
        server = (await startMongo({ auth: true }))!;
        // The localhost exception allows creating the first user without logging in.
        const admin = await MongoConnection.connect(options(server));
        await admin.command('admin', {
            createUser: 'root',
            pwd: 'pässword',
            roles: [{ role: 'root', db: 'admin' }],
            mechanisms: ['SCRAM-SHA-256'],
        });
        await admin.close();
        const second = await MongoConnection.connect(
            options(server, { username: 'root', password: 'pässword' }),
        );
        await second.command('admin', {
            createUser: 'legacy',
            pwd: 'old',
            roles: [{ role: 'readWrite', db: 'shop' }],
            mechanisms: ['SCRAM-SHA-1'],
        });
        await second.close();
    }, 120_000);
    afterAll(async () => {
        await server?.stop();
    });

    it('logs in with SCRAM-SHA-256, negotiated, with a non-ASCII password', async () => {
        const connection = await MongoConnection.connect(
            options(server, { username: 'root', password: 'pässword' }),
        );
        try {
            expect(connection.authenticatedUser).toBe('root');
            const status = await connection.command('admin', { connectionStatus: 1 });
            const info = status.authInfo as { authenticatedUsers: { user: string }[] };
            expect(info.authenticatedUsers[0]!.user).toBe('root');
        } finally {
            await connection.close();
        }
    });

    it('logs in with SCRAM-SHA-1 when that is all the user has', async () => {
        const connection = await MongoConnection.connect(
            options(server, { username: 'legacy', password: 'old' }),
        );
        try {
            await connection.command('shop', { insert: 'orders', documents: [{ a: 1 }] });
        } finally {
            await connection.close();
        }
    });

    it('fails with AUTH_FAILED on a wrong password or unknown user', async () => {
        await expect(
            MongoConnection.connect(options(server, { username: 'root', password: 'wrong' })),
        ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
        await expect(
            MongoConnection.connect(options(server, { username: 'nobody', password: 'x' })),
        ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    });

    it('refuses an unsupported login method before connecting any further', async () => {
        await expect(
            MongoConnection.connect(
                options(server, {
                    username: 'root',
                    password: 'pässword',
                    authMechanism: 'MONGODB-X509',
                }),
            ),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('answers PERMISSION_DENIED for what a user may not do', async () => {
        const connection = await MongoConnection.connect(
            options(server, { username: 'legacy', password: 'old' }),
        );
        try {
            await expect(
                connection.command('other', { find: 'x', filter: {} }),
            ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        } finally {
            await connection.close();
        }
    });

    it('is refused without logging in', async () => {
        const connection = await MongoConnection.connect(options(server));
        try {
            await expect(
                connection.command('shop', { find: 'orders', filter: {} }),
            ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        } finally {
            await connection.close();
        }
    });
});
