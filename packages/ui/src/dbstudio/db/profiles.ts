/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';
import type { DbConnectionSettings, DbTlsMode } from '@httpreq/shared';

/**
 * Saved connections. A profile says how to reach a server; it never holds a password. The password
 * is stored by the main process in the operating system's credential store under the profile's id,
 * so exporting, copying or logging a profile cannot leak it.
 */
export interface ConnectionProfile {
    /** 16 hex characters: also the id of the live connection. */
    id: string;
    name: string;
    settings: DbConnectionSettings;
    /** A folder name in the explorer; empty for none. */
    group: string;
    favorite: boolean;
    /** When it was last connected, for the "recent" list. */
    lastUsed: number | null;
}

export const PROFILES_KEY = 'httpreq.dbstudio.profiles';

const TLS_MODES: readonly DbTlsMode[] = [
    'disable',
    'prefer',
    'require',
    'verify-ca',
    'verify-full',
];

/** 16 random hex characters. */
export const newProfileId = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');

const isText = (value: unknown, max = 512): value is string =>
    typeof value === 'string' && value.length <= max;

const parseSettings = (value: unknown): DbConnectionSettings | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const tls = raw.tls && typeof raw.tls === 'object' ? (raw.tls as Record<string, unknown>) : {};
    if (!isText(raw.engine, 32) || !isText(raw.host, 255) || !Number.isInteger(raw.port))
        return null;
    if ((raw.port as number) < 1 || (raw.port as number) > 65535) return null;
    const options: Record<string, string> = {};
    if (raw.options && typeof raw.options === 'object') {
        for (const [key, item] of Object.entries(raw.options))
            if (isText(item, 1024)) options[key] = item;
    }
    return {
        engine: raw.engine,
        host: raw.host,
        port: raw.port as number,
        ...(isText(raw.database, 256) && raw.database ? { database: raw.database } : {}),
        ...(isText(raw.username, 256) && raw.username ? { username: raw.username } : {}),
        tls: {
            mode: TLS_MODES.includes(tls.mode as DbTlsMode) ? (tls.mode as DbTlsMode) : 'prefer',
            ...(isText(tls.ca, 262_144) && tls.ca ? { ca: tls.ca } : {}),
            ...(isText(tls.cert, 262_144) && tls.cert ? { cert: tls.cert } : {}),
            ...(isText(tls.key, 262_144) && tls.key ? { key: tls.key } : {}),
            ...(isText(tls.serverName, 255) && tls.serverName
                ? { serverName: tls.serverName }
                : {}),
        },
        ...(Number.isInteger(raw.connectTimeoutMs)
            ? { connectTimeoutMs: raw.connectTimeoutMs as number }
            : {}),
        ...(Number.isInteger(raw.queryTimeoutMs)
            ? { queryTimeoutMs: raw.queryTimeoutMs as number }
            : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
    };
};

/** Reads saved profiles, keeping the valid ones and dropping anything damaged. */
export const parseProfiles = (raw: string | null): ConnectionProfile[] => {
    if (!raw) return [];
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: ConnectionProfile[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const profile = item as Record<string, unknown>;
        const settings = parseSettings(profile.settings);
        if (
            !settings ||
            typeof profile.id !== 'string' ||
            !/^[0-9a-f]{16}$/.test(profile.id) ||
            seen.has(profile.id)
        )
            continue;
        seen.add(profile.id);
        out.push({
            id: profile.id,
            name:
                isText(profile.name, 128) && profile.name
                    ? profile.name
                    : `${settings.host}:${settings.port}`,
            settings,
            group: isText(profile.group, 64) ? profile.group : '',
            favorite: profile.favorite === true,
            lastUsed: typeof profile.lastUsed === 'number' ? profile.lastUsed : null,
        });
    }
    return out;
};

const read = (): ConnectionProfile[] => {
    try {
        return parseProfiles(globalThis.localStorage?.getItem(PROFILES_KEY) ?? null);
    } catch {
        return [];
    }
};

const write = (profiles: ConnectionProfile[]) => {
    try {
        globalThis.localStorage?.setItem(PROFILES_KEY, JSON.stringify(profiles));
    } catch {
        // Storage can be full or blocked; the profiles still work for this session.
    }
};

interface ProfilesState {
    profiles: ConnectionProfile[];
    add: (
        profile: Omit<ConnectionProfile, 'lastUsed' | 'favorite'> &
            Partial<Pick<ConnectionProfile, 'favorite'>>,
    ) => void;
    update: (id: string, patch: Partial<Omit<ConnectionProfile, 'id'>>) => void;
    remove: (id: string) => void;
    duplicate: (id: string) => string | null;
    touch: (id: string) => void;
    toggleFavorite: (id: string) => void;
}

export const useProfiles = create<ProfilesState>((set, get) => {
    const commit = (profiles: ConnectionProfile[]) => {
        write(profiles);
        set({ profiles });
    };
    return {
        profiles: read(),
        add: (profile) =>
            commit([...get().profiles, { favorite: false, lastUsed: null, ...profile }]),
        update: (id, patch) =>
            commit(get().profiles.map((p) => (p.id === id ? { ...p, ...patch } : p))),
        remove: (id) => commit(get().profiles.filter((p) => p.id !== id)),
        duplicate: (id) => {
            const source = get().profiles.find((p) => p.id === id);
            if (!source) return null;
            const copy: ConnectionProfile = {
                ...source,
                id: newProfileId(),
                name: `${source.name} copy`,
                lastUsed: null,
            };
            commit([...get().profiles, copy]);
            return copy.id;
        },
        touch: (id) =>
            commit(get().profiles.map((p) => (p.id === id ? { ...p, lastUsed: Date.now() } : p))),
        toggleFavorite: (id) =>
            commit(get().profiles.map((p) => (p.id === id ? { ...p, favorite: !p.favorite } : p))),
    };
});

export const resetProfiles = () => useProfiles.setState({ profiles: [] });
