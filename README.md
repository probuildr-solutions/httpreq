# HttpReq

HttpReq is a local-first developer networking toolkit with one React interface for the web and Electron: an HTTP/REST client, a WebSocket client, and — on the desktop — an SSH terminal and SSH port forwarding, all organised into isolated workspaces.

## Platform support

| Feature                          | Web | Electron desktop |
| -------------------------------- | --- | ---------------- |
| Workspaces                       | Yes | Yes              |
| HTTP / REST                      | Yes | Yes              |
| WebSocket client                 | Yes | Yes              |
| WebSocket handshake headers      | No  | Yes              |
| SSH client                       | No  | Yes              |
| SSH tunnelling / port forwarding | No  | Yes              |

SSH and tunnelling are desktop-only because they need native sockets, private-key files on disk, and an OS credential vault. The browser build does not merely hide the buttons: there is no bridge to call, and the Electron main process re-validates every request on its own side.

## Project structure

```text
apps/
  web/             Vite renderer and browser entry point
  desktop/         Hardened Electron main process and preload bridge
packages/
  ui/              Tailwind component kit, workbench, and Zustand state
  api-client/      HTTP and WebSocket preparation, browser/Electron adapters
  workspace/       Workspace model helpers, migration, and tree operations
  storage/         Key/value store abstraction and the workspace repositories
  shared/          Runtime contracts, domain models, validation, and errors
```

The desktop-only code lives in `apps/desktop/src`: `websocket.ts` (sockets that can set handshake
headers) and `ssh/` (connections, credential vault, known hosts, terminal sessions, tunnels).

See [docs/architecture.md](docs/architecture.md) for boundaries and security decisions,
[docs/ui.md](docs/ui.md) for the Tailwind design system and component kit, and
[docs/security.md](docs/security.md) for how the packaged desktop app resists inspection and
tampering.

## Run

Requires Node.js 22 or newer and npm 10 or newer.

```bash
npm install
npm run dev:web
```

The web app opens at `http://localhost:5173`. Browser requests are subject to the destination server's CORS policy.

For Electron development:

```bash
npm run dev:desktop
```

For a production build and local desktop launch:

```bash
npm run build
npm run start --workspace=@httpreq/desktop
```

To create installers with electron-builder (NSIS `.exe` on Windows, `.dmg`/`.zip` for Intel and Apple silicon on macOS, `.AppImage`/`.deb` on Linux; build on the target OS), run:

```bash
npm run package:desktop
```

Output goes to `apps/desktop/release/`. The app icon master is `apps/desktop/build/icon.svg`; after editing it, regenerate the `.ico`, `.icns`, Linux PNG set, runtime window icon and web favicon with `npm run icons --workspace=@httpreq/desktop`.

### Automated builds and releases

The [Desktop packages](.github/workflows/desktop-packages.yml) workflow builds the Windows, macOS and Linux installers every time a pull request is merged into `main` (it can also be started by hand from the Actions tab). It checks each platform's packages carry the right version, then attaches them to the run as artifacts named `HttpReq-<version>-<win|mac|linux>`, each with a `SHA256SUMS` file. Download them from the **Artifacts** section of the finished run.

A merge becomes a GitHub Release, tagged `v<version>` with every installer attached, when the pull request changes the version or has the `release` label. To cut a release, bump the version in a pull request:

```bash
npm run version:set -- 0.2.0
```

A version with a hyphen (`0.2.0-beta.1`) is published as a pre-release, which the desktop app's update check ignores. The release is only created once every platform has built. If any platform fails, or the tag already exists, nothing is published. `npm run release:check` runs the same version checks locally.

