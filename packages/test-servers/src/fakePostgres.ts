/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

/**
 * A scripted server that speaks the PostgreSQL frontend/backend protocol (version 3, simple
 * query flow), for the tests of the PostgreSQL driver and engine on a machine without PostgreSQL.
 *
 * It is NOT PostgreSQL. It authenticates (trust, cleartext, md5, SCRAM-SHA-256: the server half is
 * written separately from the client's, from the RFCs), answers `Query` messages with whatever the
 * test registered for a matching statement, and understands `CancelRequest`. It does not parse
 * SQL, so tests of the engine's catalog queries prove how the engine reads and maps the answers,
 * not that its SQL is valid. That needs a real server, and none is installed here.
 */

export type FakePgAuth = 'trust' | 'cleartext' | 'md5' | 'scram';

export interface FakePgOptions {
    auth?: FakePgAuth;
    user?: string;
    password?: string;
    /** `server_version` as the server reports it. */
    version?: string;
    /** Extra `ParameterStatus` values. */
    parameters?: Record<string, string>;
    /** Answer `SSLRequest` with `S` is not supported; the server answers `N`. */
    scramIterations?: number;
}

export interface PgColumnSpec {
    name: string;
    oid: number;
    /** `typmod`, -1 when none. */
    modifier?: number;
}

export type PgResultSpec =
    | { columns: PgColumnSpec[]; rows: (string | null)[][]; tag?: string }
    | { tag: string }
    | {
          error: {
              code: string;
              message: string;
              detail?: string;
              hint?: string;
              position?: number;
          };
      }
    | { notice: string }
    /** Rows are produced on demand, honouring the socket's back-pressure. */
    | {
          generate: {
              columns: PgColumnSpec[];
              count: number;
              row: (index: number) => (string | null)[];
          };
      }
    /** Never answers until the query is cancelled. */
    | { hang: true }
    /** Several statements' results in order. */
    | { many: PgResultSpec[] }
    | { copyIn: true }
    | { copyOut: true };

export type PgHandler = (
    sql: string,
    match: RegExpExecArray,
) => PgResultSpec | Promise<PgResultSpec>;

export interface FakePostgres {
    host: string;
    port: number;
    /** Every statement received, in order. */
    queries: string[];
    /** The startup parameters of every connection (user, database…). */
    startups: Record<string, string>[];
    /** Answers statements that match; the latest registered wins. */
    on(pattern: RegExp, handler: PgResultSpec | PgHandler): void;
    /** How many connections were accepted. */
    connections(): number;
    /** How many `CancelRequest`s were received. */
    cancels(): number;
    /** Closes every client connection abruptly. */
    dropConnections(): void;
    stop(): Promise<void>;
}

const message = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(5 + body.length);
    out[0] = type.charCodeAt(0);
    out.writeInt32BE(4 + body.length, 1);
    body.copy(out, 5);
    return out;
};

const cstring = (text: string) => Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
const int32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
};
const int16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return b;
};

const authRequest = (code: number, extra: Buffer = Buffer.alloc(0)) =>
    message('R', Buffer.concat([int32(code), extra]));

const errorMessage = (e: {
    code: string;
    message: string;
    detail?: string;
    hint?: string;
    position?: number;
}) =>
    message(
        'E',
        Buffer.concat([
            Buffer.from('S'),
            cstring('ERROR'),
            Buffer.from('C'),
            cstring(e.code),
            Buffer.from('M'),
            cstring(e.message),
            ...(e.detail ? [Buffer.from('D'), cstring(e.detail)] : []),
            ...(e.hint ? [Buffer.from('H'), cstring(e.hint)] : []),
            ...(e.position ? [Buffer.from('P'), cstring(String(e.position))] : []),
            Buffer.from([0]),
        ]),
    );

const rowDescription = (columns: PgColumnSpec[]) =>
    message(
        'T',
        Buffer.concat([
            int16(columns.length),
            ...columns.map((c) =>
                Buffer.concat([
                    cstring(c.name),
                    int32(0),
                    int16(0),
                    int32(c.oid),
                    int16(-1),
                    int32(c.modifier ?? -1),
                    int16(0),
                ]),
            ),
        ]),
    );

