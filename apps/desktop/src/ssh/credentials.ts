/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { safeStorage } from 'electron';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Passwords and private-key passphrases.
 *
 * Values are encrypted with Electron's `safeStorage`, whose key is held by the OS credential
 * system — the Windows Credential Manager, the macOS Keychain, or the Linux Secret Service /
 * kwallet — and written as ciphertext to a file in the app's user-data directory. The renderer can
 * write a secret and ask whether one exists; it can never read one back, and no secret is ever
 * part of a workspace, an export, a log line or an error message.
 *
 * When the OS refuses to provide a key (a Linux session with no keyring, for example) encryption
 * is unavailable and `set` fails rather than falling back to plaintext.
 */
export class CredentialStore {
    private cache: Record<string, string> | null = null;
    /** Serialises writes so two rapid saves cannot interleave and lose one another. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly filePath: string) {}

    static isAvailable(): boolean {
        try {
            return safeStorage.isEncryptionAvailable();
        } catch {
            return false;
        }
    }

    private async load(): Promise<Record<string, string>> {
        if (this.cache) return this.cache;
        try {
            const raw = await readFile(this.filePath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            this.cache =
                parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
        } catch {
            // Missing or unreadable vault: start empty rather than blocking every SSH action.
            this.cache = {};
        }
        return this.cache;
    }

    private async flush(entries: Record<string, string>): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        // Written to a temporary file and renamed, so a crash cannot leave a truncated vault.
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.filePath);
        this.cache = entries;
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.queue.then(operation, operation);
        this.queue = next.catch(() => undefined);
        return next;
    }

    /** Stores a secret, or removes it when `secret` is empty. False when encryption is unavailable. */
    async set(credentialId: string, secret: string): Promise<boolean> {
        if (!credentialId) return false;
        if (!secret) {
            await this.delete(credentialId);
            return true;
        }
        if (!CredentialStore.isAvailable()) return false;
        return this.enqueue(async () => {
            const entries = { ...(await this.load()) };
            entries[credentialId] = safeStorage.encryptString(secret).toString('base64');
            await this.flush(entries);
            return true;
        });
    }

    /** Main-process only: the plaintext secret, or null. Never reachable from the renderer. */
    async get(credentialId: string): Promise<string | null> {
        if (!credentialId || !CredentialStore.isAvailable()) return null;
        const entries = await this.load();
        const stored = entries[credentialId];
        if (!stored) return null;
        try {
            return safeStorage.decryptString(Buffer.from(stored, 'base64'));
        } catch {
            // Written under a different OS key (restored profile, new machine): treat as absent.
            return null;
        }
    }

    async has(credentialId: string): Promise<boolean> {
        if (!credentialId) return false;
        return !!(await this.load())[credentialId];
    }

    async delete(credentialId: string): Promise<void> {
        await this.enqueue(async () => {
            const entries = { ...(await this.load()) };
            if (!(credentialId in entries)) return;
            delete entries[credentialId];
            if (Object.keys(entries).length === 0) {
                await unlink(this.filePath).catch(() => undefined);
                this.cache = {};
                return;
            }
            await this.flush(entries);
        });
    }
}

export const credentialStorePath = (userDataPath: string) =>
    join(userDataPath, 'credentials.enc.json');
