/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { SshErrorInfo } from '@httpreq/shared';
import type { SshSessionState } from '../connections';

/**
 * What a profile's Play/Stop control shows. It is derived from the live sessions the main process
 * reports on, never from a click: a click starts an operation, and only the lifecycle events that
 * follow it move the control.
 *
 *   disconnected ─ Play ─▶ connecting ─ success ─▶ connected ─ Stop ─▶ disconnecting ─▶ disconnected
 *                              └─ failure ─▶ disconnected (with `error`)
 */
export type SshConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

export interface SshProfileConnection {
    phase: SshConnectionPhase;
    /** Sessions of the profile in `connected` or `connecting`: what Stop has to end. */
    activeSessionIds: string[];
    /** Why the most recent attempt failed; only while the profile is back to `disconnected`. */
    error: SshErrorInfo | null;
}

/** An operation is in flight, so Play and Stop must not accept another click. */
export const isSshBusy = (phase: SshConnectionPhase) =>
    phase === 'connecting' || phase === 'disconnecting';

export const sshProfileConnection = (
    sessions: Record<string, SshSessionState | undefined>,
    profileId: string,
): SshProfileConnection => {
    const own = Object.values(sessions).filter(
        (session): session is SshSessionState => session?.profileId === profileId,
    );
    const has = (status: SshSessionState['status']) => own.some((s) => s.status === status);
    const phase: SshConnectionPhase = has('disconnecting')
        ? 'disconnecting'
        : has('connecting')
          ? 'connecting'
          : has('connected')
            ? 'connected'
            : 'disconnected';
    const failed = own.find((session) => session.status === 'error');
    return {
        phase,
        activeSessionIds: own
            .filter((s) => s.status === 'connected' || s.status === 'connecting')
            .map((s) => s.sessionId),
        error: phase === 'disconnected' ? (failed?.error ?? null) : null,
    };
};
