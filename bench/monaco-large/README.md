# Monaco large-file benchmark

`index.html` builds a synthetic SQL document (INSERT statements, about 130 bytes a line) of a given
size in a real Chromium renderer, opens it in Monaco Editor 0.53 (the version the app ships), and
times what an editor user does: build the model, scroll, search, type, undo. It runs with the
language set to SQL (a normal editor) and with Large File Mode (plain text, the options in
`LARGE_FILE_OPTIONS`, `packages/ui/src/editor/editorOptions.ts`).

```bash
cd bench/monaco-large && python3 -m http.server 8765
# open http://localhost:8765/index.html, then in the console:
#   await run(64, false)   // 64 MB, normal mode
#   await run(64, true)    // 64 MB, Large File Mode
```

Timings are taken around the synchronous work only, so a hidden or throttled tab does not skew
them. Use a fresh page for each size: a failed run can leave memory behind.

## Measured

Chromium with a 4,192 MB JS heap limit (the browser pane of the development machine; an Electron
renderer has the same limit on 64-bit Windows, macOS and Linux). Memory is the JS heap after the
model exists, in MB.

| File size | Mode  | Build model | Heap after | Scroll step | Search (1000 hits max) | Type a character | Undo ×10 |
| --------: | ----- | ----------: | ---------: | ----------: | ---------------------: | ---------------: | -------: |
|     64 MB | SQL   |      407 ms |        100 |      0.5 ms |                  10 ms |           2.3 ms |     7 ms |
|     64 MB | Large |      402 ms |        101 |      0.8 ms |                  10 ms |           1.4 ms |     6 ms |
|    128 MB | SQL   |      802 ms |        187 |      0.4 ms |                  25 ms |           1.7 ms |     4 ms |
|    128 MB | Large |      633 ms |        187 |      0.5 ms |                  30 ms |           1.4 ms |    11 ms |
|    192 MB | SQL   |     1327 ms |        806 |      0.3 ms |                  22 ms |           0.9 ms |     3 ms |
|    192 MB | Large |     1338 ms |        273 |      0.3 ms |                  22 ms |           0.6 ms |     1 ms |
|    256 MB | Large |     2048 ms |        564 |      0.3 ms |                  53 ms |           1.9 ms |     3 ms |

What the table shows, and what it does not:

- Building the model, scrolling, searching and typing stay fast to 256 MB. The synthetic text is
  repetitive and these runs did not measure idle tokenization in the background or a real person's
  typing against a cold tokenizer, so the timings are a floor, not a promise for arbitrary SQL.
- Syntax highlighting is what costs memory: at 192 MB the SQL tokenizer holds about 4× the file
  (806 MB) where Large File Mode holds about 1.4× (273 MB).
- **`model.getValue()` fails at 256 MB** (“Operation would exceed heap memory limits”): turning the
  edited document back into one string needs a second copy of it. Saving a document from the editor
  does exactly that, so an editor-based save is unsafe at this size even though editing worked.
- **A JavaScript string cannot exceed about 512 MB** (V8 limit, 2²⁹ − 24 characters), so a 1 or 2 GB
  file cannot be an editor model at all in any renderer. Files of 100 MB to 2 GB were therefore not
  opened in Monaco: they are opened in the streaming viewer (`VirtualViewer`, which reads only the
  lines in view; benchmarked up to 3 GB by `npm run bench:db`), executed as a stream, or imported.

## The limits the app uses

Configured in `packages/ui/src/dbstudio/largeFile.ts` and saved per user; decided from the file's
size alone (metadata, never contents):

| Size         | Handling                                                             |
| ------------ | -------------------------------------------------------------------- |
| up to 4 MiB  | Editor, every feature on                                             |
| up to 32 MiB | Editor in **Large File Mode** (a visible banner), reduced features   |
| above        | Not loaded into an editor: streaming viewer, execute, import, cancel |

The ceiling a user can raise the editor limit to is 64 MiB, which is what the file host will return
as one text (`STUDIO_BUDGETS.maxFullEditBytes`; the host process has a 512 MB heap and holds the
bytes, the buffer and the string while it reads). The measurements above show 128 MB working in the
renderer, so the ceiling is conservative on purpose: it is bounded by the host, not by Monaco.
