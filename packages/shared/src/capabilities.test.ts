/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { detectCapabilities, WEB_CAPABILITIES } from './capabilities';

describe('detectCapabilities', () => {
    it('gives the browser no SSH, no tunnelling and no handshake headers', () => {
        expect(detectCapabilities(undefined)).toEqual(WEB_CAPABILITIES);
        expect(detectCapabilities({})).toEqual(WEB_CAPABILITIES);
    });

    it('gives a complete desktop build everything', () => {
        expect(
            detectCapabilities({
                desktop: {},
                ssh: {},
                tunnels: {},
                webSocket: {},
                grpc: {},
                mqtt: {},
                dbStudio: {},
            }),
        ).toEqual({
            desktop: true,
            ssh: true,
            tunneling: true,
            nativeFilePicker: true,
            secureCredentialStorage: true,
            webSocketHeaders: true,
            grpc: true,
            mqtt: true,
            databaseStudio: true,
        });
    });

    it('reports a desktop build with no SSH bridge honestly, instead of assuming it is there', () => {
        const capabilities = detectCapabilities({ desktop: {}, webSocket: {} });
        expect(capabilities).toMatchObject({
            desktop: true,
            ssh: false,
            tunneling: false,
            nativeFilePicker: false,
            secureCredentialStorage: false,
            webSocketHeaders: true,
            grpc: false,
            mqtt: false,
            databaseStudio: false,
        });
    });

    it('does not allow tunnelling without SSH, since a tunnel needs a connection to carry it', () => {
        expect(detectCapabilities({ desktop: {}, tunnels: {} }).tunneling).toBe(false);
    });

    it('offers Database Studio only when the preload actually exposed its bridge', () => {
        expect(detectCapabilities({ desktop: {} }).databaseStudio).toBe(false);
        expect(detectCapabilities({ desktop: {}, dbStudio: {} }).databaseStudio).toBe(true);
        // Without the desktop shell there is no native process to run it in.
        expect(detectCapabilities({ dbStudio: {} }).databaseStudio).toBe(false);
    });
});
