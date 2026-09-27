import {
  createId,
  type Collection,
  type Folder,
  type HttpRequest,
  type TreeNodeKind,
  type WebSocketRequest,
  type Workspace,
} from '@httpreq/shared';

/**
 * Pure operations on the collection tree. Collections, folders, HTTP requests and WebSocket
 * requests are stored in flat arrays linked by `parentId`; array order is sibling order. Every
 * function returns a new workspace and leaves unrelated entities untouched (same object identity).
 *
 * HTTP and WebSocket requests keep separate arrays, so within one container the explorer shows
 * HTTP requests first and sockets after them. Each array is independently orderable.
 */

export type ContainerNode =
  { kind: 'collection'; node: Collection } | { kind: 'folder'; node: Folder };

export type LeafNode =
  { kind: 'request'; node: HttpRequest } | { kind: 'websocket'; node: WebSocketRequest };

export type TreeNode = ContainerNode | LeafNode;

export const findNode = (workspace: Workspace, id: string): TreeNode | undefined => {
  const collection = workspace.collections.find((item) => item.id === id);
  if (collection) return { kind: 'collection', node: collection };
  const folder = workspace.folders.find((item) => item.id === id);
  if (folder) return { kind: 'folder', node: folder };
  const request = workspace.requests.find((item) => item.id === id);
  if (request) return { kind: 'request', node: request };
  const socket = workspace.websocketRequests.find((item) => item.id === id);
  return socket ? { kind: 'websocket', node: socket } : undefined;
};

/** The node kinds that open in the tab strip. */
export const isLeafNode = (node: TreeNode): node is LeafNode =>
  node.kind === 'request' || node.kind === 'websocket';

const parentIdOf = (node: TreeNode): string | null =>
  node.kind === 'collection' ? null : node.node.parentId;

/** Containers from the root collection down to the direct parent of `id`. */
export const getAncestors = (workspace: Workspace, id: string): ContainerNode[] => {
  const start = findNode(workspace, id);
  const path: ContainerNode[] = [];
  let parentId = start ? parentIdOf(start) : null;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = findNode(workspace, parentId);
    if (!parent || isLeafNode(parent)) break;
    path.unshift(parent);
    parentId = parentIdOf(parent);
  }
  return path;
};

export const isAncestorOf = (workspace: Workspace, ancestorId: string, id: string) =>
  getAncestors(workspace, id).some((item) => item.node.id === ancestorId);

export const childFolders = (workspace: Workspace, parentId: string) =>
  workspace.folders.filter((folder) => folder.parentId === parentId);

export const childRequests = (workspace: Workspace, parentId: string | null) =>
  workspace.requests.filter((request) => request.parentId === parentId);

export const childWebSockets = (workspace: Workspace, parentId: string | null) =>
  workspace.websocketRequests.filter((request) => request.parentId === parentId);

/** Ids of `id` and everything beneath it, grouped by kind. */
export const collectSubtree = (workspace: Workspace, id: string) => {
  const containers = new Set<string>([id]);
  // Folders are appended in any order, so iterate until no new descendants are found.
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of workspace.folders) {
      if (containers.has(folder.parentId) && !containers.has(folder.id)) {
        containers.add(folder.id);
        grew = true;
      }
    }
  }
  const inSubtree = (item: { id: string; parentId: string | null }) =>
    item.id === id || (item.parentId !== null && containers.has(item.parentId));
  return {
    containers,
    requests: new Set(workspace.requests.filter(inSubtree).map((item) => item.id)),
    websockets: new Set(workspace.websocketRequests.filter(inSubtree).map((item) => item.id)),
  };
};

/** Ids of every tab-bearing node in the subtree, whatever its kind. */
export const collectSubtreeLeaves = (workspace: Workspace, id: string): Set<string> => {
  const { requests, websockets } = collectSubtree(workspace, id);
  return new Set([...requests, ...websockets]);
};

const touch = (workspace: Workspace, patch: Partial<Workspace>): Workspace => ({
  ...workspace,
  ...patch,
  updatedAt: new Date().toISOString(),
});

export const renameNode = (workspace: Workspace, id: string, name: string): Workspace => {
  const node = findNode(workspace, id);
  const trimmed = name.trim();
  if (!node || !trimmed || node.node.name === trimmed) return workspace;
  const rename = <T extends { id: string; name: string }>(items: T[]) =>
    items.map((item) => (item.id === id ? { ...item, name: trimmed } : item));
  switch (node.kind) {
    case 'collection':
      return touch(workspace, { collections: rename(workspace.collections) });
    case 'folder':
      return touch(workspace, { folders: rename(workspace.folders) });
    case 'request':
      return touch(workspace, { requests: rename(workspace.requests) });
    case 'websocket':
      return touch(workspace, { websocketRequests: rename(workspace.websocketRequests) });
  }
};

