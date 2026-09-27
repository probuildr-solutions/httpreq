import { describe, expect, it } from 'vitest';
import {
  createCollection,
  createEmptyRequest,
  createFolder,
  createKeyValue,
  createWebSocketRequest,
  WORKSPACE_VERSION,
  type Workspace,
} from '@httpreq/shared';
import {
  createDefaultWorkspace,
  deleteNode,
  duplicateNode,
  collectSubtree,
  getAncestors,
  insertLeafCopy,
  migrateWorkspace,
  moveNode,
  paramsFromUrl,
  renameNode,
  resolveDrop,
  urlWithParams,
} from './index';

const sample = () => {
  const collection = createCollection('API');
  const v1 = createFolder(collection.id, 'v1');
  const auth = createFolder(v1.id, 'auth');
  const request = { ...createEmptyRequest(auth.id), name: 'login' };
  const workspace: Workspace = {
    ...createDefaultWorkspace(),
    collections: [collection],
    folders: [v1, auth],
    requests: [request],
    openRequestIds: [request.id],
  };
  return { workspace, collection, v1, auth, request };
};

describe('query sync', () => {
  it('derives params from the URL, keeping ids and disabled rows', () => {
    const kept = createKeyValue({ key: 'page', value: '1', description: 'Page' });
    const disabled = createKeyValue({ key: 'debug', value: 'true', enabled: false });
    const params = paramsFromUrl('{{base}}/users?page=2&q={{term}}', [kept, disabled]);
    expect(params.map(({ key, value, enabled }) => ({ key, value, enabled }))).toEqual([
      { key: 'page', value: '2', enabled: true },
      { key: 'q', value: '{{term}}', enabled: true },
      { key: 'debug', value: 'true', enabled: false },
    ]);
    expect(params[0]).toMatchObject({ id: kept.id, description: 'Page' });
  });

  it('rebuilds the URL from enabled params without encoding variables', () => {
    const url = urlWithParams('{{base}}/users?old=1#top', [
      createKeyValue({ key: 'q', value: '{{term}}' }),
      createKeyValue({ key: 'a&b', value: 'x#y' }),
      createKeyValue({ key: 'off', value: '1', enabled: false }),
      createKeyValue({ key: 'flag', value: '' }),
    ]);
    expect(url).toBe('{{base}}/users?q={{term}}&a%26b=x%23y&flag#top');
  });

  it('round-trips, dropping only the "=" of empty values', () => {
    const url = 'https://x.dev/a?b=1&c=&d&e={{v}}';
    expect(urlWithParams(url, paramsFromUrl(url, []))).toBe('https://x.dev/a?b=1&c&d&e={{v}}');
  });
});

