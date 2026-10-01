/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconAlertTriangle, IconFolderOpen, IconPlugConnected } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
    hasErrors,
    validateSshProfile,
    type SshAuthType,
    type SshErrorInfo,
    type SshProfile,
} from '@httpreq/shared';
import { AppModal } from '../AppModal';
import { Field } from '../auth/Field';
import type { EditTarget } from '../editTarget';
import { useWorkbenchStore } from '../store';
import { yieldToHostKeyPrompt } from './hostKeyPrompt';
import { useSsh } from './useSsh';
import {
    Alert,
    Button,
    Group,
    Input,
    NumberInput,
    PasswordInput,
    Select,
    Stack,
    Text,
    Textarea,
    TextInput,
} from '../kit';

const AUTH_OPTIONS: { value: SshAuthType; label: string }[] = [
    { value: 'password', label: 'Password' },
    { value: 'key', label: 'Private key' },
    { value: 'key-passphrase', label: 'Private key + passphrase' },
];

const secretLabel = (authType: SshAuthType) =>
    authType === 'password' ? 'Password' : 'Key passphrase';

interface Props {
    target: EditTarget<SshProfile> | null;
    onClose: () => void;
}

/**
 * Create or edit an SSH connection profile.
 *
 * A new profile lives only in this dialog until it is saved; closing it any other way discards it.
 *
 * The secret field is write-only: an existing password or passphrase lives in the OS vault and is
 * never read back, so the field starts empty and shows whether one is already stored. Leaving it
 * empty keeps what is stored; typing replaces it; the "Remove" action clears it.
 */
