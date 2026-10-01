/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { KnownHostEntry } from '@httpreq/shared';

/**
 * Application-managed known hosts.
 *
 * A host key is trusted only after the user has seen its fingerprint and said so. If a host later
 * offers a different key, {@link check} reports `changed`, and the connection is refused until the
 * user explicitly decides — the one thing SSH host verification exists to prevent is accepting
 * that silently.
 */

/** The `SHA256:...` form OpenSSH prints, so a fingerprint can be compared by eye. */
export const fingerprintOf = (key: Buffer): string =>
    `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** The key a host is stored under: lower-cased host plus port, since one host can run several SSH
 * servers.
 */
export const hostKeyOf = (host: string, port: number) => `${host.toLowerCase()}:${port}`;

export type HostKeyVerdict =
    { kind: 'trusted' } | { kind: 'unknown' } | { kind: 'changed'; storedFingerprint: string };

/** The user's trusted SSH host keys, kept in a JSON file. Writes are queued so concurrent
 * connections cannot interleave and corrupt the file.
 */
export class KnownHostsStore {
    private cache: KnownHostEntry[] | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly filePath: string) {}

    private async load(): Promise<KnownHostEntry[]> {
        if (this.cache) return this.cache;
        try {
            const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
            this.cache = Array.isArray(parsed)
                ? parsed.filter(
                      (item): item is KnownHostEntry =>
                          !!item &&
                          typeof item === 'object' &&
                          typeof (item as KnownHostEntry).host === 'string' &&
                          typeof (item as KnownHostEntry).fingerprint === 'string',
                  )
                : [];
        } catch {
            this.cache = [];
        }
        return this.cache;
    }

    private async flush(entries: KnownHostEntry[]): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8');
        await rename(temporary, this.filePath);
        this.cache = entries;
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.queue.then(operation, operation);
        this.queue = next.catch(() => undefined);
        return next;
    }

    async list(): Promise<KnownHostEntry[]> {
        return [...(await this.load())];
    }

    async check(host: string, port: number, fingerprint: string): Promise<HostKeyVerdict> {
        const key = hostKeyOf(host, port);
        const entry = (await this.load()).find((item) => hostKeyOf(item.host, item.port) === key);
        if (!entry) return { kind: 'unknown' };
        if (entry.fingerprint === fingerprint) return { kind: 'trusted' };
        return { kind: 'changed', storedFingerprint: entry.fingerprint };
    }

    /** Records the user's decision to trust this key, replacing any previous key for the host. */
    async trust(host: string, port: number, keyType: string, fingerprint: string): Promise<void> {
        await this.enqueue(async () => {
            const key = hostKeyOf(host, port);
            const entries = (await this.load()).filter(
                (item) => hostKeyOf(item.host, item.port) !== key,
            );
            entries.push({ host, port, keyType, fingerprint, trustedAt: new Date().toISOString() });
            await this.flush(entries);
        });
    }

    async forget(host: string, port: number): Promise<void> {
        await this.enqueue(async () => {
            const key = hostKeyOf(host, port);
            const entries = await this.load();
            const remaining = entries.filter((item) => hostKeyOf(item.host, item.port) !== key);
            if (remaining.length !== entries.length) await this.flush(remaining);
        });
    }
}

export const knownHostsPath = (userDataPath: string) => join(userDataPath, 'known-hosts.json');