describe('tree operations', () => {
  it('lists ancestors from the collection down', () => {
    const { workspace, request } = sample();
    expect(getAncestors(workspace, request.id).map((item) => item.node.name)).toEqual([
      'API',
      'v1',
      'auth',
    ]);
  });

  it('renames by id and ignores blank names', () => {
    const { workspace, request } = sample();
    const renamed = renameNode(workspace, request.id, '  adminLogin ');
    expect(renamed.requests[0]!.name).toBe('adminLogin');
    expect(renameNode(renamed, request.id, '   ')).toBe(renamed);
  });

  it('refuses to move a folder into its own subtree', () => {
    const { workspace, v1, auth } = sample();
    expect(moveNode(workspace, v1.id, auth.id)).toBe(workspace);
    const moved = moveNode(workspace, auth.id, workspace.collections[0]!.id);
    expect(moved.folders.find((folder) => folder.id === auth.id)!.parentId).toBe(
      workspace.collections[0]!.id,
    );
  });

  it('moves a folder with everything inside it to another collection', () => {
    const { workspace, v1, auth, request } = sample();
    const other = createCollection('Other');
    const socket = { ...createWebSocketRequest(auth.id), name: 'feed' };
    const start = {
      ...workspace,
      collections: [...workspace.collections, other],
      websocketRequests: [socket],
    };
    const moved = moveNode(start, v1.id, other.id);
    const subtree = collectSubtree(moved, other.id);
    expect(subtree.containers).toEqual(new Set([other.id, v1.id, auth.id]));
    expect(subtree.requests).toEqual(new Set([request.id]));
    expect(subtree.websockets).toEqual(new Set([socket.id]));
    // Contents keep their data and their place in the hierarchy.
    expect(moved.requests[0]).toEqual(request);
    expect(moved.folders.find((folder) => folder.id === auth.id)!.parentId).toBe(v1.id);
  });

  describe('resolveDrop', () => {
    const tree = () => {
      const base = sample();
      const other = createCollection('Other');
      const a = { ...createEmptyRequest(base.v1.id), name: 'a' };
      const b = { ...createEmptyRequest(base.v1.id), name: 'b' };
      const draft = createEmptyRequest(null);
      const socket = createWebSocketRequest(base.v1.id);
      const workspace: Workspace = {
        ...base.workspace,
        collections: [...base.workspace.collections, other],
        requests: [...base.workspace.requests, a, b, draft],
        websocketRequests: [socket],
      };
      return { ...base, workspace, other, a, b, draft, socket };
    };

    it('drops into containers and next to siblings', () => {
      const { workspace, v1, auth, a, b, request } = tree();
      expect(resolveDrop(workspace, request.id, v1.id, 'inside')).toEqual({
        parentId: v1.id,
        beforeId: null,
      });
      expect(resolveDrop(workspace, request.id, a.id, 'before')).toEqual({
        parentId: v1.id,
        beforeId: a.id,
      });
      expect(resolveDrop(workspace, request.id, a.id, 'after')).toEqual({
        parentId: v1.id,
        beforeId: b.id,
      });
      expect(resolveDrop(workspace, request.id, b.id, 'after')).toEqual({
        parentId: v1.id,
        beforeId: null,
      });
      // A request dropped beside a folder goes first among the requests there.
      expect(resolveDrop(workspace, request.id, auth.id, 'before')).toEqual({
        parentId: v1.id,
        beforeId: a.id,
      });
    });

    it('moves a subfolder back up to the level of its parent', () => {
      const { workspace, v1, auth, collection } = tree();
      const drop = resolveDrop(workspace, auth.id, v1.id, 'after');
      expect(drop).toEqual({ parentId: collection.id, beforeId: null });
      const moved = moveNode(workspace, auth.id, drop!.parentId, drop!.beforeId);
      expect(getAncestors(moved, auth.id).map((item) => item.node.id)).toEqual([collection.id]);
    });

    it('refuses invalid drops', () => {
      const { workspace, v1, auth, collection, other, a, request } = tree();
      expect(resolveDrop(workspace, v1.id, v1.id, 'inside')).toBeNull();
      expect(resolveDrop(workspace, v1.id, auth.id, 'inside')).toBeNull();
      expect(resolveDrop(workspace, v1.id, request.id, 'before')).toBeNull();
      expect(resolveDrop(workspace, v1.id, null, 'inside')).toBeNull();
      expect(resolveDrop(workspace, a.id, a.id, 'before')).toBeNull();
      expect(resolveDrop(workspace, a.id, request.id, 'inside')).toBeNull();
      expect(resolveDrop(workspace, a.id, collection.id, 'before')).toBeNull();
      expect(resolveDrop(workspace, collection.id, other.id, 'inside')).toBeNull();
      expect(resolveDrop(workspace, collection.id, v1.id, 'before')).toBeNull();
    });

    it('reorders collections and turns requests into drafts', () => {
      const { workspace, collection, other, draft, a, socket } = tree();
      expect(resolveDrop(workspace, other.id, collection.id, 'before')).toEqual({
        parentId: null,
        beforeId: collection.id,
      });
      expect(resolveDrop(workspace, a.id, null, 'inside')).toEqual({
        parentId: null,
        beforeId: null,
      });
      expect(resolveDrop(workspace, socket.id, draft.id, 'after')).toEqual({
        parentId: null,
        beforeId: null,
      });
      expect(resolveDrop(workspace, draft.id, other.id, 'inside')).toEqual({
        parentId: other.id,
        beforeId: null,
      });
    });
  });

  it('inserts a renamed copy of a request with fresh ids', () => {
    const { workspace, collection, request } = sample();
    const edited = { ...request, url: 'https://example.com', headers: [createKeyValue()] };
    const { workspace: next, id } = insertLeafCopy(
      workspace,
      { kind: 'request', request: edited },
      collection.id,
      '  Copy  ',
    );
    const copy = next.requests.find((item) => item.id === id)!;
    expect(next.requests[0]).toBe(request);
    expect(copy).toMatchObject({ name: 'Copy', parentId: collection.id, url: edited.url });
    expect(copy.headers[0]!.id).not.toBe(edited.headers[0]!.id);
  });

  it('duplicates a folder subtree with fresh ids', () => {
    const { workspace, v1 } = sample();
    const { workspace: next, id } = duplicateNode(workspace, v1.id);
    expect(next.folders).toHaveLength(4);
    expect(next.requests).toHaveLength(2);
    const copy = next.requests[1]!;
    expect(copy.id).not.toBe(workspace.requests[0]!.id);
    expect(getAncestors(next, copy.id)[1]!.node.id).toBe(id);
  });

  it('deletes a subtree and closes its requests', () => {
    const { workspace, collection, request } = sample();
    const { workspace: next, removedRequestIds } = deleteNode(workspace, collection.id);
    expect(next.folders).toHaveLength(0);
    expect(next.requests).toHaveLength(0);
    expect(next.openRequestIds).toEqual([]);
    expect(removedRequestIds.has(request.id)).toBe(true);
  });
});

describe('migrateWorkspace', () => {
  it('upgrades version 1 workspaces', () => {
    const migrated = migrateWorkspace({
      id: 'default',
      name: 'Old',
      updatedAt: '2025-01-01T00:00:00.000Z',
      requests: [
        {
          id: 'r1',
          name: 'Users',
          method: 'POST',
          url: 'https://api.example.com/users',
          params: [{ id: 'p', key: 'page', value: '2', enabled: true }],
          headers: [],
          body: { type: 'json', content: '{"a":1}' },
          auth: { type: 'bearer', token: '' },
        },
      ],
    })!;
    expect(migrated.version).toBe(WORKSPACE_VERSION);
    expect(migrated.openRequestIds).toEqual(['r1']);
    expect(migrated.requests[0]).toMatchObject({
      parentId: null,
      url: 'https://api.example.com/users?page=2',
      body: { mode: 'json', json: '{"a":1}' },
    });
  });

  it('drops dangling references', () => {
    const { workspace } = sample();
    const broken = {
      ...workspace,
      folders: [...workspace.folders, { ...createFolder('ghost'), name: 'orphan' }],
      openRequestIds: ['missing', workspace.requests[0]!.id],
      activeEnvironmentId: 'missing',
    };
    const migrated = migrateWorkspace(JSON.parse(JSON.stringify(broken)))!;
    expect(migrated.folders.map((folder) => folder.name)).toEqual(['v1', 'auth']);
    expect(migrated.openRequestIds).toEqual([workspace.requests[0]!.id]);
    expect(migrated.activeEnvironmentId).toBeNull();
  });

  it('rejects non-workspaces', () => {
    expect(migrateWorkspace({ foo: 1 })).toBeNull();
  });
});
