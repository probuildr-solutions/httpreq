/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSshProfile, type SshErrorInfo, type SshStatus } from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { act } from 'react';
import { resetConnections, useConnectionsStore } from '../connections';
import { useWorkbenchStore } from '../store';
import { SshContext, type SshApi } from './useSsh';
import { SshPanel } from './SshPanel';

/** A new connection exists only in its dialog until Save; anything else leaves no trace. */

const store = () => useWorkbenchStore.getState();

const api = (): SshApi => ({
    available: true,
    open: vi.fn(async () => 's1'),
    disconnect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    write: vi.fn(),
    resize: vi.fn(),
    test: vi.fn(async () => null),
    pickPrivateKey: vi.fn(async () => null),
    setCredential: vi.fn(async () => true),
    hasCredential: vi.fn(async () => false),
    deleteCredential: vi.fn(async () => undefined),
    onData: () => () => undefined,
    pendingHostKey: null,
    answerHostKey: vi.fn(),
    closeAll: vi.fn(async () => undefined),
});

const mount = (ssh: SshApi) =>
    render(
        <>
            <SshContext.Provider value={ssh}>
                <SshPanel />
            </SshContext.Provider>
        </>,
    );

const fill = () => {
    fireEvent.change(screen.getByLabelText(/Host/), { target: { value: 'ssh.example.com' } });
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'hunter2' } });
};

beforeEach(() => store().load(createWorkspace('Test'), {}, []));

describe('new SSH connections', () => {
    it('adds nothing to the workspace until Save', async () => {
        mount(api());
        fireEvent.click(screen.getByRole('button', { name: 'New connection' }));
        expect(await screen.findByText('New SSH connection')).toBeInTheDocument();
        expect(store().workspace.sshProfiles).toEqual([]);

        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(store().workspace.sshProfiles).toHaveLength(1));
        expect(store().workspace.sshProfiles[0]).toMatchObject({
            host: 'ssh.example.com',
            username: 'ada',
        });
    });

    it('discards a cancelled one, including a secret stored while testing it', async () => {
        const ssh = api();
        mount(ssh);
        fireEvent.click(screen.getByRole('button', { name: 'New connection' }));
        await screen.findByText('New SSH connection');
        fill();

        fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
        await waitFor(() => expect(ssh.test).toHaveBeenCalled());
        expect(store().workspace.sshProfiles).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        const credentialId = vi.mocked(ssh.setCredential).mock.calls[0]![0];
        expect(ssh.deleteCredential).toHaveBeenCalledWith(credentialId);
        expect(store().workspace.sshProfiles).toEqual([]);
    });
});

describe('the connect button', () => {
    it('connects when idle and disconnects when live, following the session state', async () => {
        const profile = createSshProfile('Prod');
        store().createSshProfile(profile);
        resetConnections();
        const ssh = api();
        mount(ssh);

        const connect = screen.getByRole('button', { name: 'Connect to Prod' });
        expect(connect).toHaveAttribute('data-state', 'disconnected');
        fireEvent.click(connect);
        expect(ssh.open).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }));

        act(() =>
            useConnectionsStore.getState().setSession({
                sessionId: 's1',
                profileId: profile.id,
                name: 'Prod',
                status: 'connected',
                error: null,
                startedAt: null,
                generation: 1,
            }),
        );
        const disconnect = await screen.findByRole('button', { name: 'Disconnect from Prod' });
        expect(disconnect).toHaveAttribute('data-state', 'connected');
        fireEvent.click(disconnect);
        expect(ssh.disconnect).toHaveBeenCalledWith('s1');

        act(() => useConnectionsStore.getState().patchSession('s1', { status: 'disconnected' }));
        expect(await screen.findByRole('button', { name: 'Connect to Prod' })).toBeInTheDocument();
    });

    const session = (profileId: string, status: SshStatus, error: SshErrorInfo | null = null) => ({
        sessionId: 's1',
        profileId,
        name: 'Prod',
        status,
        error,
        startedAt: null,
        generation: 1,
    });

    it('shows a spinner, not Stop, while the connection is being established', async () => {
        const profile = createSshProfile('Prod');
        store().createSshProfile(profile);
        resetConnections();
        const ssh = api();
        mount(ssh);

        act(() => useConnectionsStore.getState().setSession(session(profile.id, 'connecting')));
        const busy = await screen.findByRole('button', { name: 'Connecting to Prod' });
        expect(busy).toHaveAttribute('data-state', 'connecting');
        expect(busy).toBeDisabled();
        expect(screen.queryByRole('button', { name: /Disconnect from Prod/ })).toBeNull();
        fireEvent.click(busy);
        expect(ssh.open).not.toHaveBeenCalled();
        expect(ssh.disconnect).not.toHaveBeenCalled();

        act(() => useConnectionsStore.getState().patchSession('s1', { status: 'connected' }));
        expect(await screen.findByRole('button', { name: 'Disconnect from Prod' })).toBeEnabled();
    });

    it('keeps the spinner while disconnecting, then offers Play again', async () => {
        const profile = createSshProfile('Prod');
        store().createSshProfile(profile);
        resetConnections();
        mount(api());

        act(() => useConnectionsStore.getState().setSession(session(profile.id, 'disconnecting')));
        const busy = await screen.findByRole('button', { name: 'Disconnecting from Prod' });
        expect(busy).toBeDisabled();

        act(() => useConnectionsStore.getState().patchSession('s1', { status: 'disconnected' }));
        expect(await screen.findByRole('button', { name: 'Connect to Prod' })).toBeEnabled();
    });

    it('returns to Play and shows the error when the connection fails', async () => {
        const profile = createSshProfile('Prod');
        store().createSshProfile(profile);
        resetConnections();
        mount(api());

        act(() => useConnectionsStore.getState().setSession(session(profile.id, 'connecting')));
        act(() =>
            useConnectionsStore.getState().patchSession('s1', {
                status: 'error',
                error: { code: 'SSH_HOST_UNREACHABLE', message: 'The connection was refused.' },
            }),
        );
        expect(await screen.findByRole('button', { name: 'Connect to Prod' })).toBeEnabled();
        expect(screen.getByRole('alert')).toHaveTextContent('The connection was refused.');
    });
});
