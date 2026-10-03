/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect, useState } from 'react';
import type { DbConnectionSettings, DbTestResult, DbTlsMode } from '@httpreq/shared';
import { AppModal } from '../../AppModal';
import {
    Alert,
    Button,
    NumberInput,
    PasswordInput,
    Select,
    Stack,
    Text,
    TextInput,
} from '../../kit';
import { useConnectionDialog } from './connectionDialogStore';
import { newProfileId, useProfiles, type ConnectionProfile } from './profiles';
import { useDbManager } from './useDbManager';

const DEFAULT_ENGINES = [{ id: 'mysql', displayName: 'MySQL / MariaDB', defaultPort: 3306 }];

const TLS_MODES: { value: DbTlsMode; label: string }[] = [
    { value: 'prefer', label: 'Use TLS if the server offers it' },
    { value: 'require', label: 'Require TLS' },
    { value: 'verify-ca', label: 'Require TLS and verify the certificate' },
    { value: 'verify-full', label: 'Require TLS, verify certificate and host name' },
    { value: 'disable', label: 'No TLS' },
];

const DATABASE_HINTS: Record<string, string> = {
    mysql: 'Optional',
    postgresql: 'The database to connect to; the user name when empty',
    mongodb: 'Optional. Statements run here until you use another database',
    redis: 'Optional. 0 when empty',
};

