/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { Session, WebContents } from 'electron';
import { isTrustedRendererUrl } from './shell';

/**
 * The desktop app's security policy, in one place.
 *
 * Nothing here makes the application impossible to inspect: any code that runs on a user's
 * machine can eventually be read by that user. The goal is to raise the cost of the cheap attacks
 * (opening the developer tools, attaching a debugger, swapping files inside the package,
 * navigating the window to a hostile page) and to keep a compromised page from reaching
 * anything it was not explicitly given.
 */

/**
 * The Content Security Policy for the bundled renderer.
 *
 * Vite's React Fast Refresh injects an inline preamble script, so development must allow inline
 * scripts; production keeps the strict policy. `object-src`, `base-uri`, `form-action` and
 * `frame-ancestors` close the remaining injection routes the `default-src` fallback leaves open.
 */
export const buildContentSecurityPolicy = (development: boolean): string =>
    [
        "default-src 'self'",
        // 'wasm-unsafe-eval' lets the script sandbox (QuickJS compiled to WebAssembly) start. It
        // allows compiling WebAssembly only: JavaScript eval and new Function stay blocked.
        development
            ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:"
            : "script-src 'self' 'wasm-unsafe-eval' blob:",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        "connect-src 'self' http: https: ws: wss:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join('; ');

/**
 * Developer tools expose the renderer's sources and state, so packaged builds do not offer them.
 * A support engineer can opt in with `HTTPREQ_DEVTOOLS=1`, which is a deliberate act rather than
 * something a user can trigger from the menu by accident.
 */
export const isDevToolsAllowed = (
    packaged: boolean,
    environment: Record<string, string | undefined> = process.env,
): boolean => !packaged || environment.HTTPREQ_DEVTOOLS === '1';

/** Command-line switches that open the renderer to an external debugger. */
const DEBUGGER_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'] as const;

/**
 * Whether the process was started so that something outside it can attach and read it. A packaged
 * build refuses to run that way; the fuses already stop Node's own inspector flags.
 */
export const hasDebuggerSwitch = (hasSwitch: (name: string) => boolean): boolean =>
    DEBUGGER_SWITCHES.some((name) => hasSwitch(name));

/**
 * Denies every permission request and check. The app needs none of the powers a web page can ask
 * for (camera, microphone, geolocation, notifications, clipboard-read…), so the safe default is a
 * flat refusal rather than a prompt a user might click through.
 */
export const denyAllPermissions = (target: Session): void => {
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
};

export interface WebContentsPolicy {
    /** The Vite dev server's URL during development; undefined in a packaged build. */
    devServer?: string;
    devToolsAllowed: boolean;
}

/**
 * Locks a window's page to the bundled UI: no new windows, no embedded `<webview>`, no
 * navigation or redirect away from the trusted origin, and no developer tools unless allowed.
 */
export const lockDownWebContents = (contents: WebContents, policy: WebContentsPolicy): void => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // The renderer is a single-page app; it never needs to leave the bundled UI.
    const keepInsideApp = (event: { preventDefault: () => void }, url: string) => {
        if (!isTrustedRendererUrl(url, policy.devServer)) event.preventDefault();
    };
    contents.on('will-navigate', keepInsideApp);
    contents.on('will-redirect', keepInsideApp);
    contents.on('will-attach-webview', (event) => event.preventDefault());

    if (!policy.devToolsAllowed) {
        // Covers every route: the menu command, F12, the context menu and the remote protocol.
        contents.on('devtools-opened', () => contents.closeDevTools());
    }
};
