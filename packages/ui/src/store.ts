/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import {
    createCollection,
    createEmptyRequest,
    createEnvironment,
    createFolder,
    createId,
    deepEqual,
    withEnvironmentLink,
    createWebSocketRequest as newSocketRequest,
    type AuthConfig,
    type Environment,
    type HistoryEntry,
    type HttpRequest,
    type HttpResponse,
    type ScriptReport,
    type SseEvent,
    type StreamHead,
    type RequestKind,
    type WebSocketRequest,
    type Workspace,
    type WorkspaceMeta,
} from '@httpreq/shared';
import {
    createDefaultWorkspace,
    deleteNode as deleteTreeNode,
    duplicateNode as duplicateTreeNode,
    findNode,
    getAncestors,
    insertLeafCopy,
    isLeafNode,
    collectionIdOf,
    linkedEnvironmentId,
    moveNode as moveTreeNode,
    renameNode as renameTreeNode,
} from '@httpreq/workspace';
import {
    createConnectionProfilesSlice,
    type ConnectionProfilesSlice,
} from './storeSlices/connectionProfiles';
import {
    createEnvironmentTabsSlice,
    type EnvironmentTabsSlice,
} from './storeSlices/environmentTabs';
import { nearestOpen, touch } from './storeSlices/helpers';
import { createSshTabsSlice, type SshTabsSlice } from './storeSlices/sshTabs';

export const EDITOR_TABS = [
    'overview',
    'params',
    'body',
    'headers',
    'authorization',
    'protocol',
    'scripts',
    'sharing',
    'settings',
] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export const SIDEBAR_VIEWS = ['collections', 'environments', 'history', 'ssh', 'tunnels'] as const;
export type SidebarView = (typeof SIDEBAR_VIEWS)[number];

/** Sidebar views that only exist in the desktop app. */
export const DESKTOP_SIDEBAR_VIEWS: readonly SidebarView[] = ['ssh', 'tunnels'];

/** Only in-flight and failed saves are tracked; "saved" and "modified" derive from drafts. */
export type SaveStatus = 'saving' | 'failed';

/** Everything the workbench holds: the durable workspace, unsaved drafts and ephemeral UI state,
 * plus the actions that change them. Tab and profile actions live in slices (see `storeSlices/`).
 */
