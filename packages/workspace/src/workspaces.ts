import { createId, type Workspace, type WorkspaceMeta } from '@httpreq/shared';

/**
 * Whole-workspace operations. A workspace owns every id inside it, so duplicating one has to
 * rewrite the entire id graph rather than deep-copying it: two workspaces that shared request or
 * profile ids would collide in tabs, drafts, history and the credential vault.
 */

/** Rewrites ids consistently: the same old id always maps to the same new one. */
const idRemapper = () => {
  const map = new Map<string, string>();
  return {
    next: (old: string) => {
      const existing = map.get(old);
      if (existing) return existing;
      const fresh = createId();
      map.set(old, fresh);
      return fresh;
    },
    /** Keeps a reference pointing at the copy when the target was copied too. */
    ref: (old: string | null) => (old === null ? null : (map.get(old) ?? old)),
  };
};

/**
 * A full copy of `workspace` under a new id and name.
 *
 * Every SSH profile in the copy is given a fresh `credentialId`, so the copy starts with no
 * password or passphrase: secrets live in the OS vault and are deliberately not duplicated.
 * The caller should tell the user that the copied connections need their credentials re-entered.
 */
export const duplicateWorkspace = (workspace: Workspace, name?: string): Workspace => {
  const remap = idRemapper();
  // Containers are mapped first so children can resolve their parents in a single pass.
  const collections = workspace.collections.map((item) => ({ ...item, id: remap.next(item.id) }));
  const folders = workspace.folders.map((item) => ({ ...item, id: remap.next(item.id) }));
  const environments = workspace.environments.map((item) => ({
    ...item,
    id: remap.next(item.id),
    variables: item.variables.map((variable) => ({ ...variable, id: createId() })),
  }));
  const sshProfiles = workspace.sshProfiles.map((item) => ({
    ...item,
    id: remap.next(item.id),
    credentialId: createId(),
  }));

  /** Points an environment link at the copied environment. */
  const relink = <T extends { environmentId?: string | null }>(item: T): T => {
    if (!item.environmentId) return item;
    const { environmentId, ...rest } = item;
    const copied = remap.ref(environmentId);
    return (copied ? { ...rest, environmentId: copied } : rest) as T;
  };

  return {
    ...structuredClone(workspace),
    id: createId(),
    name: (name ?? `${workspace.name} (copy)`).trim() || 'Workspace (copy)',
    collections: collections.map(relink),
    folders: folders.map((item) => relink({ ...item, parentId: remap.ref(item.parentId)! })),
    requests: workspace.requests.map((item) =>
      relink({
        ...structuredClone(item),
        id: remap.next(item.id),
        parentId: remap.ref(item.parentId),
      }),
    ),
    websocketRequests: workspace.websocketRequests.map((item) => ({
      ...structuredClone(item),
      id: remap.next(item.id),
      parentId: remap.ref(item.parentId),
    })),
    environments,
    activeEnvironmentId: remap.ref(workspace.activeEnvironmentId),
    sshProfiles,
    tunnelProfiles: workspace.tunnelProfiles.map((item) => ({
      ...item,
      id: remap.next(item.id),
      sshProfileId: remap.ref(item.sshProfileId) ?? '',
      // A copied tunnel never starts by itself: its SSH profile has no credential yet.
      autoStart: false,
    })),
    openRequestIds: workspace.openRequestIds.map((id) => remap.ref(id)!),
    updatedAt: new Date().toISOString(),
  };
};

export const renameWorkspace = (workspace: Workspace, name: string): Workspace => {
  const trimmed = name.trim();
  if (!trimmed || trimmed === workspace.name) return workspace;
  return { ...workspace, name: trimmed, updatedAt: new Date().toISOString() };
};

/** Most recently updated first, so the switcher shows what the user last worked on. */
export const sortWorkspaces = (items: WorkspaceMeta[]): WorkspaceMeta[] =>
  [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** A name that does not collide with the existing ones, e.g. "Staging (2)". */
export const uniqueWorkspaceName = (existing: readonly WorkspaceMeta[], base: string): string => {
  const taken = new Set(existing.map((item) => item.name.toLowerCase()));
  const trimmed = base.trim() || 'Workspace';
  if (!taken.has(trimmed.toLowerCase())) return trimmed;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${trimmed} (${suffix})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${trimmed} ${createId().slice(0, 8)}`;
};

/**
 * Resources whose live connections would be torn down by leaving this workspace. The switcher
 * uses it to warn before it closes sockets, shells and listening ports.
 */
export interface ActiveResourceCount {
  webSockets: number;
  sshSessions: number;
  tunnels: number;
}

export const totalActiveResources = (counts: ActiveResourceCount) =>
  counts.webSockets + counts.sshSessions + counts.tunnels;

export const describeActiveResources = (counts: ActiveResourceCount): string => {
  const parts: string[] = [];
  const add = (count: number, singular: string, plural: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`);
  };
  add(counts.webSockets, 'WebSocket connection', 'WebSocket connections');
  add(counts.sshSessions, 'SSH session', 'SSH sessions');
  add(counts.tunnels, 'active tunnel', 'active tunnels');
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
};