const AUTH_MECHANISMS = [
    { value: '', label: 'Automatic' },
    { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
    { value: 'SCRAM-SHA-1', label: 'SCRAM-SHA-1' },
];

interface Form {
    name: string;
    engine: string;
    host: string;
    port: number | string;
    username: string;
    password: string;
    database: string;
    tls: DbTlsMode;
    ca: string;
    queryTimeoutSeconds: number | string;
    /** MongoDB: where the user is defined, and how to log in. */
    authSource: string;
    authMechanism: string;
}

const blank = (engine: string, port: number): Form => ({
    name: '',
    engine,
    host: '127.0.0.1',
    port,
    username: '',
    password: '',
    database: '',
    tls: 'prefer',
    ca: '',
    queryTimeoutSeconds: 0,
    authSource: '',
    authMechanism: '',
});

const fromProfile = (profile: ConnectionProfile): Form => ({
    name: profile.name,
    engine: profile.settings.engine,
    host: profile.settings.host,
    port: profile.settings.port,
    username: profile.settings.username ?? '',
    password: '',
    database: profile.settings.database ?? '',
    tls: profile.settings.tls.mode,
    ca: profile.settings.tls.ca ?? '',
    queryTimeoutSeconds: Math.round((profile.settings.queryTimeoutMs ?? 0) / 1000),
    authSource: profile.settings.options?.authSource ?? '',
    authMechanism: profile.settings.options?.authMechanism ?? '',
});

const optionsOf = (form: Form): Record<string, string> => ({
    ...(form.engine === 'mongodb' && form.authSource.trim()
        ? { authSource: form.authSource.trim() }
        : {}),
    ...(form.engine === 'mongodb' && form.authMechanism
        ? { authMechanism: form.authMechanism }
        : {}),
});

const settingsOf = (form: Form): DbConnectionSettings => ({
    engine: form.engine,
    host: form.host.trim(),
    port: Number(form.port),
    ...(form.database.trim() ? { database: form.database.trim() } : {}),
    ...(form.username.trim() ? { username: form.username.trim() } : {}),
    tls: { mode: form.tls, ...(form.ca.trim() ? { ca: form.ca } : {}) },
    ...(Number(form.queryTimeoutSeconds) > 0
        ? { queryTimeoutMs: Number(form.queryTimeoutSeconds) * 1000 }
        : {}),
    ...(Object.keys(optionsOf(form)).length > 0 ? { options: optionsOf(form) } : {}),
});

/** Creates or edits a saved connection, and tests it before saving if asked. */
export function ConnectionDialog() {
    const manager = useDbManager();
    const target = useConnectionDialog((state) => state.target);
    const close = useConnectionDialog((state) => state.close);
    const profiles = useProfiles((state) => state.profiles);
    const engines = manager.engines.length > 0 ? manager.engines : DEFAULT_ENGINES;

    const existing = target && target !== 'new' ? profiles.find((p) => p.id === target) : undefined;
    const [form, setForm] = useState<Form>(blank('mysql', 3306));
    const [hasPassword, setHasPassword] = useState(false);
    const [testing, setTesting] = useState(false);
    const [test, setTest] = useState<
        { ok: true; result: DbTestResult } | { ok: false; message: string } | null
    >(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!target) return;
        setTest(null);
        setSaving(false);
        setForm(existing ? fromProfile(existing) : blank(engines[0]!.id, engines[0]!.defaultPort));
        setHasPassword(false);
        if (existing) void manager.db?.hasPassword(existing.id).then(setHasPassword);
        // Reset only when the dialog opens for a target.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    const set = <K extends keyof Form>(key: K, value: Form[K]) => {
        setForm((current) => ({ ...current, [key]: value }));
        setTest(null);
    };

    const port = Number(form.port);
    const valid = form.host.trim() !== '' && Number.isInteger(port) && port > 0 && port < 65536;

    const runTest = async () => {
        setTesting(true);
        setTest(null);
        try {
            const result = await manager.testConnection(
                settingsOf(form),
                existing?.id ?? newProfileId(),
                form.password !== '' ? form.password : undefined,
            );
            setTest({ ok: true, result });
        } catch (error) {
            setTest({ ok: false, message: error instanceof Error ? error.message : String(error) });
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        setSaving(true);
        const profile: ConnectionProfile = {
            id: existing?.id ?? newProfileId(),
            name: form.name.trim() || `${form.host.trim()}:${port}`,
            settings: settingsOf(form),
            group: existing?.group ?? '',
            favorite: existing?.favorite ?? false,
            lastUsed: existing?.lastUsed ?? null,
        };
        try {
            await manager.saveProfile(profile, form.password);
            close();
        } finally {
            setSaving(false);
        }
    };

    return (
        <AppModal
            opened={target !== null}
            onClose={close}
            title={existing ? 'Edit connection' : 'New connection'}
            size="md"
            footerStart={
                <Button
                    size="xs"
                    variant="light"
                    loading={testing}
                    disabled={!valid}
                    onClick={() => void runTest()}
                >
                    Test connection
                </Button>
            }
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={close}>
                        Cancel
                    </Button>
                    <Button
                        size="xs"
                        loading={saving}
                        disabled={!valid}
                        onClick={() => void save()}
                    >
                        Save
                    </Button>
                </>
            }
        >
            <Stack gap="sm">
                <TextInput
                    label="Name"
                    placeholder="Local MySQL"
                    value={form.name}
                    onChange={(e) => set('name', e.target.value)}
                />
                <Select
                    label="Database"
                    data={engines.map((e) => ({ value: e.id, label: e.displayName }))}
                    value={form.engine}
                    onChange={(value) => {
                        if (!value) return;
                        const engine = engines.find((e) => e.id === value);
                        setForm((current) => ({
                            ...current,
                            engine: value,
                            port: engine?.defaultPort ?? current.port,
                        }));
                        setTest(null);
                    }}
                />
                <div className="flex gap-2">
                    <TextInput
                        className="min-w-0 flex-1"
                        label="Host"
                        value={form.host}
                        onChange={(e) => set('host', e.target.value)}
                    />
                    <NumberInput
                        label="Port"
                        w={100}
                        min={1}
                        max={65535}
                        value={form.port}
                        onChange={(value) => set('port', value)}
                    />
                </div>
                <div className="flex gap-2">
                    <TextInput
                        className="min-w-0 flex-1"
                        label="User"
                        description={
                            form.engine === 'redis' ? 'Empty for the default user' : undefined
                        }
                        autoComplete="off"
                        value={form.username}
                        onChange={(e) => set('username', e.target.value)}
                    />
                    <PasswordInput
                        className="min-w-0 flex-1"
                        label="Password"
                        autoComplete="new-password"
                        placeholder={hasPassword ? 'Saved; type to replace' : ''}
                        value={form.password}
                        onChange={(e) => set('password', e.target.value)}
                    />
                </div>
                <Text size="xs" className="-mt-2 text-dimmed">
                    The password is kept in your operating system's credential store, never in the
                    connection list.
                </Text>
                <TextInput
                    label={form.engine === 'redis' ? 'Database index' : 'Default database'}
                    description={DATABASE_HINTS[form.engine] ?? 'Optional'}
                    value={form.database}
                    onChange={(e) => set('database', e.target.value)}
                />
                {form.engine === 'mongodb' && (
                    <div className="flex gap-2">
                        <TextInput
                            className="min-w-0 flex-1"
                            label="Auth source"
                            description="Where the user is defined; admin when empty"
                            value={form.authSource}
                            onChange={(e) => set('authSource', e.target.value)}
                        />
                        <Select
                            className="min-w-0 flex-1"
                            label="Login method"
                            data={AUTH_MECHANISMS}
                            value={form.authMechanism}
                            onChange={(value) => set('authMechanism', value ?? '')}
                        />
                    </div>
                )}
                <Select
                    label="Encryption"
                    description={
                        form.engine === 'redis' || form.engine === 'mongodb'
                            ? 'This server only encrypts when a TLS option other than the first is chosen'
                            : undefined
                    }
                    data={TLS_MODES}
                    value={form.tls}
                    onChange={(value) => value && set('tls', value as DbTlsMode)}
                />
                {(form.tls === 'verify-ca' || form.tls === 'verify-full') && (
                    <TextInput
                        label="CA certificate (PEM)"
                        description="Leave empty to use the system's trusted authorities"
                        value={form.ca}
                        onChange={(e) => set('ca', e.target.value)}
                    />
                )}
                <NumberInput
                    label="Statement timeout"
                    description="Seconds before a running statement is cancelled; 0 for none"
                    min={0}
                    max={86_400}
                    value={form.queryTimeoutSeconds}
                    onChange={(value) => set('queryTimeoutSeconds', value)}
                />
                {test?.ok && (
                    <Alert color="teal">
                        Connected to {test.result.server?.product} {test.result.server?.version} in{' '}
                        {test.result.elapsedMs} ms
                        {test.result.server?.secure ? ' over TLS' : ' without TLS'}.
                    </Alert>
                )}
                {test && !test.ok && <Alert color="red">{test.message}</Alert>}
            </Stack>
        </AppModal>
    );
}
