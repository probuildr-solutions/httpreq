# Architecture

## Runtime boundary

The shared UI depends only on `HttpRuntime`, `WebSocketRuntime`, `WorkspaceRepository` and `HistoryRepository`, plus the optional `SshBridge` and `TunnelBridge`. It never imports Electron or Node APIs. At startup, the web entry point selects `BrowserHttpRuntime` and `BrowserWebSocketRuntime`; the same renderer selects the Electron adapters when the preload bridge is present.

`PlatformCapabilities` (`desktop`, `ssh`, `tunneling`, `nativeFilePicker`, `secureCredentialStorage`, `webSocketHeaders`) is derived by `detectCapabilities` from what the preload actually exposed, not from a build flag, and is published through a React context. A desktop build whose SSH bridge failed to load therefore reports "no SSH" honestly instead of rendering controls that cannot work. Browser builds show the SSH and Tunnels rail entries as disabled informational items.

The Electron renderer has `contextIsolation`, sandboxing, and disabled Node integration. The preload exposes the typed `HttpReqBridge` (`executeHttp` and `cancelHttp`). Runtimes receive only the final `PreparedRequest` (variables resolved, authorization applied, body encoded); the main process validates its structure and permits only HTTP and HTTPS URLs before using Electron native networking. API requests run in dedicated sessions (`persist:httpreq-api`), so they have their own cookie jar and never pass through the app's CSP header injection; requests that turn off TLS verification use a second session whose certificate check accepts everything, so the relaxed check never applies to verified requests. Handlers never throw across IPC, because Electron strips custom error classes and their codes; they return an `IpcResult` envelope that `ElectronHttpRuntime` turns back into an `AppError`. In-flight native requests are keyed by sender and execution id, so a window can cancel only its own requests.

The same narrow-interface rule covers the new capabilities. The preload exposes `webSocket`, `ssh` and `tunnels` as fixed sets of named operations; it never hands out `require`, `fs`, `child_process` or the raw `ipcRenderer`, and it validates inbound events as well as outbound calls, so a malformed main-process message cannot push an arbitrary object into React state. Every handler in `apps/desktop/src/services.ts` re-checks the sender, then re-parses the payload with the _same_ validators the form uses (`parseSshProfile`, `parseTunnelProfile`, `parsePreparedWebSocket` in `shared`), so the UI and the privileged boundary cannot disagree about what a valid profile is. Unknown fields are dropped rather than forwarded, which is what stops a renderer smuggling extra `ssh2` options such as agent forwarding through a profile. Sockets and shells are keyed by the `webContents` id that created them, so one window can never read or write another's, and they are released when that window is destroyed. `before-quit` is held until every socket, SSH channel and listening port is closed, so the app leaves no orphan session or occupied port behind.

The preload also exposes an optional `desktop` bridge for the window shell: app info, window state, a fixed list of window/edit actions (`WINDOW_ACTIONS`), title-bar overlay colours, opening the project documentation, and a connectivity probe. The main process accepts these only from the top-level app document (dev-server origin or packaged `file://`), validates every payload (`#rrggbb` colours, an allow-listed documentation URL, known action names), and keeps the privileged work—`shell.openExternal`, `net.fetch`, zoom, full screen, quitting—on its side. Renderer navigation away from the app is blocked.

The window uses `titleBarStyle: 'hidden'`. The React title bar is the drag region and hosts the application menu on Windows and Linux, while the OS keeps drawing the real window controls (the window-controls overlay, recoloured to match the theme, or the macOS traffic lights), so snapping, double-click maximise and accessibility stay native. macOS keeps a native global menu that forwards the same command ids (`MENU_COMMANDS`) to the renderer, so both menus run one command table. Under the title bar a second, separate row (`SecondaryBar`) holds the workspace menu, so workspace navigation never blends into the OS or application menu. The window's size, position and maximized state are written to `window-state.json` in the user data directory and restored on the next launch (`windowState.ts`; a position on a display that is no longer connected is dropped).

The production CSP forbids inline scripts. When `VITE_DEV_SERVER_URL` is set, `'unsafe-inline'` is added to `script-src` so Vite's React Fast Refresh preamble can run. New native capabilities should follow this narrow interface-and-adapter pattern.

## Request model and execution pipeline

A workspace (version 3) holds collections, folders, HTTP requests and WebSocket requests in flat arrays linked by `parentId` (array order is sibling order), plus environments, SSH profiles, tunnel profiles and the ids of open tabs. Everything is addressed by id: tabs, the breadcrumb, history entries and authorization inheritance never depend on names or URLs, so renaming or moving a node updates every view at once. Version 1 workspaces (a flat list of open requests) and version 2 workspaces (no sockets or connection profiles) are migrated on load, and stored or imported data is normalized before use.

Workspaces are the unit of isolation, not a filter: exactly one is in memory, and `usePersistence.switchTo` writes the current one, then loads the next and replaces the whole store. Everything a workspace owns is keyed by its id in the repository, so nothing reads across workspaces. Duplicating one rewrites the entire identifier graph (`duplicateWorkspace`), because two workspaces sharing request or profile ids would collide in tabs, drafts, history and the credential vault.

