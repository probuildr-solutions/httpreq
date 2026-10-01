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

## Clipboard and updates

The renderer has no clipboard permission (all web permissions are denied), so "Copy as cURL" and every other copy goes through `clipboard:write-text` in the main process, which Electron's `clipboard` module serves. Only the app's own top-level document may call it, the payload must be a string of at most 10 million characters, and nothing but plain text moves. Reading (for pasting into the SSH terminal) is the same kind of one-purpose channel.

Updates are delivered by `electron-updater` in the main process, never the renderer: the renderer can only ask for the current state, a check, or an install of a version that is already downloaded and verified. The feed is the project's GitHub Releases (baked into `app-update.yml` at package time), downloads are checked against the SHA-512 in the release metadata, and the module is loaded lazily so a failure to load or run it never prevents the app from starting.

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

On macOS this also asks the system whether it would trust each package: the code signature of the app
inside every `.zip`, `.dmg` and `.pkg` (and that the arm64 build contains arm64 code), the hardened
runtime and the JIT entitlement, Gatekeeper's verdict, the stapled notarization ticket, and the
installer's own signature. A Developer ID signature and notarization are what make macOS trust a
download; they cannot be replaced by a packaging option, and a release that lacks them fails before it
is built. [distribution.md](distribution.md) has the details.

## Protocols, scripts and code generation

- **Scripts** run in a WebAssembly interpreter with no host functions, a heap/stack/time budget and fresh state per run; the engine's output is treated as untrusted data and validated. The CSP gains `'wasm-unsafe-eval'` only.
- **IPC**: `grpc:*` and `mqtt:*` handlers check the sender, then re-parse every payload (`parsePreparedGrpcCall`, `parsePreparedMqtt`, `parseMqttPublish`, …). Unknown fields are dropped, so a renderer cannot add channel or client options. gRPC targets must be `host:port`, metadata keys are lower-case ASCII and may not use the reserved `grpc-` prefix, `.proto` text is parsed in memory and never read from disk, connections and calls are keyed by the owning window and closed with it.
- **TLS** is verified by default everywhere; turning verification off is an explicit per-request setting, and the main process only honours an explicit `false`. MQTT CA and client certificates must look like PEM, and the client key is never written to storage, exports or generated code.
- **Imported definitions** (WSDL, `.proto`) are bounded in size and count, XML with a DOCTYPE or entity declaration is refused, and WSDLs are fetched only on request, over http(s), without credentials or cookies.
- **Secrets**: MQTT credentials use the authorization providers (so they follow the same persistence rules); MQTT errors and logs pass through the redactor; generated code uses a placeholder for credentials unless the user explicitly includes them. SOAP actions and script-set headers are rejected if they contain line breaks.