const dataRow = (values: (string | null)[]) =>
    message(
        'D',
        Buffer.concat([
            int16(values.length),
            ...values.map((v) =>
                v === null
                    ? int32(-1)
                    : Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)]),
            ),
        ]),
    );

/** Server half of SCRAM-SHA-256, from RFC 5802 / 7677. */
const scramServer = (password: string, iterations: number) => {
    const salt = randomBytes(16);
    const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const storedKey = createHash('sha256')
        .update(createHmac('sha256', salted).update('Client Key').digest())
        .digest();
    const serverKey = createHmac('sha256', salted).update('Server Key').digest();
    let clientFirstBare = '';
    let serverFirst = '';
    let nonce = '';
    return {
        first(clientFirst: string): string {
            const bare = clientFirst.replace(/^n,,/, '');
            clientFirstBare = bare;
            const clientNonce = /(?:^|,)r=([^,]+)/.exec(bare)?.[1] ?? '';
            nonce = clientNonce + randomBytes(12).toString('base64');
            serverFirst = `r=${nonce},s=${salt.toString('base64')},i=${iterations}`;
            return serverFirst;
        },
        /** Returns the server-final message, or `null` when the proof is wrong. */
        final(clientFinal: string): string | null {
            const proofAt = clientFinal.lastIndexOf(',p=');
            const withoutProof = clientFinal.slice(0, proofAt);
            const proof = Buffer.from(clientFinal.slice(proofAt + 3), 'base64');
            if (!withoutProof.includes(`r=${nonce}`)) return null;
            const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
            const signature = createHmac('sha256', storedKey).update(authMessage).digest();
            const clientKey = Buffer.from(proof.map((byte, i) => byte ^ signature[i]!));
            const candidate = createHash('sha256').update(clientKey).digest();
            if (candidate.length !== storedKey.length || !timingSafeEqual(candidate, storedKey))
                return null;
            return `v=${createHmac('sha256', serverKey).update(authMessage).digest('base64')}`;
        },
    };
};

