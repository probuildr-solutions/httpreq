/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSshProfile } from '@httpreq/shared';
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
        expect(connect).toHaveAttribute('data-state', 'idle');
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
        expect(disconnect).toHaveAttribute('data-state', 'active');
        fireEvent.click(disconnect);
        expect(ssh.disconnect).toHaveBeenCalledWith('s1');

        act(() => useConnectionsStore.getState().patchSession('s1', { status: 'disconnected' }));
        expect(await screen.findByRole('button', { name: 'Connect to Prod' })).toBeInTheDocument();
    });
});
