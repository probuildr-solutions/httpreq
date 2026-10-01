/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createKeyValue, WORKSPACE_VERSION } from '@httpreq/shared';
import { createDefaultWorkspace } from '@httpreq/workspace';
import { LocalHistoryRepository, LocalWorkspaceRepository } from './index';

const memoryStorage = () => {
    const values = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => [...values.keys()][index] ?? null,
        removeItem: (key) => void values.delete(key),
        setItem: (key, value) => void values.set(key, value),
    };
    return { storage, values };
};

describe('LocalWorkspaceRepository', () => {
    it('round trips workspace data', async () => {
        const { storage } = memoryStorage();
        const repository = new LocalWorkspaceRepository(storage);
        const workspace = createDefaultWorkspace();
        await repository.saveWorkspace(workspace);
        expect(await repository.getWorkspace(workspace.id)).toEqual(workspace);
    });

    it('never persists literal secrets, but keeps variable references', async () => {
        const { storage, values } = memoryStorage();
        const repository = new LocalWorkspaceRepository(storage);
        const workspace = createDefaultWorkspace();
        workspace.requests[0]!.auth = {
            type: 'bearer',
            token: 'never-write-this',
            prefix: 'Bearer',
        };
        workspace.requests[0]!.headers = [
            createKeyValue({ key: 'X-Secret', value: 'hidden-header', secret: true }),
            createKeyValue({ key: 'X-Ref', value: '{{apiKey}}', secret: true }),
        ];
        workspace.collections[0]!.auth = { type: 'basic', username: 'ada', password: 'hunter2' };
        workspace.environments[0]!.variables.push({
            id: 's',
            key: 'token',
            value: 'env-secret',
            enabled: true,
            secret: true,
        });
        await repository.saveWorkspace(workspace);
        // Every record the save wrote: the workspace shell, each request and the index.
        const written = [...values.values()].join('\n');
        for (const secret of ['never-write-this', 'hidden-header', 'hunter2', 'env-secret']) {
            expect(written).not.toContain(secret);
        }
        expect(written).toContain('{{apiKey}}');
        expect(written).toContain('ada');
    });

    it('migrates version 1 data on load', async () => {
        const { storage } = memoryStorage();
        storage.setItem(
            'httpreq.workspace.default',
            JSON.stringify({
                id: 'default',
                name: 'Old',
                updatedAt: 'x',
                requests: [
                    {
                        id: 'r',
                        name: 'A',
                        method: 'GET',
                        url: 'https://a.dev',
                        params: [],
                        headers: [],
                        body: { type: 'none', content: '' },
                        auth: { type: 'none' },
                    },
                ],
            }),
        );
        const workspace = await new LocalWorkspaceRepository(storage).getWorkspace('default');
        expect(workspace).toMatchObject({ version: WORKSPACE_VERSION, openRequestIds: ['r'] });
    });

    it('stores drafts separately and removes the key when empty', async () => {
        const { storage, values } = memoryStorage();
        const repository = new LocalWorkspaceRepository(storage);
        const request = createDefaultWorkspace().requests[0]!;
        await repository.saveDrafts('default', {
            [request.id]: { ...request, url: 'https://draft' },
        });
        expect((await repository.getDrafts('default'))[request.id]!.url).toBe('https://draft');
        await repository.saveDrafts('default', {});
        expect(values.size).toBe(0);
    });
});

describe('LocalHistoryRepository', () => {
    it('keeps the newest entries up to the limit', async () => {
        const { storage } = memoryStorage();
        const repository = new LocalHistoryRepository(storage, 2);
        for (const id of ['1', '2', '3']) {
            await repository.add('w', {
                id,
                requestId: 'r',
                name: 'A',
                method: 'GET',
                url: '{{base}}',
                status: 200,
                statusText: 'OK',
                durationMs: 1,
                sizeBytes: 1,
                timestamp: new Date().toISOString(),
            });
        }
        expect((await repository.list('w')).map((entry) => entry.id)).toEqual(['3', '2']);
    });
});

describe('protocol secrets', () => {
    it('never persists the MQTT TLS client key', async () => {
        const { sanitizeRequest } = await import('./sanitize');
        const { createEmptyRequest, createMqttConfig } = await import('@httpreq/shared');
        const mqtt = createMqttConfig();
        mqtt.tls.clientKey = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
        mqtt.tls.caCertificate = 'CA';
        const saved = sanitizeRequest({ ...createEmptyRequest(), protocol: 'mqtt', mqtt });
        expect(JSON.stringify(saved)).not.toContain('PRIVATE KEY');
        expect(saved.mqtt?.tls.caCertificate).toBe('CA');
    });
});
