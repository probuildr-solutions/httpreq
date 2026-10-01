/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSshProfile, createWorkspace } from '@httpreq/workspace';
import { SshContext, type SshApi } from '../ssh/useSsh';
import { useWorkbenchStore } from '../store';
import { TunnelContext, type TunnelApi } from './useTunnels';
import { TunnelsPanel } from './TunnelsPanel';

/** A new tunnel exists only in its dialog until Save; anything else leaves no trace. */

const store = () => useWorkbenchStore.getState();

const tunnels: TunnelApi = {
    available: true,
    start: vi.fn(async () => null),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => null),
    isPortAvailable: vi.fn(async () => true),
    stopAll: vi.fn(async () => undefined),
};

const mount = () =>
    render(
        <>
            <SshContext.Provider value={{ pendingHostKey: null } as SshApi}>
                <TunnelContext.Provider value={tunnels}>
                    <TunnelsPanel />
                </TunnelContext.Provider>
            </SshContext.Provider>
        </>,
    );

const openNew = async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'New tunnel' })[0]!);
    await screen.findByText('New SSH tunnel');
};

beforeEach(() => {
    store().load(createWorkspace('Test'), {}, []);
    store().createSshProfile({ ...createSshProfile('Bastion'), host: 'a.dev', username: 'ada' });
});

describe('new tunnels', () => {
    it('discards a cancelled one', async () => {
        mount();
        await openNew();
        expect(store().workspace.tunnelProfiles).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(store().workspace.tunnelProfiles).toEqual([]);
    });

    it('adds one to the workspace on Save, carried by the first SSH connection', async () => {
        mount();
        await openNew();
        fireEvent.change(screen.getByLabelText(/Local port/), { target: { value: '3307' } });
        fireEvent.change(screen.getByLabelText(/Remote host/), {
            target: { value: 'mysql.internal' },
        });
        fireEvent.change(screen.getByLabelText(/Remote port/), { target: { value: '3306' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(store().workspace.tunnelProfiles).toHaveLength(1));
        expect(store().workspace.tunnelProfiles[0]).toMatchObject({
            sshProfileId: store().workspace.sshProfiles[0]!.id,
            localPort: 3307,
            remoteHost: 'mysql.internal',
            remotePort: 3306,
        });
    });
});
