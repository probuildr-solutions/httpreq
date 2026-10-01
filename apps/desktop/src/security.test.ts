/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
    buildContentSecurityPolicy,
    denyAllPermissions,
    hasDebuggerSwitch,
    isDevToolsAllowed,
    lockDownWebContents,
} from './security';

type Listener = (event: { preventDefault: () => void }, url?: string) => void;

/** The few `WebContents` members the policy touches, recording what it registers. */
const fakeContents = () => {
    const listeners = new Map<string, Listener>();
    return {
        listeners,
        setWindowOpenHandler: vi.fn(),
        closeDevTools: vi.fn(),
        on: vi.fn((name: string, listener: Listener) => listeners.set(name, listener)),
    };
};

describe('the content security policy', () => {
    it('blocks inline scripts in production and plugins, base rewrites and framing always', () => {
        const production = buildContentSecurityPolicy(false);
        expect(production).toContain("script-src 'self' blob:");
        expect(production).not.toContain("'unsafe-inline' blob:");
        for (const directive of [
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ]) {
            expect(production).toContain(directive);
        }
    });

    it('allows the inline preamble Vite needs in development only', () => {
        expect(buildContentSecurityPolicy(true)).toContain(
            "script-src 'self' 'unsafe-inline' blob:",
        );
    });
});

describe('developer tools policy', () => {
    it('is on for development builds and off for packaged ones', () => {
        expect(isDevToolsAllowed(false, {})).toBe(true);
        expect(isDevToolsAllowed(true, {})).toBe(false);
    });

    it('can be switched on for a packaged build only by an explicit opt-in', () => {
        expect(isDevToolsAllowed(true, { HTTPREQ_DEVTOOLS: '1' })).toBe(true);
        expect(isDevToolsAllowed(true, { HTTPREQ_DEVTOOLS: 'true' })).toBe(false);
    });
});

describe('debugger detection', () => {
    it('flags the switches that open the renderer to an external debugger', () => {
        expect(hasDebuggerSwitch((name) => name === 'remote-debugging-port')).toBe(true);
        expect(hasDebuggerSwitch((name) => name === 'remote-debugging-pipe')).toBe(true);
        expect(hasDebuggerSwitch(() => false)).toBe(false);
    });
});

describe('permission policy', () => {
    it('refuses every request and every check', () => {
        let requestHandler: ((...args: unknown[]) => void) | undefined;
        let checkHandler: (() => boolean) | undefined;
        denyAllPermissions({
            setPermissionRequestHandler: (handler: never) => (requestHandler = handler),
            setPermissionCheckHandler: (handler: never) => (checkHandler = handler),
        } as never);

        const callback = vi.fn();
        requestHandler?.({}, 'media', callback);
        expect(callback).toHaveBeenCalledWith(false);
        expect(checkHandler?.()).toBe(false);
    });
});

describe('web contents lock-down', () => {
    it('denies new windows, webviews and navigation away from the app', () => {
        const contents = fakeContents();
        lockDownWebContents(contents as never, { devToolsAllowed: true });
        expect(contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });

        for (const channel of ['will-navigate', 'will-redirect']) {
            const away = { preventDefault: vi.fn() };
            contents.listeners.get(channel)!(away, 'https://evil.example/');
            expect(away.preventDefault).toHaveBeenCalled();

            const inside = { preventDefault: vi.fn() };
            contents.listeners.get(channel)!(inside, 'file:///app/index.html');
            expect(inside.preventDefault).not.toHaveBeenCalled();
        }

        const attach = { preventDefault: vi.fn() };
        contents.listeners.get('will-attach-webview')!(attach);
        expect(attach.preventDefault).toHaveBeenCalled();
    });

    it('closes the developer tools the moment they open, unless they are allowed', () => {
        const locked = fakeContents();
        lockDownWebContents(locked as never, { devToolsAllowed: false });
        locked.listeners.get('devtools-opened')!({ preventDefault: () => undefined });
        expect(locked.closeDevTools).toHaveBeenCalled();

        const open = fakeContents();
        lockDownWebContents(open as never, { devToolsAllowed: true });
        expect(open.listeners.has('devtools-opened')).toBe(false);
    });
});
