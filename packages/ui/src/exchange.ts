import { deserializeAuth } from '@httpreq/api-client';
import { createId, WORKSPACE_VERSION, type HttpRequest, type Workspace } from '@httpreq/shared';
import { sanitizeWorkspace } from '@httpreq/storage';
import { collectSubtree, migrateWorkspace } from '@httpreq/workspace';

/**
 * Local, file-based sharing. Exports are sanitized exactly like storage (no literal secrets);
 * imports are validated like stored data and receive fresh ids, so they never collide.
 */

const FORMAT_REQUEST = 'httpreq.request';
const FORMAT_COLLECTION = 'httpreq.collection';

const subset = (workspace: Workspace, patch: Partial<Workspace>): Workspace => ({
  ...workspace,
  collections: [],
  folders: [],
  requests: [],
  environments: [],
  openRequestIds: [],
  activeEnvironmentId: null,
  ...patch,
});

export const exportRequest = (workspace: Workspace, request: HttpRequest) => {
  const clean = sanitizeWorkspace(subset(workspace, { requests: [request] })).requests[0]!;
  return {
    format: FORMAT_REQUEST,
    version: WORKSPACE_VERSION,
    request: { ...clean, parentId: null },
  };
};

export const exportCollection = (workspace: Workspace, collectionId: string) => {
  const collection = workspace.collections.find((item) => item.id === collectionId);
  if (!collection) return null;
  const { containers, requests } = collectSubtree(workspace, collectionId);
  const clean = sanitizeWorkspace(
    subset(workspace, {
      collections: [collection],
      folders: workspace.folders.filter((folder) => containers.has(folder.id)),
      requests: workspace.requests.filter((request) => requests.has(request.id)),
    }),
  );
  return {
    format: FORMAT_COLLECTION,
    version: WORKSPACE_VERSION,
    collection: clean.collections[0]!,
    folders: clean.folders,
    requests: clean.requests,
  };
};

/** Saves text as a file through the browser's (or Electron's) download handling. */
export const downloadText = (fileName: string, text: string, type: string) => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Gives every imported entity a new id, keeping the references between them. */
const reassignIds = (imported: Workspace): Workspace => {
  const ids = new Map<string, string>();
  const map = (id: string) => {
    if (!ids.has(id)) ids.set(id, createId());
    return ids.get(id)!;
  };
  return {
    ...imported,
    collections: imported.collections.map((item) => ({ ...item, id: map(item.id) })),
    folders: imported.folders.map((item) => ({
      ...item,
      id: map(item.id),
      parentId: map(item.parentId),
    })),
    requests: imported.requests.map((item) => ({
      ...item,
      id: map(item.id),
      parentId: item.parentId ? map(item.parentId) : null,
    })),
  };
};

/** Whether parsed JSON is an HttpReq request or collection export. */
export const isHttpReqExport = (data: unknown) =>
  !!data &&
  typeof data === 'object' &&
  ((data as { format?: unknown }).format === FORMAT_COLLECTION ||
    (data as { format?: unknown }).format === FORMAT_REQUEST);

/**
 * Validates an HttpReq export and returns its contents with fresh ids, as a workspace fragment
 * (its collections, folders and requests only). Throws on anything that is not a valid export.
 */
export const parseHttpReqExport = (data: unknown): Workspace => {
  const record = (data ?? {}) as Record<string, unknown>;
  const base = {
    version: WORKSPACE_VERSION,
    id: 'import',
    name: 'Import',
    environments: [],
    activeEnvironmentId: null,
    openRequestIds: [],
    updatedAt: new Date().toISOString(),
  };
  let raw: Record<string, unknown>;
  if (record.format === FORMAT_COLLECTION) {
    raw = {
      ...base,
      collections: [record.collection],
      folders: record.folders,
      requests: record.requests,
    };
  } else if (record.format === FORMAT_REQUEST) {
    raw = {
      ...base,
      collections: [],
      folders: [],
      requests: [{ ...(record.request as object), parentId: null }],
    };
  } else {
    throw new Error('This is not an HttpReq request or collection export.');
  }
  const parsed = migrateWorkspace(raw, deserializeAuth);
  if (!parsed || (parsed.collections.length === 0 && parsed.requests.length === 0)) {
    throw new Error('The file does not contain a request or collection.');
  }
  return reassignIds(parsed);
};