/** Moves `item` within `items` so that it sits before `beforeId` (or last). */
const reorder = <T extends { id: string }>(items: T[], item: T, beforeId: string | null) => {
  const rest = items.filter((candidate) => candidate.id !== item.id);
  const index = beforeId ? rest.findIndex((candidate) => candidate.id === beforeId) : -1;
  rest.splice(index >= 0 ? index : rest.length, 0, item);
  return rest;
};

/**
 * Moves a folder or request into `parentId` (a collection or folder; `null` makes a request a
 * draft), before sibling `beforeId` when given. Collections are only reordered. Invalid moves,
 * such as a folder into its own subtree, return the workspace unchanged.
 */
export const moveNode = (
  workspace: Workspace,
  id: string,
  parentId: string | null,
  beforeId: string | null = null,
): Workspace => {
  const node = findNode(workspace, id);
  if (!node || beforeId === id) return workspace;
  if (node.kind === 'collection') {
    return touch(workspace, { collections: reorder(workspace.collections, node.node, beforeId) });
  }
  const target = parentId ? findNode(workspace, parentId) : undefined;
  if (parentId && (!target || isLeafNode(target))) return workspace;
  if (node.kind === 'folder') {
    if (!parentId || parentId === id || isAncestorOf(workspace, id, parentId)) return workspace;
    return touch(workspace, {
      folders: reorder(workspace.folders, { ...node.node, parentId }, beforeId),
    });
  }
  if (node.kind === 'websocket') {
    return touch(workspace, {
      websocketRequests: reorder(workspace.websocketRequests, { ...node.node, parentId }, beforeId),
    });
  }
  return touch(workspace, {
    requests: reorder(workspace.requests, { ...node.node, parentId }, beforeId),
  });
};

/** Where a dragged node lands relative to the row it is dropped on. */
export type DropPosition = 'before' | 'after' | 'inside';

/** The explorer lists folders, then HTTP requests, then WebSocket requests within a container. */
const KIND_RANK: Record<TreeNode['kind'], number> = {
  collection: 0,
  folder: 0,
  request: 1,
  websocket: 2,
};

const siblingsOf = (workspace: Workspace, node: TreeNode, parentId: string | null) => {
  switch (node.kind) {
    case 'collection':
      return workspace.collections;
    case 'folder':
      return parentId ? childFolders(workspace, parentId) : [];
    case 'request':
      return childRequests(workspace, parentId);
    case 'websocket':
      return childWebSockets(workspace, parentId);
  }
};

/**
 * Resolves a drop of `id` onto `targetId` (`null` is the Drafts list) into the arguments of
 * {@link moveNode}, or `null` when the drop is not allowed: a collection anywhere but among
 * collections, a folder into its own subtree or out of every collection, or anything onto a
 * missing node. Dropping between nodes of another kind places the node where its own kind is
 * listed, as close to that spot as the explorer's ordering allows.
 */
export const resolveDrop = (
  workspace: Workspace,
  id: string,
  targetId: string | null,
  position: DropPosition,
): { parentId: string | null; beforeId: string | null } | null => {
  const node = findNode(workspace, id);
  if (!node) return null;
  if (targetId === null) return isLeafNode(node) ? { parentId: null, beforeId: null } : null;
  if (targetId === id) return null;
  const target = findNode(workspace, targetId);
  if (!target) return null;

  if (node.kind === 'collection') {
    if (target.kind !== 'collection' || position === 'inside') return null;
  } else if (target.kind === 'collection' && position !== 'inside') {
    // Nothing but a collection sits beside a collection.
    return null;
  }
  if (position === 'inside' && isLeafNode(target)) return null;

  const parentId = position === 'inside' ? targetId : parentIdOf(target);
  if (node.kind === 'folder') {
    if (!parentId || parentId === id || isAncestorOf(workspace, id, parentId)) return null;
  }
  if (position === 'inside') return { parentId, beforeId: null };

  const siblings = siblingsOf(workspace, node, parentId).filter((item) => item.id !== id);
  const rank = KIND_RANK[node.kind] - KIND_RANK[target.kind];
  if (rank < 0) return { parentId, beforeId: null };
  if (rank > 0) return { parentId, beforeId: siblings[0]?.id ?? null };
  if (position === 'before') return { parentId, beforeId: targetId };
  const index = siblings.findIndex((item) => item.id === targetId);
  return { parentId, beforeId: siblings[index + 1]?.id ?? null };
};

const copyName = (name: string) => `${name} (copy)`;

const rekey = <T extends { id: string }>(items: T[]) =>
  items.map((item) => ({ ...item, id: createId() }));

const cloneRequest = (request: HttpRequest, parentId: string | null): HttpRequest => {
  const copy = structuredClone(request);
  return {
    ...copy,
    id: createId(),
    parentId,
    params: rekey(copy.params),
    headers: rekey(copy.headers),
    body: {
      ...copy.body,
      formUrlEncoded: rekey(copy.body.formUrlEncoded),
      multipart: rekey(copy.body.multipart),
    },
  };
};

const cloneWebSocket = (request: WebSocketRequest, parentId: string | null): WebSocketRequest => {
  const copy = structuredClone(request);
  return {
    ...copy,
    id: createId(),
    parentId,
    params: rekey(copy.params),
    headers: rekey(copy.headers),
  };
};