export interface WorkbenchState
    extends EnvironmentTabsSlice, SshTabsSlice, ConnectionProfilesSlice {
    /** Durable data: exactly what was last committed (and is being persisted). */
    workspace: Workspace;
    /** Every workspace that exists, for the switcher. Kept in step by the persistence layer. */
    workspaces: WorkspaceMeta[];
    /** Set while a workspace is being loaded, so the UI can block edits to the outgoing one. */
    switching: boolean;
    /**
     * Unsaved edits, keyed by request id. The editor always shows `drafts[id] ?? saved`; a draft
     * is dropped as soon as it matches the saved request again. Name and parent are structural
     * and are written to the saved request and its draft together, so they never diverge.
     */
    drafts: Record<string, HttpRequest>;
    activeRequestId: string | null;
    responses: Record<string, HttpResponse | undefined>;
    /** What the scripts of the last send of a request produced (tests, logs), by request id. */
    scriptReports: Record<string, ScriptReport | undefined>;
    /** Streams (SSE) that are open right now, keyed by request id; gone once the stream ends. */
    streams: Record<string, LiveStream | undefined>;
    saveStatus: Record<string, SaveStatus | undefined>;
    history: HistoryEntry[];
    /* Explorer state (ephemeral). */
    selectedNodeId: string | null;
    expandedIds: ReadonlySet<string>;
    renamingId: string | null;
    /** Incremented to ask the explorer to scroll the selected node into view and focus it. */
    revealNonce: number;
    sidebarView: SidebarView;
    editorTabs: Record<string, EditorTab | undefined>;
    /**
     * SSH terminal tabs, in tab order. They are deliberately not persisted: a shell cannot survive
     * a restart, so reopening the app to a row of dead terminals would be a lie.
     */
    openSshSessionIds: string[];
    activeSshSessionId: string | null;
    /**
     * Environment editor tabs, in tab order, after the request tabs. Like terminals they are not
     * persisted; unlike requests there is nothing unsaved to restore, as every edit is committed.
     */
    openEnvironmentTabIds: string[];
    activeEnvironmentTabId: string | null;
    /** An environment just created, whose editor should start with its name selected. */
    namingEnvironmentId: string | null;

    load: (
        workspace: Workspace,
        drafts: Record<string, HttpRequest>,
        history: HistoryEntry[],
    ) => void;
    setWorkspaces: (workspaces: WorkspaceMeta[]) => void;
    setSwitching: (switching: boolean) => void;
    renameWorkspace: (name: string) => void;
    /* Tabs */
    openRequest: (id: string) => void;
    closeRequest: (id: string) => void;
    /** Closes several tabs in one update, so the active tab settles only once. */
    closeRequests: (ids: Iterable<string>) => void;
    setActiveRequest: (id: string) => void;
    cycleRequest: (offset: number) => void;
    moveTab: (id: string, toIndex: number) => void;
    /* Request editing */
    editRequest: (id: string, patch: Partial<HttpRequest>) => void;
    discardDraft: (id: string) => void;
    /** Applies a successful save of `committed` (the draft snapshot that was written). */
    commitSaved: (
        committed: HttpRequest,
        draft: HttpRequest,
        written: Workspace,
        base: Workspace,
    ) => void;
    setSaveStatus: (id: string, status: SaveStatus | undefined) => void;
    setResponse: (id: string, response: HttpResponse) => void;
    setScriptReport: (id: string, report: ScriptReport | undefined) => void;
    /** Applies the environment variables a script set or removed to the active environment. */
    applyScriptEnvironment: (changes: ScriptReport['environmentChanges']) => void;
    startStream: (id: string, head: StreamHead) => void;
    appendStreamEvents: (id: string, events: SseEvent[]) => void;
    endStream: (id: string) => void;
    setEditorTab: (id: string, tab: EditorTab) => void;
    /* Tree */
    createCollection: () => string;
    createFolder: (parentId: string) => string;
    createRequest: (parentId: string | null) => string;
    createWebSocketRequest: (parentId: string | null) => string;
    /** WebSocket requests have no draft cycle: an edit is committed to the workspace at once. */
    editWebSocketRequest: (id: string, patch: Partial<WebSocketRequest>) => void;
    renameNode: (id: string, name: string) => void;
    moveNode: (id: string, parentId: string | null, beforeId?: string | null) => void;
    /**
     * "Save as" for an HTTP or WebSocket request. A draft (in no collection) is renamed and moved
     * into `parentId`, keeping its tab and its unsaved edits for the caller to commit. A request
     * already in a collection is left as last saved, and a copy carrying its edits takes over its
     * tab. Returns the id of the request that now holds the edits, or null when there is none.
     */
    saveRequestAs: (id: string, parentId: string, name: string) => string | null;
    duplicateNode: (id: string) => void;
    deleteNode: (id: string) => void;
    updateContainer: (id: string, patch: { auth?: AuthConfig; description?: string }) => void;
    /**
     * Adopts a workspace that gained imported data. An imported collection is revealed and an
     * imported request opened; an imported environment just appears in the environment picker.
     */
    applyImport: (
        workspace: Workspace,
        rootId: string | null,
        kind: 'collection' | 'request' | 'environment',
    ) => void;
    selectNode: (id: string | null) => void;
    toggleExpanded: (id: string, expanded?: boolean) => void;
    revealNode: (id: string) => void;
    setRenaming: (id: string | null) => void;
    setSidebarView: (view: SidebarView) => void;
    /* Environments */
    createEnvironment: () => string;
    updateEnvironment: (id: string, patch: Partial<Omit<Environment, 'id'>>) => void;
    /** Returns the copy's id, or null when there is no such environment. */
    duplicateEnvironment: (id: string) => string | null;
    deleteEnvironment: (id: string) => void;
    /** Deletes several environments in one change, closing their tabs. */
    deleteEnvironments: (ids: Iterable<string>) => void;
    /**
     * Links an environment to the collection that contains `id` (`null` unlinks); its folders and
     * requests inherit it. Does nothing for a request that is not in a collection.
     */
    linkEnvironment: (id: string, environmentId: string | null) => void;
    /** Creates or updates a variable in the active environment (e.g. a retrieved OAuth token). */
    setEnvironmentVariable: (key: string, value: string, secret: boolean) => boolean;
    setHistory: (history: HistoryEntry[]) => void;
}

