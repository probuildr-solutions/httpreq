/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useConnectionsStore } from '../connections';
import { SshContext, type SshApi } from './useSsh';
import { SshTerminal } from './SshTerminal';

/**
 * The terminal's relationship with its tab.
 *
 * A terminal is a live screen, not a rendering of stored data: xterm holds the scrollback, the
 * prompt and whatever full-screen program is running, and disposing it throws all of that away.
 * The application therefore keeps every open terminal mounted and only hides the inactive ones,
 * and these tests hold the two halves of that contract — that the terminal subscribes once, and
 * that it stays subscribed while hidden.
 */

const writes: string[] = [];
const resizes: unknown[] = [];
let subscriptions = 0;

const api = (): SshApi => ({
    available: true,
    open: vi.fn(async () => 's1'),
    disconnect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    write: (_id, data) => writes.push(data),
    resize: (_id, size) => resizes.push(size),
    test: vi.fn(async () => null),
    pickPrivateKey: vi.fn(async () => null),
    setCredential: vi.fn(async () => true),
    hasCredential: vi.fn(async () => true),
    deleteCredential: vi.fn(async () => undefined),
    onData: () => {
        subscriptions += 1;
        return () => {
            subscriptions -= 1;
        };
    },
    pendingHostKey: null,
    answerHostKey: vi.fn(),
    closeAll: vi.fn(async () => undefined),
});

const mount = (hidden: boolean) =>
    render(
        <>
            <SshContext.Provider value={api()}>
                <div hidden={hidden}>
                    <SshTerminal sessionId="s1" />
                </div>
            </SshContext.Provider>
        </>,
    );

beforeEach(() => {
    writes.length = 0;
    resizes.length = 0;
    subscriptions = 0;
    act(() => {
        useConnectionsStore.getState().setSession({
            sessionId: 's1',
            profileId: 'p1',
            name: 'EC2',
            status: 'connected',
            error: null,
            startedAt: null,
            generation: 1,
        });
    });
});

describe('the SSH terminal', () => {
    it('subscribes to its session exactly once while it is on screen', () => {
        mount(false);
        expect(document.querySelector('.xterm')).toBeTruthy();
        expect(subscriptions).toBe(1);
    });

    it('keeps its terminal and its subscription while its tab is hidden', () => {
        const view = mount(false);
        const terminal = document.querySelector('.xterm');

        // Hiding the panel is what a tab switch does: the terminal must survive it untouched, or
        // returning to a still-connected session would show an empty pane.
        view.rerender(
            <>
                <SshContext.Provider value={api()}>
                    <div hidden>
                        <SshTerminal sessionId="s1" />
                    </div>
                </SshContext.Provider>
            </>,
        );

        expect(document.querySelector('.xterm')).toBe(terminal);
        expect(subscriptions).toBe(1);
    });

    it('takes the terminal off screen once the session is no longer live', () => {
        mount(false);
        act(() => useConnectionsStore.getState().patchSession('s1', { status: 'disconnected' }));

        expect(document.querySelector('.xterm')).toBeNull();
        expect(subscriptions).toBe(0);
        expect(screen.getByText('This session is disconnected.')).toBeInTheDocument();
    });
});
