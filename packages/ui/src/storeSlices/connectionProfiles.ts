/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { StateCreator } from 'zustand';
import {
    createId,
    createSshProfile as newSshProfile,
    createTunnelProfile as newTunnelProfile,
    type SshProfile,
    type TunnelProfile,
} from '@httpreq/shared';
import type { WorkbenchState } from '../store';
import { touch } from './helpers';

/** The desktop SSH connection and tunnel profiles stored in the workspace. */
export interface ConnectionProfilesSlice {
    /** Adds a profile (a fresh one when none is given) and returns its id. */
    createSshProfile: (profile?: SshProfile) => string;
    updateSshProfile: (id: string, patch: Partial<Omit<SshProfile, 'id' | 'credentialId'>>) => void;
    duplicateSshProfile: (id: string) => string | null;
    deleteSshProfile: (id: string) => void;
    /** Adds a tunnel (a fresh one on the first SSH profile when none is given) and returns its id. */
    createTunnelProfile: (tunnel?: TunnelProfile) => string;
    updateTunnelProfile: (id: string, patch: Partial<Omit<TunnelProfile, 'id'>>) => void;
    duplicateTunnelProfile: (id: string) => string | null;
    deleteTunnelProfile: (id: string) => void;
}

export const createConnectionProfilesSlice: StateCreator<
    WorkbenchState,
    [],
    [],
    ConnectionProfilesSlice
> = (set, get) => ({
    createSshProfile: (profile = newSshProfile()) => {
        set((state) => ({
            workspace: touch(state.workspace, {
                sshProfiles: [...state.workspace.sshProfiles, profile],
            }),
            sidebarView: 'ssh',
        }));
        return profile.id;
    },

    updateSshProfile: (id, patch) =>
        set((state) => ({
            workspace: touch(state.workspace, {
                sshProfiles: state.workspace.sshProfiles.map((profile) =>
                    // `credentialId` is never patched: the vault entry has to follow the profile.
                    profile.id === id
                        ? { ...profile, ...patch, id, credentialId: profile.credentialId }
                        : profile,
                ),
            }),
        })),

    duplicateSshProfile: (id) => {
        const state = get();
        const index = state.workspace.sshProfiles.findIndex((profile) => profile.id === id);
        const source = state.workspace.sshProfiles[index];
        if (!source) return null;
        // A fresh credential id, so the copy starts without the original's stored secret.
        const copy: SshProfile = {
            ...source,
            id: createId(),
            credentialId: createId(),
            name: `${source.name} (copy)`,
        };
        const sshProfiles = [...state.workspace.sshProfiles];
        sshProfiles.splice(index + 1, 0, copy);
        set({ workspace: touch(state.workspace, { sshProfiles }) });
        return copy.id;
    },

    deleteSshProfile: (id) =>
        set((state) => ({
            workspace: touch(state.workspace, {
                sshProfiles: state.workspace.sshProfiles.filter((profile) => profile.id !== id),
                // Dependent tunnels are kept but unlinked, so the user can repoint rather than rebuild.
                tunnelProfiles: state.workspace.tunnelProfiles.map((tunnel) =>
                    tunnel.sshProfileId === id
                        ? { ...tunnel, sshProfileId: '', autoStart: false }
                        : tunnel,
                ),
            }),
        })),

    createTunnelProfile: (tunnel) => {
        const state = get();
        const profile = tunnel ?? newTunnelProfile(state.workspace.sshProfiles[0]?.id ?? '');
        set({
            workspace: touch(state.workspace, {
                tunnelProfiles: [...state.workspace.tunnelProfiles, profile],
            }),
            sidebarView: 'tunnels',
        });
        return profile.id;
    },

    updateTunnelProfile: (id, patch) =>
        set((state) => ({
            workspace: touch(state.workspace, {
                tunnelProfiles: state.workspace.tunnelProfiles.map((tunnel) =>
                    tunnel.id === id ? { ...tunnel, ...patch, id } : tunnel,
                ),
            }),
        })),

    duplicateTunnelProfile: (id) => {
        const state = get();
        const index = state.workspace.tunnelProfiles.findIndex((tunnel) => tunnel.id === id);
        const source = state.workspace.tunnelProfiles[index];
        if (!source) return null;
        // The local port has to be unique, so the copy starts stopped and not auto-starting.
        const copy: TunnelProfile = {
            ...source,
            id: createId(),
            name: `${source.name} (copy)`,
            autoStart: false,
        };
        const tunnelProfiles = [...state.workspace.tunnelProfiles];
        tunnelProfiles.splice(index + 1, 0, copy);
        set({ workspace: touch(state.workspace, { tunnelProfiles }) });
        return copy.id;
    },

    deleteTunnelProfile: (id) =>
        set((state) => ({
            workspace: touch(state.workspace, {
                tunnelProfiles: state.workspace.tunnelProfiles.filter((tunnel) => tunnel.id !== id),
            }),
        })),
});