WebSocket requests reuse the HTTP pipeline's front half: `buildWebSocket` resolves the same `{{variables}}` and applies the same `AuthProvider` registry to the handshake — which really is an HTTP GET — so a collection's authorization covers its sockets without a second implementation. The browser runtime reports `supportsHeaders: false`, and the builder drops the headers and warns rather than pretending they were sent.

Sending a request runs one shared pipeline (`@httpreq/api-client`), identical on web and desktop:

```text
saved request → variable resolution → authorization resolution → pre-request scripts
  → final request builder → platform runtime (browser fetch | Electron net) → response processing
  → post-response scripts → history
```

An environment is linked to a collection, and every folder, nested folder and request in it uses that environment; there is no separate global "active" environment, and the one shown always follows the selected request or collection. `{{variables}}` resolve from it (with nesting and built-in dynamic values such as `{{$guid}}`) immediately before execution. The saved request is never mutated; resolved values exist only in the `PreparedRequest`, and history stores the unresolved URL. Query parameters live in the URL; the Params table mirrors it without encoding, so variables round-trip untouched. Path variables are `:name` segments of the URL (`/users/:userId`); their values live in the request's `pathVariables` table, kept in step with the URL, and are substituted (percent-encoded, `{{variables}}` kept) just before variable resolution. OpenAPI `{userId}` and Postman `:userId` parameters import as path variables.

Authorization is a provider registry. Each scheme (`none`, `inherit`, API key, Bearer, Basic, Digest, JWT Bearer, OAuth 2.0) implements `AuthProvider`: `validate`, `resolve`, `applyToRequest`, `appliedHeaders` (to flag conflicts with manual headers, which the scheme replaces rather than duplicating), optional `handleChallenge` (Digest answers one 401), `serialize` (drops literal secrets, keeps `{{references}}`) and `deserialize`. The UI mirrors it with an editor registry, so a new scheme (e.g. NTLM on desktop) is a provider plus an editor; neither the pipeline nor the Authorization panel changes. "Inherit from Parent" resolves to the nearest folder or collection, walking up the tree, whose scheme is not `inherit`. JWTs are signed per request with Web Crypto; OAuth 2.0 token requests go through the platform runtime, and authorization-code grants use PKCE with a paste-the-redirect flow (the desktop opens the page through an http/https-only bridge method). Script execution is not implemented: `ScriptRunner` is the seam, and scripts are stored but not run.

## Package responsibilities

- `shared`: dependency-free domain contracts, stable extension interfaces, shared validation and secret redaction.
- `api-client`: variable resolution, the authorization provider registry, the HTTP and WebSocket pipelines, cURL export, and runtime adapters.
- `workspace`: workspace construction, migration and normalization, URL/params sync, whole-workspace operations, and pure tree operations (rename, move, duplicate, delete).
- `storage`: the `KeyValueStore` abstraction (IndexedDB, web storage, memory) and one repository implementation on top of it.
- `ui`: visual components and ephemeral workbench state.
- `apps/web`: composition root for the shared React application.
- `apps/desktop`: Electron security boundary and native implementations.

## State and persistence

Durable and live state are separate stores. `useWorkbenchStore` owns the saved workspace, open tabs, explorer state and responses — everything that is persisted or derived from it. `useConnectionsStore` owns what is running: socket status and message logs, SSH session status, tunnel statistics. Nothing in the second store survives a reload or a workspace switch, and `resetConnections` is called only after the underlying resources have actually been released.

WebSocket requests deliberately have no draft cycle: an edit is committed to the workspace immediately, as environments are, so a socket tab has no unsaved state to lose. SSH terminal tabs are not persisted at all, because a shell cannot survive a restart.

Request edits go to per-request drafts, not the workspace: a tab is _modified_ while it has a draft (dropped as soon as it matches the saved request again), _saving_/_save failed_ during an explicit save (Ctrl/Cmd+S), and _saved_ otherwise. Drafts are written at most about once a second so they survive a reload; structural changes (tree, tabs, environments) are written after a short debounce; so typing never writes the workspace. Name and parent are structural and are updated on the saved request and its draft together. Application-level UI preferences (response position, per-layout split ratio, sidebar and status-bar visibility) live in a separate store persisted under `httpreq.preferences`, never in workspace or request data. Keyboard shortcuts are declared once as commands (`app/buildCommands.ts`) and dispatched by a single capture-phase listener (`useShortcutManager`); the menubar, the macOS menu and the shortcuts dialog read the same table.

