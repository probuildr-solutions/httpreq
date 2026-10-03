/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    explainConnectionFailure,
    type ConnectionFailure,
    type DbTestResult,
    type DbTlsMode,
} from '@httpreq/shared';
import { AppModal } from '../../AppModal';
import {
    Alert,
    Button,
    NumberInput,
    PasswordInput,
    Select,
    Stack,
    Switch,
    Text,
    TextInput,
    Textarea,
    UnstyledButton,
} from '../../kit';
import {
    applyString,
    blankForm,
    extraParametersText,
    formFromProfile,
    isSupportedStringEngine,
    settingsOf,
    stringOf,
    withExtraParameters,
    type ConnectionForm,
} from './connectionForm';
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

const READ_PREFERENCES = [
    { value: '', label: 'Primary (default)' },
    { value: 'primaryPreferred', label: 'Primary preferred' },
    { value: 'secondary', label: 'Secondary' },
    { value: 'secondaryPreferred', label: 'Secondary preferred' },
    { value: 'nearest', label: 'Nearest' },
];

const FLAG = [
    { value: '', label: 'Default' },
    { value: 'true', label: 'On' },
    { value: 'false', label: 'Off' },
];

/** Creates or edits a saved connection, and tests it before saving if asked. */
export function ConnectionDialog() {
    const manager = useDbManager();
    const target = useConnectionDialog((state) => state.target);
    const close = useConnectionDialog((state) => state.close);
    const profiles = useProfiles((state) => state.profiles);
    const engines = manager.engines.length > 0 ? manager.engines : DEFAULT_ENGINES;

    const existing = target && target !== 'new' ? profiles.find((p) => p.id === target) : undefined;
    const [form, setForm] = useState<ConnectionForm>(blankForm('mysql', 3306));
    const [hasPassword, setHasPassword] = useState(false);
    const [testing, setTesting] = useState(false);
    const [test, setTest] = useState<
        { ok: true; result: DbTestResult } | { ok: false; failure: ConnectionFailure } | null
    >(null);
    const [saving, setSaving] = useState(false);
    /** The string as the user is typing it; shown instead of the generated one while editing. */
    const [draft, setDraft] = useState<string | null>(null);
    const [stringError, setStringError] = useState<string | null>(null);
    const [advanced, setAdvanced] = useState(false);
    const [extra, setExtra] = useState('');
    const extraFocused = useRef(false);

    useEffect(() => {
        if (!target) return;
        setTest(null);
        setSaving(false);
        setDraft(null);
        setStringError(null);
        const initial = existing
            ? formFromProfile(existing)
            : blankForm(engines[0]!.id, engines[0]!.defaultPort);
        setForm(initial);
        setExtra(extraParametersText(initial));
        setAdvanced(false);
        setHasPassword(false);
        if (existing) void manager.db?.hasPassword(existing.id).then(setHasPassword);
        // Reset only when the dialog opens for a target.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    const update = (changes: Partial<ConnectionForm>) => {
        setForm((current) => {
            const next = { ...current, ...changes };
            if (!extraFocused.current) setExtra(extraParametersText(next));
            return next;
        });
        setDraft(null);
        setStringError(null);
        setTest(null);
    };
    const setOption = (key: string, value: string) =>
        update({ options: { ...form.options, [key]: value } });

    const generated = useMemo(() => stringOf(form), [form]);
    const supportsString = isSupportedStringEngine(form.engine);
    const srv = form.engine === 'mongodb' && form.options.srv === 'true';

    /** Reads a connection string into the form. Returns whether it was accepted. */
    const apply = (text: string): boolean => {
        const result = applyString(form, text);
        if (!result.ok) {
            setStringError(result.error.message);
            return false;
        }
        setStringError(null);
        setForm(result.form);
        setExtra(extraParametersText(result.form));
        setTest(null);
        return true;
    };

    const port = Number(form.port);
    const valid =
        form.host.trim() !== '' &&
        (srv || (Number.isInteger(port) && port > 0 && port < 65536)) &&
        stringError === null;

    const runTest = async () => {
        setTesting(true);
        setTest(null);
        try {
            const result = await manager.testConnection(
                settingsOf({ ...form, port: srv ? 27017 : form.port }),
                existing?.id ?? newProfileId(),
                form.password !== '' ? form.password : undefined,
            );
            setTest({ ok: true, result });
        } catch (error) {
            setTest({ ok: false, failure: explainConnectionFailure(error) });
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        setSaving(true);
        const profile: ConnectionProfile = {
            id: existing?.id ?? newProfileId(),
            name: form.name.trim() || `${form.host.trim()}${srv ? '' : `:${port}`}`,
            settings: settingsOf({ ...form, port: srv ? 27017 : form.port }),
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
                    onChange={(e) => update({ name: e.target.value })}
                />
                <Select
                    label="Database"
                    data={engines.map((e) => ({ value: e.id, label: e.displayName }))}
                    value={form.engine}
                    onChange={(value) => {
                        if (!value) return;
                        const engine = engines.find((e) => e.id === value);
                        update({
                            engine: value,
                            port: engine?.defaultPort ?? form.port,
                            options: {},
                        });
                        setExtra('');
                    }}
                />
                {supportsString && (
                    <TextInput
                        label="Connection string"
                        description="Paste a URL to fill in the fields below, or edit the fields to update it. The password is hidden."
                        placeholder={
                            form.engine === 'mongodb'
                                ? 'mongodb+srv://user:password@cluster.example.net/database'
                                : form.engine === 'postgresql'
                                  ? 'postgresql://user:password@host:5432/database'
                                  : form.engine === 'redis'
                                    ? 'redis://user:password@host:6379/0'
                                    : 'mysql://user:password@host:3306/database'
                        }
                        autoComplete="off"
                        spellCheck={false}
                        error={stringError ?? undefined}
                        value={draft ?? generated}
                        onPaste={(event) => {
                            const text = event.clipboardData.getData('text');
                            if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim())) return;
                            // A pasted string is applied at once and shown masked, so a password in
                            // it is never displayed.
                            event.preventDefault();
                            if (apply(text.trim())) setDraft(null);
                            else
                                setDraft(
                                    text.trim().replace(/(:\/\/[^:/?#@\s]*:)[^@\s]*@/, '$1****@'),
                                );
                        }}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            apply(event.target.value);
                        }}
                        onBlur={() => {
                            if (stringError === null) setDraft(null);
                        }}
                    />
                )}
                <div className="flex gap-2">
                    <TextInput
                        className="min-w-0 flex-1"
                        label={srv ? 'Cluster' : 'Host'}
                        description={
                            srv ? 'Resolved through DNS SRV records when you connect' : undefined
                        }
                        value={form.host}
                        onChange={(e) => update({ host: e.target.value })}
                    />
                    {!srv && (
                        <NumberInput
                            label="Port"
                            w={100}
                            min={1}
                            max={65535}
                            value={form.port}
                            onChange={(value) => update({ port: value })}
                        />
                    )}
                </div>
                {form.engine === 'mongodb' && (
                    <>
                        <Switch
                            label="Use a DNS seed list (mongodb+srv), as for MongoDB Atlas"
                            checked={srv}
                            onChange={(event) =>
                                setOption('srv', event.currentTarget.checked ? 'true' : '')
                            }
                        />
                        {!srv && (
                            <TextInput
                                label="Additional hosts"
                                description="Other replica set members, as host:port separated by commas"
                                placeholder="b.example.com:27017,c.example.com:27017"
                                value={form.options.seeds ?? ''}
                                onChange={(e) => setOption('seeds', e.target.value)}
                            />
                        )}
                    </>
                )}
                <div className="flex gap-2">
                    <TextInput
                        className="min-w-0 flex-1"
                        label="User"
                        description={
                            form.engine === 'redis' ? 'Empty for the default user' : undefined
                        }
                        autoComplete="off"
                        value={form.username}
                        onChange={(e) => update({ username: e.target.value })}
                    />
                    <PasswordInput
                        className="min-w-0 flex-1"
                        label="Password"
                        autoComplete="new-password"
                        placeholder={hasPassword ? 'Saved; type to replace' : ''}
                        value={form.password}
                        onChange={(e) => update({ password: e.target.value })}
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
                    onChange={(e) => update({ database: e.target.value })}
                />
                {form.engine === 'postgresql' && (
                    <TextInput
                        label="Schema search path"
                        description="Schemas searched for unqualified names, for example sales,public"
                        value={form.options.searchPath ?? ''}
                        onChange={(e) => setOption('searchPath', e.target.value)}
                    />
                )}
                {form.engine === 'mongodb' && (
                    <div className="flex gap-2">
                        <TextInput
                            className="min-w-0 flex-1"
                            label="Auth source"
                            description="Where the user is defined; admin when empty"
                            value={form.options.authSource ?? ''}
                            onChange={(e) => setOption('authSource', e.target.value)}
                        />
                        <Select
                            className="min-w-0 flex-1"
                            label="Login method"
                            data={AUTH_MECHANISMS}
                            value={form.options.authMechanism ?? ''}
                            onChange={(value) => setOption('authMechanism', value ?? '')}
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
                    onChange={(value) => value && update({ tls: value as DbTlsMode })}
                />
                {(form.tls === 'verify-ca' || form.tls === 'verify-full') && (
                    <TextInput
                        label="CA certificate (PEM)"
                        description="Leave empty to use the system's trusted authorities"
                        value={form.ca}
                        onChange={(e) => update({ ca: e.target.value })}
                    />
                )}

                <UnstyledButton
                    className="flex items-center gap-1 text-left text-sm font-medium"
                    aria-expanded={advanced}
                    onClick={() => setAdvanced((value) => !value)}
                >
                    {advanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    Advanced
                </UnstyledButton>
                {advanced && (
                    <Stack gap="sm">
                        <div className="flex gap-2">
                            <NumberInput
                                className="min-w-0 flex-1"
                                label="Connection timeout"
                                description="Seconds to wait for the server"
                                min={1}
                                max={120}
                                value={form.connectTimeoutSeconds}
                                onChange={(value) => update({ connectTimeoutSeconds: value })}
                            />
                            <NumberInput
                                className="min-w-0 flex-1"
                                label="Statement timeout"
                                description="Seconds before a statement is cancelled; 0 for none"
                                min={0}
                                max={86_400}
                                value={form.queryTimeoutSeconds}
                                onChange={(value) => update({ queryTimeoutSeconds: value })}
                            />
                        </div>
                        {form.engine === 'mongodb' && (
                            <>
                                <div className="flex gap-2">
                                    <TextInput
                                        className="min-w-0 flex-1"
                                        label="Replica set"
                                        value={form.options.replicaSet ?? ''}
                                        onChange={(e) => setOption('replicaSet', e.target.value)}
                                    />
                                    <Select
                                        className="min-w-0 flex-1"
                                        label="Read preference"
                                        data={READ_PREFERENCES}
                                        value={form.options.readPreference ?? ''}
                                        onChange={(value) =>
                                            setOption('readPreference', value ?? '')
                                        }
                                    />
                                </div>
                                <div className="flex gap-2">
                                    <TextInput
                                        className="min-w-0 flex-1"
                                        label="Write concern (w)"
                                        placeholder="majority or a number"
                                        value={form.options.w ?? ''}
                                        onChange={(e) => setOption('w', e.target.value)}
                                    />
                                    <Select
                                        className="min-w-0 flex-1"
                                        label="Retry writes"
                                        data={FLAG}
                                        value={form.options.retryWrites ?? ''}
                                        onChange={(value) => setOption('retryWrites', value ?? '')}
                                    />
                                    <Select
                                        className="min-w-0 flex-1"
                                        label="Retry reads"
                                        data={FLAG}
                                        value={form.options.retryReads ?? ''}
                                        onChange={(value) => setOption('retryReads', value ?? '')}
                                    />
                                </div>
                            </>
                        )}
                        {form.engine === 'postgresql' && (
                            <TextInput
                                label="Application name"
                                value={form.options.application_name ?? ''}
                                onChange={(e) => setOption('application_name', e.target.value)}
                            />
                        )}
                        <Textarea
                            label="Additional parameters"
                            description="One key=value per line; kept in the connection string"
                            minRows={2}
                            value={extra}
                            onFocus={() => {
                                extraFocused.current = true;
                            }}
                            onChange={(event) => setExtra(event.target.value)}
                            onBlur={() => {
                                extraFocused.current = false;
                                update(withExtraParameters(form, extra));
                            }}
                        />
                    </Stack>
                )}

                {test?.ok && (
                    <Alert color="teal">
                        Connected to {test.result.server?.product} {test.result.server?.version} in{' '}
                        {test.result.elapsedMs} ms
                        {test.result.server?.secure ? ' over TLS' : ' without TLS'}.
                    </Alert>
                )}
                {test && !test.ok && (
                    <Alert color="red" title={test.failure.title}>
                        <Text size="sm">{test.failure.hint}</Text>
                        {test.failure.detail && (
                            <Text size="xs" className="mt-1 break-words opacity-70">
                                {test.failure.detail}
                            </Text>
                        )}
                    </Alert>
                )}
            </Stack>
        </AppModal>
    );
}