/** Whether a tab id belongs to an HTTP or a WebSocket request. */
export const requestKind = (workspace: Workspace, id: string): RequestKind | undefined => {
    const node = findNode(workspace, id);
    return node && isLeafNode(node) ? node.kind : undefined;
};

export const findWebSocketRequest = (workspace: Workspace, id: string | null) =>
    id ? workspace.websocketRequests.find((request) => request.id === id) : undefined;

/** Tunnel profiles that would stop working if this SSH profile were deleted. */
export const tunnelsUsingSshProfile = (workspace: Workspace, sshProfileId: string) =>
    workspace.tunnelProfiles.filter((tunnel) => tunnel.sshProfileId === sshProfileId);

const same = (a: HttpRequest, b: HttpRequest) => deepEqual(a, b);

/**
 * Structural fields (name, parent, linked environment) belong to the saved request and are
 * changed through tree actions only, so an edited copy always takes them from the saved one.
 */
const withStructure = (edited: HttpRequest, saved: HttpRequest): HttpRequest => {
    return withEnvironmentLink(
        { ...edited, id: saved.id, name: saved.name, parentId: saved.parentId },
        saved.environmentId ?? null,
    );
};

/**
 * Makes the environment linked to the collection of `id` the active one, or none when nothing is
 * linked, so the environment shown always belongs to what is selected. There is no manual
 * switch: this is derived from the selection and deliberately does not touch `updatedAt`.
 */
const activateFor = (workspace: Workspace, id: string | null): Workspace => {
    if (!id) return workspace;
    const linked = linkedEnvironmentId(workspace, id);
    return linked === workspace.activeEnvironmentId
        ? workspace
        : { ...workspace, activeEnvironmentId: linked };
};

/** The version of a request the editor shows: its draft if it has unsaved edits. */
export const editableRequest = (
    state: Pick<WorkbenchState, 'workspace' | 'drafts'>,
    id: string | null,
): HttpRequest | undefined =>
    id
        ? (state.drafts[id] ?? state.workspace.requests.find((request) => request.id === id))
        : undefined;

/** An open Server-Sent Events stream, shown while it is still receiving. */
export interface LiveStream {
    head: StreamHead;
    events: SseEvent[];
    /** Older events dropped to bound memory. */
    dropped: number;
}

/** Most events a live stream keeps on screen; matches what the transport keeps for the result. */
const MAX_LIVE_EVENTS = 10_000;

/** The workspace's active environment, or null when none is selected. */
export const activeEnvironment = (workspace: Workspace) =>
    workspace.environments.find(
        (environment) => environment.id === workspace.activeEnvironmentId,
    ) ?? null;

/** A never-used blank socket, which disappears with its tab instead of cluttering the tree. */
const isPristineSocket = (request: WebSocketRequest) =>
    request.parentId === null &&
    !request.url &&
    request.name === 'Untitled Socket' &&
    !request.draftMessage &&
    request.headers.length === 0;

const isPristineDraft = (request: HttpRequest) =>
    request.parentId === null &&
    !request.url &&
    request.name === 'Untitled Request' &&
    request.body.mode === 'none' &&
    request.headers.length === 0;

/**
 * The tab that takes over when the active one closes: the nearest still-open tab to its left,
 * else the nearest to its right, else nothing.
 */
const without = <T>(record: Record<string, T>, ids: Iterable<string>) => {
    const next = { ...record };
    for (const id of ids) delete next[id];
    return next;
};

const withExpanded = (ids: ReadonlySet<string>, add: Iterable<string>) => {
    const next = new Set(ids);
    for (const id of add) next.add(id);
    return next;
};

const initial = createDefaultWorkspace();

/** The workbench store. Core workspace actions are defined here; terminal tabs, environment tabs
 * and connection profiles are composed in from their own slices.
 */