Performance notes: the request/response splitter writes its ratio to a CSS variable while dragging and commits to the store once on release, so editors are never re-rendered or remounted by resizing; switching layout only changes CSS. Connectivity state is subscribed to by the status bar alone. The repository abstraction owns durable workspace data, allowing a future SQLite, filesystem, or cloud implementation without changing UI components. A workspace is stored split, a shell plus one record per request, and a save rewrites only the requests that changed, in one IndexedDB transaction; see [persistence.md](persistence.md) for the measurements behind this and the storage recommendation. The shell subscribes only to structural state: draft contents and live socket state are read by the tab strip (`WorkbenchTabs`) and the response by `ActiveResponse`, so typing or an incoming WebSocket message does not re-render the whole app. Response payloads and files chosen for binary or multipart bodies are intentionally not persisted.

Literal secrets (auth fields each provider marks as secret, headers marked secret, secret environment values) are removed by the repository before serialization; `{{variable}}` references are kept, so secrets live only in session memory. Exports use the same sanitization.

SSH secrets go further, because they must outlive the session. An `SshProfile` has no field a password or passphrase could occupy: it stores a private-key _path_ and an opaque `credentialId`. The value behind that id is encrypted with Electron's `safeStorage` — whose key is held by the OS credential system — and written as ciphertext to the app's user-data directory. The renderer can write a secret and ask whether one exists; it can never read one back. When the OS offers no encryption, `CredentialStore.set` fails rather than falling back to plain text. Private keys are read in the main process at connect time and never cross IPC.

Nothing sensitive reaches a log or an error message either. `redact`/`redactText` in `shared` strip PEM key blocks, `Authorization` and `Cookie` header values, and `password=`-style pairs; every `SshErrorInfo.detail` and the single logging helper in `services.ts` pass through them, so a library message that happened to echo a passphrase cannot surface in the UI or the console.

Host-key verification is application-managed (`KnownHostsStore`). An unknown host raises a prompt in the window that asked to connect, and it is the user who decides; a _changed_ fingerprint is reported as such, with both fingerprints shown, and is never accepted silently. There is no option to turn verification off.

## Dependency choices

- React + Vite: shared typed renderer and fast builds.
- Tailwind CSS: utility-class styling and the design tokens (see [ui.md](ui.md)); `@floating-ui/react` positions menus, popovers, tooltips and dialogs; the controls themselves are the in-house kit in `packages/ui/src/kit`.
- Zustand: small client-state store without reducer boilerplate.
- TanStack Query: server-state foundation for future workspace/cloud operations.
- Monaco Editor: structured JSON request and response editing, search, and copy behavior.
- Electron: native networking, `safeStorage`-backed credential encryption, and desktop-only connectivity.
- `ssh2` + `ws`: maintained SSH and WebSocket implementations for the main process; both stay external to the Vite bundle because they load optional native bindings at runtime.
- xterm.js: terminal rendering, scrollback and selection in the renderer.
- Vitest + Testing Library: unit and future component testing on the Vite toolchain.
- ESLint + Prettier + TypeScript project references: consistent strict workspace checks.

## Tunnelling

`TunnelManager` owns local forwarding: a `net` listener accepts connections and each one is piped through `client.forwardOut` on that tunnel's own SSH connection, so stopping one tunnel never disturbs another. Port conflicts are detected with a probe listener _before_ any SSH connection is opened, so a conflict costs nothing and the error names the port to change. Byte counters are published on a timer rather than per chunk. `TunnelType` already carries `remote` and `dynamic`; both are rejected at `start` with `TUNNEL_NOT_SUPPORTED` rather than silently doing something else, so adding them later is an implementation change inside this class and not a model change. Bind addresses default to loopback, and normalization falls back to loopback rather than to a public interface when a stored value is unparseable.

## Extension rules

Implementations of native capabilities must live outside React, behind an interface in `shared`. Secrets must never be logged or stored in workspace JSON. Native functionality must be allow-listed through preload IPC rather than exposing generic filesystem, process, or network primitives, and the main process must re-validate every payload with the shared validators instead of trusting the renderer that sent it.

## Responses: binary, streaming and saving

`readResponse` keeps the exact bytes of every response (`HttpResponse.bytes`) and decodes them to text only when the content is text: text-like media types always, known binary types (PDF, ZIP, images, spreadsheets, documents) never, and anything else by sniffing the bytes. A binary body has an empty `body` and `binary: true`, and the viewer shows its file name (from `Content-Disposition`), type and size with a Save button instead of corrupted text. Saving writes the original bytes, so JSON, XML and binary payloads are never altered; the default name comes from `Content-Disposition`, else from the content type (`response.json`, `response.pdf`, ...).

A `text/event-stream` response is read progressively when the caller passes `ExecutionHooks`: `onStreamStart` fires when the headers arrive and `onStreamEvents` for every batch of parsed events (`event`, `data`, `id`, `retry`). In the desktop app the main process reads the stream and pushes `HttpStreamMessage`s over `http:stream`; the renderer's runtime turns them into the same hooks. The request timeout applies to the wait for headers only: the pipeline clears it when a stream starts, so an intentionally open connection is never timed out. Stopping a stream aborts the request and resolves with the events received so far (`response.stream.ended === 'stopped'`).
