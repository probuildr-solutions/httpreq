# Local persistence: evaluation

Should HttpReq move its data behind a local service (Node.js + PostgreSQL, or SQLite on desktop)?
We profiled first. The answer for now is **no**: IndexedDB was not the bottleneck. How we were
using it was, and that is fixed inside the existing storage layer.

## What was measured

The test workspace had 40 collections, 200 folders and 5,000 requests (8.8 MB serialized). It ran
in the Vite dev build (web) and the production build (Electron).

| Operation                                                            | Before             | After                       |
| -------------------------------------------------------------------- | ------------------ | --------------------------- |
| One keystroke in the URL field (dev build)                           | ~1,100 ms          | ~12 ms                      |
| Main-thread storage cost of a structural change (e.g. opening a tab) | ~115 ms            | ~0.5 ms                     |
| Records written per structural change                                | 1 value of 8.8 MB  | 2 small records             |
| Loading the workspace from IndexedDB                                 | ~21 ms (one value) | ~60 ms (one key-range read) |
| Pretty-printing a 25 MB JSON response on the UI thread               | ~190 ms            | 0 ms (Web Worker)           |

## Root causes

1. **Rendering, not storage, made typing slow.** Every explorer row was memoized, but received
   about 15 fresh closures on each render, so every row re-rendered on every keystroke. Each row
   has its own actions menu and tooltips. On top of that, the application shell subscribed to all
   drafts, responses and socket states, so it also re-rendered the whole shell for every keystroke
   and every WebSocket message. Building the tree rows was O(containers × requests).
2. **Every write was the whole workspace.** Each structural change (opening a tab, renaming,
   moving a request) rewrote the complete workspace. Before `IDBObjectStore.put`, it also ran a
   redundant `JSON.parse(JSON.stringify(...))` round trip. The cost grew with the workspace size,
   not with the size of the change.

## What changed (existing architecture, no new service)

- **Explorer.** Row handlers are stable. Unchanged rows keep their identity. The explorer
  subscribes to draft _ids_, not draft contents. Tree rows are built from a parent index in O(n).
  Trees over 150 rows are windowed.
- **Shell.** Draft- and socket-derived tab decorations moved into `WorkbenchTabs`. The response
  moved into `ActiveResponse`.
- **Store.** `editRequest` compares with a structural `deepEqual` instead of serializing both
  requests.
- **Storage.** A workspace is stored split into two parts:
    - `workspace.<id>` is the shell: tree containers, environments, profiles, tab order, and the
      request ids in tree order.
    - `request.<id>.<requestId>` and `websocket.<id>.<socketId>` hold one request each.

    A save writes the shell plus only the requests whose object identity changed since the last
    write or load. The store updates immutably, so identity is a reliable change signal. Shell,
    request writes and deletions go into one IndexedDB transaction, so the write is atomic. The JSON
    round trip only runs as a fallback when a value can't be structured-cloned.

- **Responses.** JSON bodies of 256 KB and up are formatted in a Web Worker. Wrapping and folding
  are off from 2 MB. Highlighting is off from 16 MB.

## Migration

This needs no step and no version bump. `getWorkspace` still reads the old single-record layout,
and the next save converts it: it writes every request once (~47 ms for 5,000 requests), then goes
incremental. Records left by an interrupted write are detected at load and deleted by the next
save. Old releases cannot read the split layout. Downgrading after an upgrade would need an export
and re-import.

## Recommendation

- **Keep IndexedDB (via `KeyValueStore`) on both platforms.** After these fixes, writes cost about
  as much as the change, and loads are tens of milliseconds for 5,000 requests.
- **Do not add Node.js + PostgreSQL.** A local database server is an operational burden: install,
  upgrades, ports, and its own credentials. It would also add an IPC/HTTP hop to every read, and
  it can't run in the web build at all. Nothing measured calls for it.
- **SQLite on desktop is the right next step if a need appears,** for example:
    - full-text search across very large histories,
    - queries over tens of thousands of requests without loading them,
    - sharing one data file between processes.

    In that case, implement `KeyValueStore` (or a richer repository) over `better-sqlite3` in the
    Electron main process, behind the existing repository interface. The UI would not change.
    Migration would read every `workspace.*`, `request.*`, `drafts.*` and `history.*` key from
    IndexedDB once and write them in one transaction.

## Security

This change leaves secret handling as it was:

- Requests and workspaces are still passed through `sanitizeRequest` / `sanitizeWorkspace` before
  they are written. Literal tokens, passwords and secret headers are dropped. `{{variable}}`
  references are kept.
- SSH secrets live only in the `safeStorage`-encrypted vault in the main process. Profiles hold a
  key path and a credential id.
- The header preview on the Headers tab never shows a credential. Literal secrets are masked, and
  variable references are shown as written.

A SQLite migration would keep the same rule: secrets never go into the data file, only into the OS
keychain (`safeStorage`, or a keytar-style store).

## Out of scope, worth doing separately

- Moving the ~25 MB response IPC payload to a streamed or transferable `ArrayBuffer`. It currently
  costs about 70 ms of structured clone in the renderer.
- Paging request history beyond the current 200-entry cap.
- Reconciling edits made in two browser tabs at once. The storage behavior is still last writer
  wins, now per request instead of per workspace.
