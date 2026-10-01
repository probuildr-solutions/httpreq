/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The one storage primitive the repositories are written against: an async key/value store of
 * JSON-serializable values.
 *
 * Both platforms reuse the same repository implementation on top of it, so workspace semantics
 * (isolation, the workspace index, the active-workspace pointer) exist in exactly one place. The
 * browser backs it with IndexedDB, and `localStorage` remains available as a fallback and for the
 * legacy data written before workspaces existed.
 */
export interface KeyValueStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /** Every key, optionally limited to those starting with `prefix`. */
    keys(prefix?: string): Promise<string[]>;
    /** Every key starting with `prefix`, with its value, read as one operation. */
    entries(prefix: string): Promise<[string, unknown][]>;
    /**
     * Writes and deletes several keys as one operation. Stores that support transactions (IndexedDB)
     * apply it atomically, so a reader never sees half of a multi-record update.
     */
    batch(operations: {
        set?: readonly (readonly [string, unknown])[];
        delete?: readonly string[];
    }): Promise<void>;
}

/** `entries` and `batch` for stores without a native bulk operation. */
const sequentialEntries = async (store: KeyValueStore, prefix: string) =>
    Promise.all(
        (await store.keys(prefix)).map(async (key): Promise<[string, unknown]> => [
            key,
            await store.get(key),
        ]),
    );

const sequentialBatch = async (
    store: KeyValueStore,
    operations: { set?: readonly (readonly [string, unknown])[]; delete?: readonly string[] },
) => {
    for (const [key, value] of operations.set ?? []) await store.set(key, value);
    for (const key of operations.delete ?? []) await store.delete(key);
};

/** In-memory store, for tests and as the last-resort fallback when nothing else is writable. */
export class MemoryStore implements KeyValueStore {
    private readonly values = new Map<string, string>();

    async get(key: string): Promise<unknown> {
        const raw = this.values.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as unknown);
    }

    async set(key: string, value: unknown): Promise<void> {
        this.values.set(key, JSON.stringify(value));
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key);
    }

    async keys(prefix = ''): Promise<string[]> {
        return [...this.values.keys()].filter((key) => key.startsWith(prefix));
    }

    entries(prefix: string): Promise<[string, unknown][]> {
        return sequentialEntries(this, prefix);
    }

    batch(operations: Parameters<KeyValueStore['batch']>[0]): Promise<void> {
        return sequentialBatch(this, operations);
    }

    get size(): number {
        return this.values.size;
    }
}

/**
 * `localStorage`/`sessionStorage` behind the async interface. Keys are namespaced so the store
 * can share a `Storage` with unrelated application data.
 */
export class WebStorageStore implements KeyValueStore {
    constructor(
        private readonly storage: Storage = localStorage,
        private readonly prefix = '',
    ) {}

    private full(key: string) {
        return `${this.prefix}${key}`;
    }

    async get(key: string): Promise<unknown> {
        const raw = this.storage.getItem(this.full(key));
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as unknown;
        } catch {
            // Corrupted entries read as missing rather than breaking the whole load.
            return null;
        }
    }

    async set(key: string, value: unknown): Promise<void> {
        this.storage.setItem(this.full(key), JSON.stringify(value));
    }

    async delete(key: string): Promise<void> {
        this.storage.removeItem(this.full(key));
    }

    async keys(prefix = ''): Promise<string[]> {
        const search = this.full(prefix);
        const found: string[] = [];
        for (let index = 0; index < this.storage.length; index += 1) {
            const key = this.storage.key(index);
            if (key?.startsWith(search)) found.push(key.slice(this.prefix.length));
        }
        return found;
    }

    entries(prefix: string): Promise<[string, unknown][]> {
        return sequentialEntries(this, prefix);
    }

    batch(operations: Parameters<KeyValueStore['batch']>[0]): Promise<void> {
        return sequentialBatch(this, operations);
    }
}

/**
 * The value as IndexedDB will store it. Workspace data is plain JSON-shaped objects, which the
 * structured clone accepts directly; only a value it rejects (a proxy, a class instance, a
 * function) pays for a JSON round trip. Always round-tripping, as this used to, cost two full
 * serializations of the workspace on the main thread for every write.
 */
const cloneable = (value: unknown, error: unknown) => {
    if (error instanceof DOMException && error.name === 'DataCloneError') {
        return JSON.parse(JSON.stringify(value)) as unknown;
    }
    throw error;
};

const DB_VERSION = 1;

/** Every string key that starts with `prefix` (no key used here contains U+FFFF). */
const PREFIX_END = String.fromCharCode(0xffff);
const prefixRange = (prefix: string) => IDBKeyRange.bound(prefix, prefix + PREFIX_END);

/**
 * IndexedDB store. Chosen over `localStorage` for workspace data because it is asynchronous,
 * far larger, and stores structured values without a JSON round trip on every read.
 *
 * The database handle is opened lazily and shared. When IndexedDB is unavailable or blocked
 * (private windows, disabled site data), `open` rejects and {@link createBrowserStore} falls back.
 */
