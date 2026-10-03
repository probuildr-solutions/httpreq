/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * What the current runtime is allowed to do. One React application runs on both platforms, so
 * every desktop-only feature is gated on this object rather than on a build flag.
 *
 * Hiding a button is presentation, not security: the Electron main process re-checks the same
 * conditions before it touches a socket, a key file or the credential vault.
 */
export interface PlatformCapabilities {
    desktop: boolean;
    ssh: boolean;
    tunneling: boolean;
    nativeFilePicker: boolean;
    secureCredentialStorage: boolean;
    /** WebSocket handshake headers; browsers forbid them. */
    webSocketHeaders: boolean;
    /** Native gRPC (HTTP/2 with trailers) needs a process that can open raw sockets. */
    grpc: boolean;
    /** MQTT over TCP/TLS likewise. */
    mqtt: boolean;
    /** Database Studio: large-file tools and database connections, which need native processes. */
    databaseStudio: boolean;
}

export const WEB_CAPABILITIES: PlatformCapabilities = {
    desktop: false,
    ssh: false,
    tunneling: false,
    nativeFilePicker: false,
    secureCredentialStorage: false,
    webSocketHeaders: false,
    grpc: false,
    mqtt: false,
    databaseStudio: false,
};

export const DESKTOP_CAPABILITIES: PlatformCapabilities = {
    desktop: true,
    ssh: true,
    tunneling: true,
    nativeFilePicker: true,
    secureCredentialStorage: true,
    webSocketHeaders: true,
    grpc: true,
    mqtt: true,
    databaseStudio: true,
};

/**
 * Derives the capability set from what the preload actually exposed. A desktop build whose SSH
 * bridge failed to initialise is reported honestly as "no SSH" rather than optimistically.
 */
export const detectCapabilities = (
    bridge:
        | {
              desktop?: unknown;
              ssh?: unknown;
              tunnels?: unknown;
              webSocket?: unknown;
              grpc?: unknown;
              mqtt?: unknown;
              dbStudio?: unknown;
          }
        | undefined,
): PlatformCapabilities => {
    if (!bridge?.desktop) return WEB_CAPABILITIES;
    return {
        desktop: true,
        ssh: !!bridge.ssh,
        tunneling: !!bridge.ssh && !!bridge.tunnels,
        nativeFilePicker: !!bridge.ssh,
        secureCredentialStorage: !!bridge.ssh,
        webSocketHeaders: !!bridge.webSocket,
        grpc: !!bridge.grpc,
        mqtt: !!bridge.mqtt,
        databaseStudio: !!bridge.dbStudio,
    };
};