export function SshProfileDialog({ target, onClose }: Props) {
    const ssh = useSsh();
    const saved = useWorkbenchStore((state) =>
        target?.kind === 'edit'
            ? state.workspace.sshProfiles.find((profile) => profile.id === target.id)
            : undefined,
    );
    const create = useWorkbenchStore((state) => state.createSshProfile);
    const update = useWorkbenchStore((state) => state.updateSshProfile);
    const isNew = target?.kind === 'new';
    const initial = target?.kind === 'new' ? target.value : saved;

    const [draft, setDraft] = useState<SshProfile | null>(null);
    const [secret, setSecret] = useState('');
    const [hasStoredSecret, setHasStoredSecret] = useState(false);
    const [showErrors, setShowErrors] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testError, setTestError] = useState<SshErrorInfo | null>(null);
    /** Set when testing a new, unsaved profile put its secret in the vault. */
    const unsavedSecret = useRef(false);
    const keyInputId = useId();

    useEffect(() => {
        setDraft(initial ? { ...initial } : null);
        setSecret('');
        setShowErrors(false);
        setTestError(null);
        unsavedSecret.current = false;
        if (initial && !isNew)
            void ssh.hasCredential(initial.credentialId).then(setHasStoredSecret);
        else setHasStoredSecret(false);
    }, [initial, isNew, ssh]);

    if (!draft) return null;

    const errors = validateSshProfile(draft);
    const field = (name: string) => (showErrors ? errors[name] : undefined);
    const patch = (changes: Partial<SshProfile>) => setDraft({ ...draft, ...changes });
    const cleaned = (): SshProfile => ({
        ...draft,
        name: draft.name.trim(),
        host: draft.host.trim(),
        username: draft.username.trim(),
    });

    /** Stores the secret, when one was typed, in the OS vault. Returns whether it succeeded. */
    const storeSecret = async (): Promise<boolean> => {
        if (!secret) return true;
        const stored = await ssh.setCredential(draft.credentialId, secret);
        if (!stored) {
            setTestError({
                code: 'SSH_UNKNOWN',
                message:
                    'The credential could not be stored securely. This system has no available keychain, and HttpReq will not fall back to storing it in plain text.',
            });
            return false;
        }
        if (isNew) unsavedSecret.current = true;
        setSecret('');
        setHasStoredSecret(true);
        return true;
    };

    /** Validates the form and stores the secret. Returns whether both succeeded. */
    const prepare = async (): Promise<boolean> => {
        if (hasErrors(errors)) {
            setShowErrors(true);
            return false;
        }
        return storeSecret();
    };

    const onSave = async () => {
        if (!(await prepare())) return;
        const profile = cleaned();
        // The store keeps the vault key and id fixed, so a saved profile can take the whole draft.
        if (isNew) create(profile);
        else update(profile.id, profile);
        unsavedSecret.current = false;
        onClose();
    };

    /** Closes without saving; a new profile leaves nothing behind, not even a tested secret. */
    const onDiscard = () => {
        if (unsavedSecret.current) void ssh.deleteCredential(draft.credentialId);
        unsavedSecret.current = false;
        onClose();
    };

    const onTest = async () => {
        setTestError(null);
        if (!(await prepare())) return;
        setTesting(true);
        // Tested against the stored credential. A saved profile keeps its edits once they are tested;
        // a new one is tested as it stands and stays unsaved until "Save".
        const profile = cleaned();
        if (!isNew) update(profile.id, profile);
        setTestError(await ssh.test(profile));
        setTesting(false);
    };

    const onRemoveSecret = async () => {
        await ssh.deleteCredential(draft.credentialId);
        unsavedSecret.current = false;
        setHasStoredSecret(false);
        setSecret('');
    };

    const needsKey = draft.authType !== 'password';

    return (
        <AppModal
            opened
            onClose={onDiscard}
            title={isNew ? 'New SSH connection' : 'SSH connection'}
            size="lg"
            centered
            // "Test connection" can raise the host-key question, which has to be answered first.
            {...yieldToHostKeyPrompt(!!ssh.pendingHostKey)}
            footerStart={
                <Button
                    variant="default"
                    leftSection={<IconPlugConnected size={15} />}
                    loading={testing}
                    disabled={!ssh.available}
                    onClick={() => void onTest()}
                >
                    Test connection
                </Button>
            }
            footer={
                <>
                    <Button variant="default" onClick={onDiscard}>
                        Cancel
                    </Button>
                    <Button onClick={() => void onSave()}>Save</Button>
                </>
            }
        >
            <Stack gap="sm" className="hr-form">
                <TextInput
                    label="Profile name"
                    placeholder="Production bastion"
                    required
                    value={draft.name}
                    error={field('name')}
                    onChange={(event) => patch({ name: event.currentTarget.value })}
                />

                <Group grow align="flex-start" wrap="nowrap">
                    <Field
                        label="Host"
                        value={draft.host}
                        onChange={(host) => patch({ host })}
                        completion
                        mono
                        placeholder="server.example.com or {{SSH_HOST}}"
                        error={field('host')}
                    />
                    <NumberInput
                        label="Port"
                        min={1}
                        max={65535}
                        value={draft.port}
                        error={field('port')}
                        onChange={(value) =>
                            patch({ port: typeof value === 'number' ? value : 22 })
                        }
                    />
                </Group>

                <Field
                    label="Username"
                    value={draft.username}
                    onChange={(username) => patch({ username })}
                    completion
                    mono
                    placeholder="ubuntu or {{SSH_USERNAME}}"
                    error={field('username')}
                />

                <Select
                    label="Authentication"
                    data={AUTH_OPTIONS}
                    value={draft.authType}
                    onChange={(value) => patch({ authType: (value as SshAuthType) ?? 'password' })}
                />

                {needsKey && (
                    <Input.Wrapper
                        label="Private key"
                        description="The key stays where it is; HttpReq stores only its path."
                        error={field('privateKeyPath')}
                        labelProps={{ htmlFor: keyInputId }}
                    >
                        {/* Bottom-aligned: the input carries a top margin below the description. */}
                        <Group gap="xs" wrap="nowrap" align="flex-end">
                            <TextInput
                                id={keyInputId}
                                className="flex-1"
                                placeholder="/home/you/.ssh/id_ed25519"
                                readOnly={ssh.available}
                                value={draft.privateKeyPath}
                                error={!!field('privateKeyPath')}
                                onChange={(event) =>
                                    patch({ privateKeyPath: event.currentTarget.value })
                                }
                            />
                            <Button
                                variant="default"
                                leftSection={<IconFolderOpen size={15} />}
                                onClick={() =>
                                    void ssh.pickPrivateKey().then((path) => {
                                        if (path) patch({ privateKeyPath: path });
                                    })
                                }
                            >
                                Choose…
                            </Button>
                        </Group>
                    </Input.Wrapper>
                )}

                {draft.authType !== 'key' && (
                    <Stack gap={4}>
                        <PasswordInput
                            label={secretLabel(draft.authType)}
                            description={
                                hasStoredSecret
                                    ? 'A value is stored in this system’s credential vault. Leave empty to keep it.'
                                    : 'Stored in this system’s credential vault, never in workspace data.'
                            }
                            placeholder={
                                hasStoredSecret
                                    ? '••••••••'
                                    : `Enter the ${secretLabel(draft.authType).toLowerCase()}`
                            }
                            value={secret}
                            onChange={(event) => setSecret(event.currentTarget.value)}
                        />
                        {hasStoredSecret && (
                            <Group justify="flex-start">
                                <Button
                                    variant="subtle"
                                    color="red"
                                    size="compact-xs"
                                    onClick={() => void onRemoveSecret()}
                                >
                                    Remove the stored {secretLabel(draft.authType).toLowerCase()}
                                </Button>
                            </Group>
                        )}
                    </Stack>
                )}

                <Group grow align="flex-start" wrap="nowrap">
                    <NumberInput
                        label="Connect timeout (ms)"
                        min={0}
                        step={1000}
                        value={draft.connectTimeoutMs}
                        error={field('connectTimeoutMs')}
                        onChange={(value) =>
                            patch({ connectTimeoutMs: typeof value === 'number' ? value : 20_000 })
                        }
                    />
                    <NumberInput
                        label="Keep-alive (seconds)"
                        description="0 disables keep-alive probes."
                        // Below the input, so both inputs of the row start at the same height.
                        descriptionBelow
                        min={0}
                        value={draft.keepAliveSeconds}
                        onChange={(value) =>
                            patch({ keepAliveSeconds: typeof value === 'number' ? value : 0 })
                        }
                    />
                </Group>

                <Textarea
                    label="Notes"
                    autosize
                    minRows={2}
                    value={draft.description}
                    onChange={(event) => patch({ description: event.currentTarget.value })}
                />

                {testError && (
                    <Alert
                        color="red"
                        variant="light"
                        icon={<IconAlertTriangle size={16} />}
                        title={testError.message}
                    >
                        {testError.detail && (
                            <Text
                                size="xs"
                                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                            >
                                {testError.detail}
                            </Text>
                        )}
                    </Alert>
                )}
            </Stack>
        </AppModal>
    );
}