export class IndexedDbStore implements KeyValueStore {
    private handle: Promise<IDBDatabase> | null = null;

    constructor(
        private readonly databaseName = 'httpreq',
        private readonly storeName = 'keyvalue',
    ) {}

    private open(): Promise<IDBDatabase> {
        this.handle ??= new Promise<IDBDatabase>((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB is unavailable.'));
                return;
            }
            const request = indexedDB.open(this.databaseName, DB_VERSION);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(this.storeName)) {
                    request.result.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = () => {
                // A later version opened elsewhere closes this connection; drop the cached handle so the
                // next call reopens instead of using a dead database.
                request.result.onversionchange = () => {
                    request.result.close();
                    this.handle = null;
                };
                resolve(request.result);
            };
            request.onerror = () =>
                reject(request.error ?? new Error('IndexedDB could not be opened.'));
            request.onblocked = () =>
                reject(new Error('IndexedDB is blocked by another connection.'));
        });
        return this.handle;
    }

    private async run<T>(
        mode: IDBTransactionMode,
        body: (store: IDBObjectStore) => IDBRequest,
    ): Promise<T> {
        const database = await this.open();
        return new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(this.storeName, mode);
            const request = body(transaction.objectStore(this.storeName));
            request.onsuccess = () => resolve(request.result as T);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
            transaction.onabort = () =>
                reject(transaction.error ?? new Error('IndexedDB aborted.'));
        });
    }

    async get(key: string): Promise<unknown> {
        const value = await this.run<unknown>('readonly', (store) => store.get(key));
        return value === undefined ? null : value;
    }

    async set(key: string, value: unknown): Promise<void> {
        await this.batch({ set: [[key, value]] });
    }

    async delete(key: string): Promise<void> {
        await this.run('readwrite', (store) => store.delete(key));
    }

    async keys(prefix = ''): Promise<string[]> {
        // A key range keeps the scan inside the prefix instead of reading every key in the database.
        const range = prefix ? prefixRange(prefix) : undefined;
        const keys = await this.run<IDBValidKey[]>('readonly', (store) => store.getAllKeys(range));
        return keys.filter((key): key is string => typeof key === 'string');
    }

    /**
     * One `getAll` over the prefix's key range. Far cheaper than a `get` per key: reading 5,000
     * request records took about 60 ms this way against 110 ms one by one.
     */
    async entries(prefix: string): Promise<[string, unknown][]> {
        const database = await this.open();
        return new Promise<[string, unknown][]>((resolve, reject) => {
            const transaction = database.transaction(this.storeName, 'readonly');
            const store = transaction.objectStore(this.storeName);
            const range = prefixRange(prefix);
            const keys = store.getAllKeys(range);
            const values = store.getAll(range);
            transaction.oncomplete = () =>
                resolve(keys.result.map((key, index) => [String(key), values.result[index]]));
            transaction.onerror = () =>
                reject(transaction.error ?? new Error('IndexedDB read failed.'));
            transaction.onabort = () =>
                reject(transaction.error ?? new Error('IndexedDB aborted.'));
        });
    }

    /** One read-write transaction: every write lands, or (on failure) none of them does. */
    async batch(operations: Parameters<KeyValueStore['batch']>[0]): Promise<void> {
        const writes = operations.set ?? [];
        const deletes = operations.delete ?? [];
        if (!writes.length && !deletes.length) return;
        const database = await this.open();
        await new Promise<void>((resolve, reject) => {
            const transaction = database.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            try {
                for (const [key, value] of writes) {
                    try {
                        store.put(value, key);
                    } catch (error) {
                        store.put(cloneable(value, error), key);
                    }
                }
                for (const key of deletes) store.delete(key);
            } catch (error) {
                transaction.abort();
                reject(error);
                return;
            }
            transaction.oncomplete = () => resolve();
            transaction.onerror = () =>
                reject(transaction.error ?? new Error('IndexedDB write failed.'));
            transaction.onabort = () =>
                reject(transaction.error ?? new Error('IndexedDB aborted.'));
        });
    }
}

/**
 * The best store this browser can offer: IndexedDB, falling back to `localStorage` and finally to
 * memory. The fallback is decided by a real probe write, because availability cannot be detected
 * from feature flags alone (private windows expose the APIs and then reject the operations).
 */
export const createBrowserStore = async (): Promise<KeyValueStore> => {
    const indexed = new IndexedDbStore();
    try {
        await indexed.keys();
        return indexed;
    } catch {
        // Falls through to the synchronous backends.
    }
    try {
        const store = new WebStorageStore(localStorage, 'httpreq.kv.');
        await store.set('__probe', 1);
        await store.delete('__probe');
        return store;
    } catch {
        return new MemoryStore();
    }
};
