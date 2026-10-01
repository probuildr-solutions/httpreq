/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { CONNECTIVITY_PROBE_URL } from '@httpreq/shared';

export type ConnectivityStatus = 'online' | 'offline' | 'checking';

/** Resolves `true` when the internet is reachable. */
export type ConnectivityProbe = () => Promise<boolean>;

interface ConnectivityState {
    status: ConnectivityStatus;
    lastCheckedAt?: number;
}

export const useConnectivity = create<ConnectivityState>(() => ({
    status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'checking',
}));

/**
 * Browser probe: an opaque `no-cors` HEAD request. It cannot read the status code, but it only
 * resolves when a server answered, which is enough to tell "connected to a network" from
 * "connected to the internet".
 */
export const browserConnectivityProbe: ConnectivityProbe = async () => {
    try {
        await fetch(CONNECTIVITY_PROBE_URL, {
            method: 'HEAD',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            signal: AbortSignal.timeout(5000),
        });
        return true;
    } catch {
        return false;
    }
};

const FIRST_RETRY_MS = 10_000;
const MAX_RETRY_MS = 5 * 60_000;
const MIN_RECHECK_MS = 30_000;

/**
 * Tracks connectivity with `navigator.onLine` as the instant signal and a single probe to
 * confirm it. While online nothing is polled; a probe runs only when the browser reports a
 * change, when a request fails with a network error, or on an explicit re-check. While offline
 * (but attached to a network) it retries with exponential backoff.
 */
export class ConnectivityMonitor {
    private retryDelay = FIRST_RETRY_MS;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private inFlight: Promise<void> | undefined;
    private disposed = false;

    constructor(private readonly probe: ConnectivityProbe) {}

    start() {
        window.addEventListener('online', this.onOnline);
        window.addEventListener('offline', this.onOffline);
        document.addEventListener('visibilitychange', this.onVisible);
        if (navigator.onLine) void this.check({ announce: true });
        else this.setStatus('offline');
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.retryTimer);
        window.removeEventListener('online', this.onOnline);
        window.removeEventListener('offline', this.onOffline);
        document.removeEventListener('visibilitychange', this.onVisible);
    }

    /** Probes now. `announce` shows "Checking…" instead of keeping the current status. */
    check({ announce = false }: { announce?: boolean } = {}): Promise<void> {
        if (this.inFlight) return this.inFlight;
        clearTimeout(this.retryTimer);
        if (!navigator.onLine) {
            this.setStatus('offline');
            return Promise.resolve();
        }
        if (announce) this.setStatus('checking');
        this.inFlight = this.probe()
            .catch(() => false)
            .then((reachable) => {
                this.inFlight = undefined;
                if (this.disposed) return;
                useConnectivity.setState({ lastCheckedAt: Date.now() });
                if (reachable) {
                    this.retryDelay = FIRST_RETRY_MS;
                    this.setStatus('online');
                } else {
                    this.setStatus('offline');
                    this.scheduleRetry();
                }
            });
        return this.inFlight;
    }

    /** Feeds real request outcomes back in, so failures trigger a re-check without polling. */
    reportRequest(outcome: 'success' | 'network-error') {
        if (outcome === 'success') {
            this.retryDelay = FIRST_RETRY_MS;
            clearTimeout(this.retryTimer);
            this.setStatus('online');
            return;
        }
        const last = useConnectivity.getState().lastCheckedAt ?? 0;
        if (Date.now() - last >= MIN_RECHECK_MS) void this.check();
    }

    private scheduleRetry() {
        clearTimeout(this.retryTimer);
        if (!navigator.onLine) return;
        this.retryTimer = setTimeout(() => void this.check(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    }

    private setStatus(status: ConnectivityStatus) {
        if (useConnectivity.getState().status !== status) useConnectivity.setState({ status });
    }

    private onOnline = () => {
        this.retryDelay = FIRST_RETRY_MS;
        void this.check({ announce: true });
    };

    private onOffline = () => {
        clearTimeout(this.retryTimer);
        this.setStatus('offline');
    };

    private onVisible = () => {
        // Coming back to the app after being offline is a good moment to look again.
        if (
            document.visibilityState === 'visible' &&
            useConnectivity.getState().status === 'offline'
        )
            void this.check();
    };
}

let activeMonitor: ConnectivityMonitor | undefined;

/** Re-checks connectivity immediately (e.g. from the status bar). */
export const recheckConnectivity = () => activeMonitor?.check({ announce: true });

/** Reports a request outcome to the running monitor, if any. */
export const reportRequestConnectivity = (outcome: 'success' | 'network-error') =>
    activeMonitor?.reportRequest(outcome);

/** Runs the connectivity monitor for as long as the app is mounted, using the host's own probe. */
export function useConnectivityMonitor(probe: ConnectivityProbe) {
    useEffect(() => {
        const monitor = new ConnectivityMonitor(probe);
        activeMonitor = monitor;
        monitor.start();
        return () => {
            monitor.dispose();
            if (activeMonitor === monitor) activeMonitor = undefined;
        };
    }, [probe]);
}
