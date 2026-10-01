# Desktop hardening

This page describes what the packaged desktop app does to resist inspection and tampering, and, as
important, what it cannot do.

## What this does not do

Code that runs on someone's machine can eventually be read by them. Nothing below makes HttpReq
unreadable; it removes the cheap routes (opening the developer tools, attaching a debugger, editing
a file inside the package, pointing the window at a hostile page) and keeps a compromised page from
reaching anything it was not explicitly given. Secrets never depend on obscurity: SSH credentials
are encrypted with the OS credential vault, and workspace data never contains literal secrets (see
[architecture.md](architecture.md)).

## Packaging

| Measure                            | Where                         | Effect                                                                                                         |
| ---------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| One `app.asar` holds all app code  | `electron-builder.config.cjs` | The main process, preload and bundled renderer are not loose files that can be edited in place.                |
| Asar integrity validation          | `electronFuses`               | The app checks the archive's hash on start (macOS and Windows) and refuses to run a modified one.              |
| `onlyLoadAppFromAsar`              | `electronFuses`               | Combined with the check above, code cannot be loaded from an unvalidated folder next to the archive.           |
| `runAsNode` off                    | `electronFuses`               | `ELECTRON_RUN_AS_NODE` cannot turn the app binary into a general Node interpreter.                             |
| `NODE_OPTIONS` and `--inspect` off | `electronFuses`               | The Node inspector cannot be opened on the main process from the command line or environment.                  |
| Cookie encryption on               | `electronFuses`               | The cookie store on disk is encrypted with the OS key.                                                         |
| No source maps                     | Vite configs, `files` filter  | Neither the renderer nor the main process ships a map back to the original TypeScript.                         |
| Minified, mangled main process     | `vite.main.config.ts`         | Identifiers are shortened and comments removed.                                                                |
| Release verification               | `scripts/verify-packages.mjs` | A package fails the release if the renderer is not in the asar, a map is inside it, or a fuse is not as built. |

`grantFileProtocolExtraPrivileges` stays on because the renderer is served from `file://`, and the
renderer's IndexedDB data is keyed to that origin: moving to a custom protocol would orphan every
user's workspaces. Revisit it together with a storage migration.

## Runtime policy

All of it lives in [`apps/desktop/src/security.ts`](../apps/desktop/src/security.ts), with tests in
`security.test.ts`.

- **Content Security Policy.** Strict in production (`script-src 'self' blob:`), with `object-src`,
  `base-uri`, `form-action` and `frame-ancestors` set to `'none'`. Only development allows the
  inline preamble Vite's hot reloading needs.
- **Navigation lock.** New windows are denied; `will-navigate` and `will-redirect` are cancelled
  unless the target is the bundled UI; `<webview>` cannot be attached.
- **Permissions.** Every permission request and check is refused; the app needs none.
- **Developer tools.** Packaged builds close them the moment they open, whichever way they were
  opened, and the menu command does nothing. A support engineer can set `HTTPREQ_DEVTOOLS=1` to
  allow them.
- **Debugger switches.** A packaged build exits if started with `--remote-debugging-port` or
  `--remote-debugging-pipe`.
- **Sandbox.** `app.enableSandbox()` runs every renderer in the OS sandbox, together with
  `contextIsolation` and no Node integration.
- **IPC.** The preload exposes named operations only; the main process re-validates every payload
  and checks that the sender is the app's top-level document.

## Verifying a package

```bash
npm run build
npm run package:desktop
node apps/desktop/scripts/verify-packages.mjs win   # or mac / linux
```