export const startFakePostgres = async (options: FakePgOptions = {}): Promise<FakePostgres> => {
    const auth = options.auth ?? 'trust';
    const user = options.user ?? 'postgres';
    const password = options.password ?? 'secret';
    const handlers: { pattern: RegExp; handler: PgHandler }[] = [];
    const queries: string[] = [];
    const startups: Record<string, string>[] = [];
    const sockets = new Set<Socket>();
    const backends = new Map<number, { secret: number; cancel: () => void }>();
    let accepted = 0;
    let cancelRequests = 0;
    let nextPid = 4000;

    const parameters: Record<string, string> = {
        server_version: options.version ?? '16.3',
        server_encoding: 'UTF8',
        client_encoding: 'UTF8',
        standard_conforming_strings: 'on',
        DateStyle: 'ISO, MDY',
        integer_datetimes: 'on',
        session_authorization: user,
        ...options.parameters,
    };

    const respond = async (
        socket: Socket,
        spec: PgResultSpec,
        state: { cancelled: boolean; release: (() => void) | null },
    ): Promise<void> => {
        const write = (data: Buffer) => {
            if (!socket.destroyed) socket.write(data);
        };
        if ('many' in spec) {
            for (const part of spec.many) {
                await respond(socket, part, state);
                if ('error' in part) return;
            }
            return;
        }
        if ('error' in spec) return void write(errorMessage(spec.error));
        if ('notice' in spec) {
            write(
                message(
                    'N',
                    Buffer.concat([
                        Buffer.from('S'),
                        cstring('NOTICE'),
                        Buffer.from('C'),
                        cstring('00000'),
                        Buffer.from('M'),
                        cstring(spec.notice),
                        Buffer.from([0]),
                    ]),
                ),
            );
            return void write(message('C', cstring('DO')));
        }
        if ('hang' in spec) {
            await new Promise<void>((resolve) => {
                state.release = resolve;
            });
            if (state.cancelled)
                write(
                    errorMessage({
                        code: '57014',
                        message: 'canceling statement due to user request',
                    }),
                );
            return;
        }
        if ('copyIn' in spec) {
            write(message('G', Buffer.concat([Buffer.from([0]), int16(0)])));
            // The client answers with CopyFail, which the server turns into an error.
            await new Promise<void>((resolve) => {
                state.release = resolve;
            });
            return void write(errorMessage({ code: '57014', message: 'COPY from stdin failed' }));
        }
        if ('copyOut' in spec) {
            write(message('H', Buffer.concat([Buffer.from([0]), int16(0)])));
            write(message('d', Buffer.from('1\tone\n')));
            write(message('c', Buffer.alloc(0)));
            return void write(message('C', cstring('COPY 1')));
        }
        if ('generate' in spec) {
            const { columns, count, row } = spec.generate;
            write(rowDescription(columns));
            for (let i = 0; i < count && !socket.destroyed; i++) {
                if (state.cancelled)
                    return void write(
                        errorMessage({
                            code: '57014',
                            message: 'canceling statement due to user request',
                        }),
                    );
                if (!socket.write(dataRow(row(i))))
                    await new Promise<void>((resolve) => socket.once('drain', resolve));
            }
            return void write(message('C', cstring(`SELECT ${count}`)));
        }
        if ('columns' in spec) {
            write(rowDescription(spec.columns));
            for (const values of spec.rows) write(dataRow(values));
            return void write(message('C', cstring(spec.tag ?? `SELECT ${spec.rows.length}`)));
        }
        write(message('C', cstring(spec.tag)));
    };

    const server: Server = createServer((socket) => {
        accepted++;
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
        let buffer = Buffer.alloc(0);
        let stage: 'startup' | 'password' | 'sasl-first' | 'sasl-final' | 'ready' = 'startup';
        let startupUser = '';
        let md5Salt = Buffer.alloc(0);
        let scram: ReturnType<typeof scramServer> | null = null;
        let pid = 0;
        const state = { cancelled: false, release: null as (() => void) | null };
        let busy = Promise.resolve();

        const fail = (code: string, text: string) => {
            socket.write(errorMessage({ code, message: text }));
            socket.end();
        };
        const ready = () => {
            pid = nextPid++;
            const secret = Math.floor(Math.random() * 2 ** 31);
            backends.set(pid, {
                secret,
                cancel: () => {
                    state.cancelled = true;
                    state.release?.();
                },
            });
            socket.on('close', () => backends.delete(pid));
            socket.write(
                Buffer.concat([
                    authRequest(0),
                    ...Object.entries(parameters).map(([k, v]) =>
                        message('S', Buffer.concat([cstring(k), cstring(v)])),
                    ),
                    message('K', Buffer.concat([int32(pid), int32(secret)])),
                    message('Z', Buffer.from('I')),
                ]),
            );
            stage = 'ready';
        };

        const onStartup = (packet: Buffer): void => {
            const code = packet.readInt32BE(0);
            if (code === 80877103) {
                socket.write('N');
                return;
            }
            if (code === 80877102) {
                const targetPid = packet.readInt32BE(4);
                const secret = packet.readInt32BE(8);
                cancelRequests++;
                const backend = backends.get(targetPid);
                if (backend && backend.secret === secret) backend.cancel();
                socket.end();
                return;
            }
            // Startup message: parameters are key/value C strings.
            const fields = packet.subarray(4).toString('utf8').split('\0');
            const startup: Record<string, string> = {};
            for (let i = 0; i + 1 < fields.length; i += 2) {
                startup[fields[i]!] = fields[i + 1]!;
                if (fields[i] === 'user') startupUser = fields[i + 1]!;
            }
            startups.push(startup);
            if (auth === 'trust') ready();
            else if (auth === 'cleartext') {
                socket.write(authRequest(3));
                stage = 'password';
            } else if (auth === 'md5') {
                md5Salt = randomBytes(4);
                socket.write(authRequest(5, md5Salt));
                stage = 'password';
            } else {
                scram = scramServer(password, options.scramIterations ?? 4096);
                socket.write(
                    authRequest(10, Buffer.concat([cstring('SCRAM-SHA-256'), Buffer.from([0])])),
                );
                stage = 'sasl-first';
            }
        };

        const onMessage = (type: string, body: Buffer): void => {
            if (stage === 'password' && type === 'p') {
                const given = body.toString('utf8', 0, body.length - 1);
                const md5 = (s: string | Buffer) => createHash('md5').update(s).digest('hex');
                const expected =
                    auth === 'cleartext'
                        ? password
                        : `md5${md5(Buffer.concat([Buffer.from(md5(password + startupUser)), md5Salt]))}`;
                if (startupUser !== user || given !== expected)
                    return fail(
                        '28P01',
                        `password authentication failed for user "${startupUser}"`,
                    );
                return ready();
            }
            if (stage === 'sasl-first' && type === 'p') {
                const mechanismEnd = body.indexOf(0);
                const length = body.readInt32BE(mechanismEnd + 1);
                const clientFirst = body.toString(
                    'utf8',
                    mechanismEnd + 5,
                    mechanismEnd + 5 + length,
                );
                if (startupUser !== user)
                    return fail(
                        '28P01',
                        `password authentication failed for user "${startupUser}"`,
                    );
                socket.write(authRequest(11, Buffer.from(scram!.first(clientFirst))));
                stage = 'sasl-final';
                return;
            }
            if (stage === 'sasl-final' && type === 'p') {
                const result = scram!.final(body.toString('utf8'));
                if (!result)
                    return fail(
                        '28P01',
                        `password authentication failed for user "${startupUser}"`,
                    );
                socket.write(authRequest(12, Buffer.from(result)));
                return ready();
            }
            if (stage !== 'ready') return;
            if (type === 'X') {
                socket.end();
                return;
            }
            if (type === 'f') {
                // CopyFail: let a waiting COPY continue with its error.
                state.release?.();
                return;
            }
            if (type !== 'Q') return;
            const sql = body.toString('utf8', 0, body.length - 1);
            queries.push(sql);
            busy = busy.then(async () => {
                state.cancelled = false;
                state.release = null;
                const entry = [...handlers].reverse().find((h) => h.pattern.test(sql));
                if (!entry) {
                    socket.write(
                        errorMessage({
                            code: '42601',
                            message: `the fake server has no answer for: ${sql.slice(0, 80)}`,
                        }),
                    );
                } else {
                    entry.pattern.lastIndex = 0;
                    const match = entry.pattern.exec(sql)!;
                    const spec = await entry.handler(sql, match);
                    await respond(socket, spec, state);
                }
                if (!socket.destroyed) socket.write(message('Z', Buffer.from('I')));
            });
        };

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                if (stage === 'startup') {
                    if (buffer.length < 4) return;
                    const length = buffer.readInt32BE(0);
                    if (buffer.length < length) return;
                    const packet = buffer.subarray(4, length);
                    buffer = buffer.subarray(length);
                    onStartup(packet);
                    continue;
                }
                if (buffer.length < 5) return;
                const length = buffer.readInt32BE(1);
                if (buffer.length < length + 1) return;
                const type = String.fromCharCode(buffer[0]!);
                const body = buffer.subarray(5, length + 1);
                buffer = buffer.subarray(length + 1);
                onMessage(type, body);
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
        host: '127.0.0.1',
        port,
        queries,
        startups,
        on: (pattern, handler) => {
            handlers.push({
                pattern,
                handler: typeof handler === 'function' ? handler : () => handler,
            });
        },
        connections: () => accepted,
        cancels: () => cancelRequests,
        dropConnections: () => {
            for (const socket of sockets) socket.destroy();
        },
        stop: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            }),
    };
};