Packages are unsigned (Windows) or signed ad hoc (macOS) unless these repository secrets are set: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` (a base64 `.pfx` Authenticode certificate); `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (a base64 Developer ID Application `.p12`); and `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization.

### Opening the macOS app

Without a Developer ID certificate the macOS builds are signed ad hoc. That keeps the Apple silicon (arm64) app valid, so macOS no longer reports it as _damaged_, but it is not notarized, so the first launch shows the ordinary "unidentified developer" prompt: open **System Settings › Privacy & Security** and choose **Open Anyway** (or Control-click the app and choose **Open**). If macOS still refuses a quarantined download, `xattr -dr com.apple.quarantine /Applications/HttpReq.app` clears the flag. Set the `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` and `APPLE_*` secrets to ship a signed and notarized app that opens with no prompt at all; the packaging job then also checks Gatekeeper acceptance and the notarization ticket.

## Workspaces

A workspace is the top-level container for collections, folders, HTTP and WebSocket requests,
environments and — on the desktop — SSH and tunnel profiles. The switcher sits in the bar under the title bar and
can create, rename, duplicate, delete and switch workspaces; the last one used is restored on the
next start.

Workspaces are fully isolated: only one is in memory at a time, and switching reloads every panel
rather than filtering a shared list. Because a switch tears down the live connections the outgoing
workspace owns, anything running is named in a confirmation first.

Duplicating a workspace rewrites every identifier, so the copy shares nothing with the original.
Stored SSH passwords and passphrases are deliberately **not** copied — the copy's connections need
their credentials entered again.

Browser data is stored in IndexedDB (falling back to `localStorage`, then to memory when site data
is blocked); data written by earlier releases is migrated on first run.

## WebSocket client

A WebSocket request lives in the collection tree beside HTTP requests and opens in the same tab
strip, marked `WS`. It supports URL and query parameters, handshake headers, subprotocols, the same
authorization schemes and `{{variables}}` as HTTP, connect/disconnect/reconnect with optional
automatic reconnection, and text, JSON, XML and binary (hexadecimal) payloads. Every frame is
logged with its direction (`↑` sent, `↓` received), timestamp, payload type and size.

Browsers cannot set handshake headers, so the browser build warns and skips them; the desktop build
opens the socket in the main process and sends them.

## SSH and tunnels (desktop)

The **SSH** sidebar view holds reusable connection profiles: host, port, username and password,
private key, or private key plus passphrase. Keys are chosen with the native file picker and stay
where they are — the profile stores only the path. Passwords and passphrases go straight into the
OS credential vault (Windows Credential Manager, macOS Keychain, Linux Secret Service) through
Electron's `safeStorage`; they are never written to workspace data, never returned to the renderer,
and never logged. If the system offers no encryption, HttpReq refuses to store the secret rather
than falling back to plain text.

Connecting opens an xterm.js terminal in its own tab, with scrollback, copy and paste
(Ctrl/Cmd+Shift+C and Ctrl/Cmd+Shift+V, so Ctrl+C still reaches the remote shell as an interrupt)
and resize. Host keys are verified: an unknown host shows its `SHA256:` fingerprint and asks, and a
fingerprint that has _changed_ raises a prominent warning and is never accepted silently.

The **Tunnels** view configures local port forwarding (`ssh -L`). The local bind address defaults to
`127.0.0.1`, and choosing anything else warns that the forwarded service becomes reachable from the
network. Port conflicts are detected before a tunnel starts. Remote (`-R`) and dynamic SOCKS (`-D`)
forwarding are in the model and the UI but are not implemented yet; a profile saved with one of them
refuses to start rather than doing something else.

## Workspace and keyboard

- The response panel sits to the **right** of or **below** the request (View menu, the layout toggle at the end of the tab strip, or the status bar). Drag the splitter to resize, double-click it or press Enter on it to reset. Layout, split sizes, sidebar and status bar visibility are application-wide preferences stored under `httpreq.preferences`, separate from workspace data.
- The status bar shows connectivity: `navigator.onLine` gives the instant signal and a single lightweight probe confirms reachability when it changes or a request fails with a network error. Nothing is polled while online; while offline it retries with backoff. Click the indicator to re-check.
- A dot on a request tab marks edits not yet written to storage (autosave runs 250 ms after typing stops; Ctrl/Cmd+S writes immediately).

| Action                    | Windows / Linux                                      | macOS           |
| ------------------------- | ---------------------------------------------------- | --------------- |
| Send request              | Ctrl+Enter                                           | ⌘↩              |
| Send and focus response   | Ctrl+Shift+Enter                                     | ⇧⌘↩             |
| Save                      | Ctrl+S                                               | ⌘S              |
| New / close request       | Ctrl+T / Ctrl+W                                      | ⌘T / ⌘W         |
| New WebSocket request     | Ctrl+Shift+T                                         | ⇧⌘T             |
| Next / previous request   | Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+PgDn / Ctrl+PgUp) | ⌃⇥ / ⌃⇧⇥        |
| Go to request 1–9         | Ctrl+1 … Ctrl+9                                      | ⌘1 … ⌘9         |
| Toggle sidebar / settings | Ctrl+B / Ctrl+,                                      | ⌘B / ⌘,         |
| Request tab list          | ← → Home End, Enter/Space to open, Delete to close   | same            |
| Application menu          | Alt, or Alt+F/E/V/R/T/H (desktop)                    | native menu bar |

Browsers reserve some of these (for example Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+1–9); they work in the desktop app. Help → Keyboard Shortcuts lists everything.

## Quality commands

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```

## Current limitations

- Browser requests must satisfy CORS. Electron uses native networking and is not CORS-constrained.
- Each request tab can send and cancel independently; cancellation aborts the underlying request in both the browser and Electron runtimes.
- Authentication secret values remain in memory for the session and are deliberately removed before persistence. SSH secrets are the exception: they live in the OS credential vault.
- WebSocket requests are committed to the workspace as they are edited (like environments), so they have no separate save step and never show an unsaved marker.
- SSH terminal tabs are not persisted. A shell cannot survive a restart, so reopening the app to a row of dead terminals would be misleading.
- Only local port forwarding is implemented. Remote and dynamic SOCKS forwarding are modelled but rejected at start time.
- Request scripts are stored but not executed; `ScriptRunner` is the seam.

## Recommended next milestone

Round out the desktop tools: remote (`-R`) and dynamic SOCKS (`-D`) forwarding on the existing
tunnel abstraction, SFTP browsing over the established SSH connections, and a desktop workspace
repository that writes to application data instead of the renderer's IndexedDB.
