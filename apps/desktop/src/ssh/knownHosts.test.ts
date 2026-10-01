/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, hostKeyOf, KnownHostsStore } from './knownHosts';

/** An SSH wire-format public key blob: a length-prefixed type followed by its payload. */
const hostKey = (type: string, payload: string) => {
    const name = Buffer.from(type, 'ascii');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(name.length);
    return Buffer.concat([header, name, Buffer.from(payload, 'utf8')]);
};

describe('fingerprintOf', () => {
    it('produces the SHA256 form OpenSSH prints, with no padding', () => {
        const fingerprint = fingerprintOf(hostKey('ssh-ed25519', 'abc'));
        expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
        expect(fingerprint).not.toContain('=');
    });

    it('is stable for the same key and different for another', () => {
        const one = fingerprintOf(hostKey('ssh-ed25519', 'abc'));
        expect(fingerprintOf(hostKey('ssh-ed25519', 'abc'))).toBe(one);
        expect(fingerprintOf(hostKey('ssh-ed25519', 'xyz'))).not.toBe(one);
    });
});

describe('hostKeyOf', () => {
    it('ignores host case but not the port, so host:22 and host:2222 stay separate', () => {
        expect(hostKeyOf('Example.COM', 22)).toBe('example.com:22');
        expect(hostKeyOf('example.com', 2222)).not.toBe(hostKeyOf('example.com', 22));
    });
});

describe('KnownHostsStore', () => {
    let directory: string;
    let store: KnownHostsStore;
    let path: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'httpreq-hosts-'));
        path = join(directory, 'known-hosts.json');
        store = new KnownHostsStore(path);
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it('reports an unseen host as unknown', async () => {
        expect(await store.check('a.dev', 22, 'SHA256:aaa')).toEqual({ kind: 'unknown' });
    });

    it('trusts a host, and recognises the same key afterwards', async () => {
        await store.trust('a.dev', 22, 'ssh-ed25519', 'SHA256:aaa');
        expect(await store.check('a.dev', 22, 'SHA256:aaa')).toEqual({ kind: 'trusted' });
    });

    it('reports a changed key as changed, with the fingerprint it had stored', async () => {
        await store.trust('a.dev', 22, 'ssh-ed25519', 'SHA256:aaa');
        expect(await store.check('a.dev', 22, 'SHA256:bbb')).toEqual({
            kind: 'changed',
            storedFingerprint: 'SHA256:aaa',
        });
    });

    it('never trusts a key just because another host or port uses it', async () => {
        await store.trust('a.dev', 22, 'ssh-ed25519', 'SHA256:aaa');
        expect(await store.check('b.dev', 22, 'SHA256:aaa')).toEqual({ kind: 'unknown' });
        expect(await store.check('a.dev', 2222, 'SHA256:aaa')).toEqual({ kind: 'unknown' });
    });

    it('replaces the entry when a new key is trusted for the same host', async () => {
        await store.trust('a.dev', 22, 'ssh-ed25519', 'SHA256:aaa');
        await store.trust('a.dev', 22, 'ssh-rsa', 'SHA256:bbb');
        const entries = await store.list();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ keyType: 'ssh-rsa', fingerprint: 'SHA256:bbb' });
    });

    it('forgets a host, which makes it unknown again', async () => {
        await store.trust('a.dev', 22, 'ssh-ed25519', 'SHA256:aaa');
        await store.forget('a.dev', 22);
        expect(await store.check('a.dev', 22, 'SHA256:aaa')).toEqual({ kind: 'unknown' });
    });

    it('persists to disk, so a new store sees what the old one trusted', async () => {
        await store.trust('a.dev', 22, 'ssh-ed25519', 'SHA256:aaa');
        expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1);
        expect(await new KnownHostsStore(path).check('a.dev', 22, 'SHA256:aaa')).toEqual({
            kind: 'trusted',
        });
    });

    it('treats a corrupted file as empty rather than failing every connection', async () => {
        const broken = new KnownHostsStore(join(directory, 'missing', 'known-hosts.json'));
        expect(await broken.list()).toEqual([]);
    });
});