export const useWorkbenchStore = create<WorkbenchState>((set, get, api) => ({
    ...createEnvironmentTabsSlice(set, get, api),
    ...createSshTabsSlice(set, get, api),
    ...createConnectionProfilesSlice(set, get, api),
    workspace: initial,
    workspaces: [],
    switching: false,
    drafts: {},
    activeRequestId: initial.openRequestIds[0] ?? null,
    responses: {},
    scriptReports: {},
    streams: {},
    saveStatus: {},
    history: [],
    selectedNodeId: null,
    expandedIds: new Set(initial.collections.map((collection) => collection.id)),
    renamingId: null,
    revealNonce: 0,
    sidebarView: 'collections',
    editorTabs: {},
    openSshSessionIds: [],
    activeSshSessionId: null,
    openEnvironmentTabIds: [],
    activeEnvironmentTabId: null,
    namingEnvironmentId: null,

    load: (workspace, drafts, history) => {
        const requestIds = new Set(workspace.requests.map((request) => request.id));
        const liveDrafts = Object.fromEntries(
            Object.entries(drafts)
                .filter(([id]) => requestIds.has(id))
                .map(([id, draft]) => {
                    const saved = workspace.requests.find((request) => request.id === id)!;
                    return [id, withStructure(draft, saved)];
                }),
        );
        const active = workspace.openRequestIds[0] ?? null;
        set({
            workspace: activateFor(workspace, active),
            drafts: liveDrafts,
            history,
            switching: false,
            activeRequestId: active,
            responses: {},
            scriptReports: {},
            streams: {},
            saveStatus: {},
            // Terminals belong to the workspace that opened them and do not survive a switch.
            openSshSessionIds: [],
            activeSshSessionId: null,
            openEnvironmentTabIds: [],
            activeEnvironmentTabId: null,
            namingEnvironmentId: null,
            selectedNodeId: active,
            expandedIds: new Set([
                ...workspace.collections.map((collection) => collection.id),
                ...(active ? getAncestors(workspace, active).map((item) => item.node.id) : []),
            ]),
        });
    },

    setWorkspaces: (workspaces) => set({ workspaces }),

    setSwitching: (switching) => set({ switching }),

    renameWorkspace: (name) =>
        set((state) => {
            const trimmed = name.trim();
            if (!trimmed || trimmed === state.workspace.name) return state;
            return { workspace: touch(state.workspace, { name: trimmed }) };
        }),

    openRequest: (id) =>
        set((state) => {
            if (!requestKind(state.workspace, id)) return state;
            const open = state.workspace.openRequestIds;
            if (open.includes(id))
                return {
                    workspace: activateFor(state.workspace, id),
                    activeRequestId: id,
                    selectedNodeId: id,
                    activeEnvironmentTabId: null,
                };
            const index = state.activeRequestId ? open.indexOf(state.activeRequestId) : -1;
            const openRequestIds = [...open];
            openRequestIds.splice(index >= 0 ? index + 1 : open.length, 0, id);
            return {
                workspace: activateFor(touch(state.workspace, { openRequestIds }), id),
                activeRequestId: id,
                selectedNodeId: id,
                activeEnvironmentTabId: null,
            };
        }),

    closeRequest: (id) => get().closeRequests([id]),

    closeRequests: (ids) =>
        set((state) => {
            const open = state.workspace.openRequestIds;
            const closing = new Set([...ids].filter((id) => open.includes(id)));
            if (!closing.size) return state;
            const openRequestIds = open.filter((id) => !closing.has(id));
            // Blank scratch requests that were never used disappear with their tabs.
            const dropped = new Set(
                state.workspace.requests
                    .filter(
                        (request) =>
                            closing.has(request.id) &&
                            !state.drafts[request.id] &&
                            isPristineDraft(request),
                    )
                    .map((request) => request.id),
            );
            const droppedSockets = new Set(
                state.workspace.websocketRequests
                    .filter((request) => closing.has(request.id) && isPristineSocket(request))
                    .map((request) => request.id),
            );
            const active = state.activeRequestId;
            const nextActive =
                active !== null && closing.has(active)
                    ? nearestOpen(open, closing, active)
                    : active;
            // Closing the last request tab moves on to an environment tab rather than to an empty pane.
            const fallback =
                active !== null && nextActive === null && !state.activeSshSessionId
                    ? (state.openEnvironmentTabIds[0] ?? null)
                    : null;
            const closed = touch(state.workspace, {
                openRequestIds,
                ...(dropped.size
                    ? {
                          requests: state.workspace.requests.filter(
                              (request) => !dropped.has(request.id),
                          ),
                      }
                    : {}),
                ...(droppedSockets.size
                    ? {
                          websocketRequests: state.workspace.websocketRequests.filter(
                              (request) => !droppedSockets.has(request.id),
                          ),
                      }
                    : {}),
            });
            return {
                workspace: activateFor(closed, nextActive),
                drafts: without(state.drafts, closing),
                saveStatus: without(state.saveStatus, closing),
                activeRequestId: nextActive,
                ...(fallback ? { activeEnvironmentTabId: fallback } : {}),
            };
        }),

    setActiveRequest: (activeRequestId) =>
        set((state) => ({
            workspace: activateFor(state.workspace, activeRequestId),
            activeRequestId,
            selectedNodeId: activeRequestId,
            ...(activeRequestId ? { activeEnvironmentTabId: null } : {}),
        })),

    cycleRequest: (offset) =>
        set((state) => {
            const open = state.workspace.openRequestIds;
            if (!open.length) return state;
            const index = state.activeRequestId ? open.indexOf(state.activeRequestId) : 0;
            const next = open[(((index + offset) % open.length) + open.length) % open.length];
            return next
                ? {
                      workspace: activateFor(state.workspace, next),
                      activeRequestId: next,
                      selectedNodeId: next,
                      activeEnvironmentTabId: null,
                  }
                : state;
        }),

    moveTab: (id, toIndex) =>
        set((state) => {
            const open = [...state.workspace.openRequestIds];
            const from = open.indexOf(id);
            const target = Math.max(0, Math.min(toIndex, open.length - 1));
            if (from < 0 || from === target) return state;
            open.splice(from, 1);
            open.splice(target, 0, id);
            return { workspace: touch(state.workspace, { openRequestIds: open }) };
        }),

    editRequest: (id, patch) =>
        set((state) => {
            const saved = state.workspace.requests.find((request) => request.id === id);
            if (!saved) return state;
            const base = state.drafts[id] ?? saved;
            // Structural fields are changed through tree actions only.
            const next = withStructure({ ...base, ...patch }, saved);
            if (same(next, saved)) {
                return state.drafts[id] ? { drafts: without(state.drafts, [id]) } : state;
            }
            return {
                drafts: { ...state.drafts, [id]: next },
                saveStatus:
                    state.saveStatus[id] === 'failed'
                        ? without(state.saveStatus, [id])
                        : state.saveStatus,
            };
        }),

    discardDraft: (id) =>
        set((state) => ({
            drafts: without(state.drafts, [id]),
            saveStatus: without(state.saveStatus, [id]),
        })),

    commitSaved: (committed, draft, written, base) =>
        set((state) => {
            // If nothing else changed while writing, adopt the written snapshot so it is not re-saved.
            const workspace =
                state.workspace === base
                    ? written
                    : touch(state.workspace, {
                          requests: state.workspace.requests.map((request) =>
                              request.id === committed.id
                                  ? withStructure(committed, request)
                                  : request,
                          ),
                      });
            const current = state.drafts[committed.id];
            const drafts =
                current === draft || (current && same(current, committed))
                    ? without(state.drafts, [committed.id])
                    : state.drafts;
            return { workspace, drafts, saveStatus: without(state.saveStatus, [committed.id]) };
        }),

    setSaveStatus: (id, status) =>
        set((state) => ({
            saveStatus: status
                ? { ...state.saveStatus, [id]: status }
                : without(state.saveStatus, [id]),
        })),

    setResponse: (id, response) =>
        set((state) => ({ responses: { ...state.responses, [id]: response } })),

    setScriptReport: (id, report) =>
        set((state) => ({
            scriptReports: report
                ? { ...state.scriptReports, [id]: report }
                : without(state.scriptReports, [id]),
        })),

    applyScriptEnvironment: ({ set: assigned, unset }) => {
        for (const [key, value] of Object.entries(assigned)) {
            get().setEnvironmentVariable(key, value, false);
        }
        const environment = activeEnvironment(get().workspace);
        if (environment && unset.length) {
            get().updateEnvironment(environment.id, {
                variables: environment.variables.filter(
                    (variable) => !unset.includes(variable.key),
                ),
            });
        }
    },

    startStream: (id, head) =>
        set((state) => ({ streams: { ...state.streams, [id]: { head, events: [], dropped: 0 } } })),

    appendStreamEvents: (id, events) =>
        set((state) => {
            const live = state.streams[id];
            if (!live || events.length === 0) return state;
            const all = [...live.events, ...events];
            const overflow = Math.max(0, all.length - MAX_LIVE_EVENTS);
            return {
                streams: {
                    ...state.streams,
                    [id]: {
                        head: live.head,
                        events: overflow ? all.slice(overflow) : all,
                        dropped: live.dropped + overflow,
                    },
                },
            };
        }),

    endStream: (id) =>
        set((state) => (state.streams[id] ? { streams: without(state.streams, [id]) } : state)),

    setEditorTab: (id, tab) => set((state) => ({ editorTabs: { ...state.editorTabs, [id]: tab } })),

    createCollection: () => {
        const collection = createCollection();
        set((state) => ({
            workspace: touch(state.workspace, {
                collections: [...state.workspace.collections, collection],
            }),
            selectedNodeId: collection.id,
            renamingId: collection.id,
            sidebarView: 'collections',
        }));
        return collection.id;
    },

    createFolder: (parentId) => {
        const folder = createFolder(parentId);
        set((state) => ({
            workspace: touch(state.workspace, { folders: [...state.workspace.folders, folder] }),
            expandedIds: withExpanded(state.expandedIds, [parentId]),
            selectedNodeId: folder.id,
            renamingId: folder.id,
        }));
        return folder.id;
    },

    createRequest: (parentId) => {
        const request = createEmptyRequest(parentId);
        set((state) => ({
            workspace: touch(state.workspace, { requests: [...state.workspace.requests, request] }),
            expandedIds: parentId ? withExpanded(state.expandedIds, [parentId]) : state.expandedIds,
            renamingId: parentId ? request.id : null,
        }));
        get().openRequest(request.id);
        return request.id;
    },

    createWebSocketRequest: (parentId) => {
        const request = newSocketRequest(parentId);
        set((state) => ({
            workspace: touch(state.workspace, {
                websocketRequests: [...state.workspace.websocketRequests, request],
            }),
            expandedIds: parentId ? withExpanded(state.expandedIds, [parentId]) : state.expandedIds,
            renamingId: parentId ? request.id : null,
        }));
        get().openRequest(request.id);
        return request.id;
    },

    editWebSocketRequest: (id, patch) =>
        set((state) => {
            const saved = state.workspace.websocketRequests.find((request) => request.id === id);
            if (!saved) return state;
            // Name and parent are structural and are changed through the tree actions only.
            const next: WebSocketRequest = {
                ...saved,
                ...patch,
                id,
                name: saved.name,
                parentId: saved.parentId,
            };
            return {
                workspace: touch(state.workspace, {
                    websocketRequests: state.workspace.websocketRequests.map((request) =>
                        request.id === id ? next : request,
                    ),
                }),
            };
        }),

    renameNode: (id, name) =>
        set((state) => {
            const workspace = renameTreeNode(state.workspace, id, name);
            if (workspace === state.workspace) return { renamingId: null };
            const draft = state.drafts[id];
            return {
                workspace,
                drafts: draft
                    ? { ...state.drafts, [id]: { ...draft, name: name.trim() } }
                    : state.drafts,
                renamingId: null,
            };
        }),

    moveNode: (id, parentId, beforeId = null) =>
        set((state) => {
            const workspace = moveTreeNode(state.workspace, id, parentId, beforeId);
            if (workspace === state.workspace) return state;
            const draft = state.drafts[id];
            return {
                workspace,
                drafts: draft ? { ...state.drafts, [id]: { ...draft, parentId } } : state.drafts,
                // The moved node stays in sight: its new parent, and every container above it, opens.
                expandedIds: parentId
                    ? withExpanded(state.expandedIds, [
                          ...getAncestors(workspace, parentId).map((item) => item.node.id),
                          parentId,
                      ])
                    : state.expandedIds,
                selectedNodeId: id,
            };
        }),

    saveRequestAs: (id, parentId, name) => {
        const state = get();
        const node = findNode(state.workspace, id);
        const parent = findNode(state.workspace, parentId);
        if (!node || !isLeafNode(node) || !parent || isLeafNode(parent)) return null;
        if (node.node.parentId === null) {
            get().moveNode(id, parentId);
            get().renameNode(id, name);
            return id;
        }
        const { workspace, id: copyId } = insertLeafCopy(
            state.workspace,
            node.kind === 'request'
                ? { kind: 'request', request: state.drafts[id] ?? node.node }
                : { kind: 'websocket', request: node.node },
            parentId,
            name,
        );
        const open = workspace.openRequestIds;
        const response = state.responses[id];
        set({
            workspace: {
                ...workspace,
                openRequestIds: open.includes(id)
                    ? open.map((openId) => (openId === id ? copyId : openId))
                    : [...open, copyId],
            },
            // The edits now live in the copy; the original goes back to what was last saved.
            drafts: without(state.drafts, [id]),
            saveStatus: without(state.saveStatus, [id]),
            responses: response ? { ...state.responses, [copyId]: response } : state.responses,
            activeRequestId: copyId,
            activeEnvironmentTabId: null,
            selectedNodeId: copyId,
            expandedIds: withExpanded(state.expandedIds, [
                ...getAncestors(workspace, parentId).map((item) => item.node.id),
                parentId,
            ]),
        });
        return copyId;
    },

    duplicateNode: (id) => {
        const { workspace, id: copyId } = duplicateTreeNode(get().workspace, id);
        if (!copyId) return;
        set({ workspace, selectedNodeId: copyId });
        const node = findNode(workspace, copyId);
        if (node && isLeafNode(node)) get().openRequest(copyId);
    },

    deleteNode: (id) =>
        set((state) => {
            const { workspace, removedRequestIds } = deleteTreeNode(state.workspace, id);
            if (workspace === state.workspace) return state;
            const open = workspace.openRequestIds;
            const activeGone =
                state.activeRequestId !== null && removedRequestIds.has(state.activeRequestId);
            const previousIndex = state.activeRequestId
                ? state.workspace.openRequestIds.indexOf(state.activeRequestId)
                : 0;
            return {
                workspace,
                drafts: without(state.drafts, removedRequestIds),
                responses: without(state.responses, removedRequestIds),
                scriptReports: without(state.scriptReports, removedRequestIds),
                saveStatus: without(state.saveStatus, removedRequestIds),
                activeRequestId: activeGone
                    ? (open[Math.min(previousIndex, open.length - 1)] ?? null)
                    : state.activeRequestId,
                selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
            };
        }),

    updateContainer: (id, patch) =>
        set((state) => {
            const update = <T extends { id: string }>(items: T[]) =>
                items.map((item) => (item.id === id ? { ...item, ...patch } : item));
            return {
                workspace: touch(state.workspace, {
                    collections: update(state.workspace.collections),
                    folders: update(state.workspace.folders),
                }),
            };
        }),

    applyImport: (workspace, rootId, kind) => {
        if (kind === 'environment' || !rootId) {
            set({ workspace });
            return;
        }
        set((state) => ({
            workspace,
            selectedNodeId: rootId,
            sidebarView: 'collections',
            expandedIds: withExpanded(state.expandedIds, [rootId]),
        }));
        if (kind === 'request') get().openRequest(rootId);
    },

    selectNode: (selectedNodeId) =>
        set((state) => ({
            workspace: activateFor(state.workspace, selectedNodeId),
            selectedNodeId,
        })),

    toggleExpanded: (id, expanded) =>
        set((state) => {
            const next = new Set(state.expandedIds);
            const open = expanded ?? !next.has(id);
            if (open) next.add(id);
            else next.delete(id);
            return { expandedIds: next };
        }),

    revealNode: (id) =>
        set((state) => ({
            workspace: activateFor(state.workspace, id),
            selectedNodeId: id,
            sidebarView: 'collections',
            expandedIds: withExpanded(
                state.expandedIds,
                getAncestors(state.workspace, id).map((item) => item.node.id),
            ),
            revealNonce: state.revealNonce + 1,
        })),

    setRenaming: (renamingId) => set({ renamingId }),

    setSidebarView: (sidebarView) => set({ sidebarView }),

    createEnvironment: () => {
        const environment = createEnvironment();
        set((state) => ({
            workspace: touch(state.workspace, {
                environments: [...state.workspace.environments, environment],
            }),
        }));
        return environment.id;
    },

    updateEnvironment: (id, patch) =>
        set((state) => ({
            workspace: touch(state.workspace, {
                environments: state.workspace.environments.map((environment) =>
                    environment.id === id ? { ...environment, ...patch } : environment,
                ),
            }),
        })),

    duplicateEnvironment: (id) => {
        const environments = [...get().workspace.environments];
        const index = environments.findIndex((environment) => environment.id === id);
        const source = environments[index];
        if (!source) return null;
        const copy: Environment = {
            id: createId(),
            name: `${source.name} (copy)`,
            variables: source.variables.map((variable) => ({ ...variable, id: createId() })),
        };
        environments.splice(index + 1, 0, copy);
        set((state) => ({ workspace: touch(state.workspace, { environments }) }));
        return copy.id;
    },

    deleteEnvironment: (id) => get().deleteEnvironments([id]),

    deleteEnvironments: (ids) => {
        const doomed = new Set(ids);
        if (doomed.size === 0) return;
        get().closeEnvironmentTabs(doomed);
        /** Drops a link to a deleted environment. */
        const unlink = <T extends { environmentId?: string | null }>(item: T): T =>
            item.environmentId && doomed.has(item.environmentId)
                ? withEnvironmentLink(item, null)
                : item;
        set((state) => {
            const activeId = state.workspace.activeEnvironmentId;
            return {
                workspace: touch(state.workspace, {
                    environments: state.workspace.environments.filter(
                        (environment) => !doomed.has(environment.id),
                    ),
                    collections: state.workspace.collections.map(unlink),
                    folders: state.workspace.folders.map(unlink),
                    requests: state.workspace.requests.map(unlink),
                    activeEnvironmentId: activeId && doomed.has(activeId) ? null : activeId,
                }),
                drafts: Object.fromEntries(
                    Object.entries(state.drafts).map(([draftId, draft]) => [
                        draftId,
                        unlink(draft),
                    ]),
                ),
            };
        });
    },

    linkEnvironment: (id, environmentId) =>
        set((state) => {
            const collectionId = collectionIdOf(state.workspace, id);
            if (!collectionId) return state;
            const workspace = touch(state.workspace, {
                collections: state.workspace.collections.map((item) =>
                    item.id === collectionId ? withEnvironmentLink(item, environmentId) : item,
                ),
            });
            // The environment shown follows the selection, so linking applies right away.
            return {
                workspace: activateFor(workspace, state.activeRequestId ?? state.selectedNodeId),
            };
        }),

    setEnvironmentVariable: (key, value, secret) => {
        const environment = activeEnvironment(get().workspace);
        if (!environment || !key) return false;
        // The variable a reference resolves to: the last enabled one of that name (later rows win),
        // or failing that the first, disabled one, which is then switched on.
        const matches = environment.variables.filter((variable) => variable.key === key);
        const existing = [...matches].reverse().find((variable) => variable.enabled) ?? matches[0];
        get().updateEnvironment(environment.id, {
            variables: existing
                ? environment.variables.map((variable) =>
                      variable === existing ? { ...variable, value, enabled: true } : variable,
                  )
                : [...environment.variables, { id: createId(), key, value, enabled: true, secret }],
        });
        return true;
    },

    setHistory: (history) => set({ history }),
}));
