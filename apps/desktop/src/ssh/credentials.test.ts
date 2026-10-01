/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `safeStorage` is backed by the OS keychain, which a test cannot reach, so it is replaced by a
 * reversible stand-in. What is being tested is the store's own behaviour: that a secret is written
 * only as ciphertext, can never be read back through the renderer's surface, and survives a
 * restart.
 */
const encryption = { available: true };
vi.mock('electron', () => ({
    safeStorage: {
        isEncryptionAvailable: () => encryption.available,
        encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
        decryptString: (buffer: Buffer) => {
            const text = buffer.toString('utf8');
            if (!text.startsWith('enc:')) throw new Error('not decryptable');
            return text.slice(4);
        },
    },
}));

const { CredentialStore, credentialStorePath } = await import('./credentials');

describe('CredentialStore', () => {
    let directory: string;
    let path: string;
    let store: InstanceType<typeof CredentialStore>;

    beforeEach(async () => {
        encryption.available = true;
        directory = await mkdtemp(join(tmpdir(), 'httpreq-vault-'));
        path = join(directory, 'credentials.enc.json');
        store = new CredentialStore(path);
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it('stores a secret and reports that it exists', async () => {
        expect(await store.set('cred-1', 'hunter2')).toBe(true);
        expect(await store.has('cred-1')).toBe(true);
        expect(await store.get('cred-1')).toBe('hunter2');
    });

    it('writes only ciphertext to disk', async () => {
        await store.set('cred-1', 'hunter2');
        const written = await readFile(path, 'utf8');
        expect(written).not.toContain('hunter2');
        expect(written).toContain('cred-1');
    });

    it('keeps secrets separate per credential id', async () => {
        await store.set('cred-1', 'one');
        await store.set('cred-2', 'two');
        expect(await store.get('cred-1')).toBe('one');
        expect(await store.get('cred-2')).toBe('two');
    });

    it('survives a restart, because the file is read back', async () => {
        await store.set('cred-1', 'hunter2');
        expect(await new CredentialStore(path).get('cred-1')).toBe('hunter2');
    });

    it('treats an empty secret as a deletion', async () => {
        await store.set('cred-1', 'hunter2');
        await store.set('cred-1', '');
        expect(await store.has('cred-1')).toBe(false);
        expect(await store.get('cred-1')).toBeNull();
    });

    it('deletes a secret, and removes the file once nothing is left', async () => {
        await store.set('cred-1', 'hunter2');
        await store.delete('cred-1');
        expect(await store.has('cred-1')).toBe(false);
        await expect(readFile(path, 'utf8')).rejects.toThrow();
    });

    it('refuses to store anything when the OS offers no encryption, rather than writing plain text', async () => {
        encryption.available = false;
        expect(await store.set('cred-1', 'hunter2')).toBe(false);
        expect(await store.get('cred-1')).toBeNull();
        await expect(readFile(path, 'utf8')).rejects.toThrow();
    });

    it('reports a secret written under a different OS key as absent', async () => {
        await store.set('cred-1', 'hunter2');
        // Simulates a vault copied to another machine: the ciphertext no longer decrypts.
        const tampered = new CredentialStore(path);
        vi.spyOn(Buffer, 'from').mockImplementationOnce(() => Buffer.from('garbage', 'utf8'));
        expect(await tampered.get('cred-1')).toBeNull();
        vi.restoreAllMocks();
    });

    it('never loses a write when several arrive at once', async () => {
        await Promise.all(
            Array.from({ length: 10 }, (_, index) => store.set(`cred-${index}`, `secret-${index}`)),
        );
        for (let index = 0; index < 10; index += 1) {
            expect(await store.get(`cred-${index}`)).toBe(`secret-${index}`);
        }
    });

    it('ignores an empty credential id', async () => {
        expect(await store.set('', 'hunter2')).toBe(false);
        expect(await store.has('')).toBe(false);
    });
});

describe('credentialStorePath', () => {
    it('places the vault inside the app’s own user-data directory', () => {
        expect(credentialStorePath('/data/httpreq')).toBe(
            join('/data/httpreq', 'credentials.enc.json'),
        );
    });
});