/** Copies a node (and its subtree) next to the original. Returns the new workspace and root id. */
export const duplicateNode = (
  workspace: Workspace,
  id: string,
): { workspace: Workspace; id: string | null } => {
  const node = findNode(workspace, id);
  if (!node) return { workspace, id: null };
  if (node.kind === 'request') {
    const copy = { ...cloneRequest(node.node, node.node.parentId), name: copyName(node.node.name) };
    const requests = [...workspace.requests];
    requests.splice(requests.indexOf(node.node) + 1, 0, copy);
    return { workspace: touch(workspace, { requests }), id: copy.id };
  }
  if (node.kind === 'websocket') {
    const copy = {
      ...cloneWebSocket(node.node, node.node.parentId),
      name: copyName(node.node.name),
    };
    const websocketRequests = [...workspace.websocketRequests];
    websocketRequests.splice(websocketRequests.indexOf(node.node) + 1, 0, copy);
    return { workspace: touch(workspace, { websocketRequests }), id: copy.id };
  }

  const idMap = new Map<string, string>();
  const newId = (old: string) => {
    if (!idMap.has(old)) idMap.set(old, createId());
    return idMap.get(old)!;
  };
  const { containers, requests: requestIds, websockets: socketIds } = collectSubtree(workspace, id);
  const folders = workspace.folders
    .filter((folder) => containers.has(folder.id) && folder.id !== id)
    .map((folder) => ({
      ...structuredClone(folder),
      id: newId(folder.id),
      parentId: newId(folder.parentId),
    }));
  const requests = workspace.requests
    .filter((request) => requestIds.has(request.id))
    .map((request) => cloneRequest(request, newId(request.parentId!)));
  const sockets = workspace.websocketRequests
    .filter((request) => socketIds.has(request.id))
    .map((request) => cloneWebSocket(request, newId(request.parentId!)));

  if (node.kind === 'collection') {
    const root = { ...structuredClone(node.node), id: newId(id), name: copyName(node.node.name) };
    const collections = [...workspace.collections];
    collections.splice(collections.indexOf(node.node) + 1, 0, root);
    return {
      workspace: touch(workspace, {
        collections,
        folders: [...workspace.folders, ...folders],
        requests: [...workspace.requests, ...requests],
        websocketRequests: [...workspace.websocketRequests, ...sockets],
      }),
      id: root.id,
    };
  }
  const root = { ...structuredClone(node.node), id: newId(id), name: copyName(node.node.name) };
  const allFolders = [...workspace.folders];
  allFolders.splice(allFolders.indexOf(node.node) + 1, 0, root, ...folders);
  return {
    workspace: touch(workspace, {
      folders: allFolders,
      requests: [...workspace.requests, ...requests],
      websocketRequests: [...workspace.websocketRequests, ...sockets],
    }),
    id: root.id,
  };
};

export type LeafCopySource =
  { kind: 'request'; request: HttpRequest } | { kind: 'websocket'; request: WebSocketRequest };

/**
 * Adds a copy of a request, as given (for "Save as", that is with its unsaved edits), to the end
 * of `parentId` under `name`. The source request is left as it was. Returns the copy's id.
 */
export const insertLeafCopy = (
  workspace: Workspace,
  source: LeafCopySource,
  parentId: string | null,
  name: string,
): { workspace: Workspace; id: string } => {
  const trimmed = name.trim() || source.request.name;
  if (source.kind === 'request') {
    const copy = { ...cloneRequest(source.request, parentId), name: trimmed };
    return {
      workspace: touch(workspace, { requests: [...workspace.requests, copy] }),
      id: copy.id,
    };
  }
  const copy = { ...cloneWebSocket(source.request, parentId), name: trimmed };
  return {
    workspace: touch(workspace, { websocketRequests: [...workspace.websocketRequests, copy] }),
    id: copy.id,
  };
};

/** Deletes a node and its subtree. Returns the removed leaf ids so tabs and drafts can close. */
export const deleteNode = (
  workspace: Workspace,
  id: string,
): { workspace: Workspace; removedRequestIds: Set<string> } => {
  const node = findNode(workspace, id);
  if (!node) return { workspace, removedRequestIds: new Set() };
  const { containers, requests, websockets } = collectSubtree(workspace, id);
  const removedRequestIds = new Set([...requests, ...websockets]);
  return {
    workspace: touch(workspace, {
      collections: workspace.collections.filter((item) => !containers.has(item.id)),
      folders: workspace.folders.filter((item) => !containers.has(item.id)),
      requests: workspace.requests.filter((item) => !requests.has(item.id)),
      websocketRequests: workspace.websocketRequests.filter((item) => !websockets.has(item.id)),
      openRequestIds: workspace.openRequestIds.filter((openId) => !removedRequestIds.has(openId)),
    }),
    removedRequestIds,
  };
};

export const nodeKind = (workspace: Workspace, id: string): TreeNodeKind | undefined =>
  findNode(workspace, id)?.kind;
