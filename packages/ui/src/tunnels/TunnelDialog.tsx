/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconAlertTriangle, IconArrowRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
    hasErrors,
    IMPLEMENTED_TUNNEL_TYPES,
    isLoopbackAddress,
    LOOPBACK_BIND_ADDRESS,
    TUNNEL_TYPES,
    validateTunnelProfile,
    type TunnelProfile,
    type TunnelType,
} from '@httpreq/shared';
import { AppModal } from '../AppModal';
import { Field } from '../auth/Field';
import type { EditTarget } from '../editTarget';
import { yieldToHostKeyPrompt } from '../ssh/hostKeyPrompt';
import { useSsh } from '../ssh/useSsh';
import { useWorkbenchStore } from '../store';
import { useTunnels } from './useTunnels';
import {
    Alert,
    Button,
    Group,
    NumberInput,
    Select,
    Stack,
    Switch,
    Text,
    Textarea,
    TextInput,
} from '../kit';

const TYPE_LABEL: Record<TunnelType, string> = {
    local: 'Local forwarding (-L)',
    remote: 'Remote forwarding (-R)',
    dynamic: 'Dynamic SOCKS proxy (-D)',
};

interface Props {
    target: EditTarget<TunnelProfile> | null;
    onClose: () => void;
}

/**
 * Create or edit a tunnel profile. A new tunnel lives only in this dialog until it is saved;
 * closing it any other way discards it.
 *
 * The bind address defaults to loopback and warns as soon as it is changed: binding to another
 * interface puts the forwarded service on the network, which is rarely what someone means to do.
 */
export function TunnelDialog({ target, onClose }: Props) {
    const saved = useWorkbenchStore((state) =>
        target?.kind === 'edit'
            ? state.workspace.tunnelProfiles.find((tunnel) => tunnel.id === target.id)
            : undefined,
    );
    const initial = target?.kind === 'new' ? target.value : saved;
    const isNew = target?.kind === 'new';
    const sshProfiles = useWorkbenchStore((state) => state.workspace.sshProfiles);
    const create = useWorkbenchStore((state) => state.createTunnelProfile);
    const update = useWorkbenchStore((state) => state.updateTunnelProfile);
    const tunnels = useTunnels();
    const ssh = useSsh();

    const [draft, setDraft] = useState<TunnelProfile | null>(null);
    const [showErrors, setShowErrors] = useState(false);
    const [portTaken, setPortTaken] = useState(false);

    useEffect(() => {
        setDraft(initial ? { ...initial } : null);
        setShowErrors(false);
        setPortTaken(false);
    }, [initial]);

    // Checked as the user types, so a conflict is visible before they try to start the tunnel.
    useEffect(() => {
        if (!draft || !tunnels.available || !draft.localPort) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            void tunnels
                .isPortAvailable(draft.localBindAddress, draft.localPort)
                .then((free) => {
                    // A running tunnel holds its own port; that is not a conflict to warn about.
                    if (!cancelled) setPortTaken(!free && saved?.localPort !== draft.localPort);
                })
                .catch(() => undefined);
        }, 400);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [draft, saved?.localPort, tunnels]);

    if (!draft) return null;

    const errors = validateTunnelProfile(draft);
    const field = (name: string) => (showErrors ? errors[name] : undefined);
    const patch = (changes: Partial<TunnelProfile>) => setDraft({ ...draft, ...changes });
    const exposed = !isLoopbackAddress(draft.localBindAddress);
    const unsupported = !IMPLEMENTED_TUNNEL_TYPES.includes(draft.type);

    const onSave = () => {
        if (hasErrors(errors)) {
            setShowErrors(true);
            return;
        }
        const tunnel: TunnelProfile = {
            ...draft,
            name: draft.name.trim(),
            localBindAddress: draft.localBindAddress.trim(),
            remoteHost: draft.remoteHost.trim(),
        };
        if (isNew) create(tunnel);
        else update(tunnel.id, tunnel);
        onClose();
    };

    return (
        <AppModal
            opened
            onClose={onClose}
            title={isNew ? 'New SSH tunnel' : 'SSH tunnel'}
            size="lg"
            centered
            // Starting a tunnel can raise the host-key question, which has to be answered first.
            {...yieldToHostKeyPrompt(!!ssh.pendingHostKey)}
            footer={
                <>
                    <Button variant="default" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={onSave}>Save</Button>
                </>
            }
        >
            <Stack gap="sm" className="hr-form">
                <TextInput
                    label="Tunnel name"
                    placeholder="Production MySQL"
                    required
                    value={draft.name}
                    error={field('name')}
                    onChange={(event) => patch({ name: event.currentTarget.value })}
                />

                <Select
                    label="SSH profile"
                    placeholder={
                        sshProfiles.length
                            ? 'Choose a connection'
                            : 'Create an SSH connection first'
                    }
                    data={sshProfiles.map((profile) => ({
                        value: profile.id,
                        label: profile.name,
                    }))}
                    value={draft.sshProfileId || null}
                    error={field('sshProfileId')}
                    disabled={sshProfiles.length === 0}
                    onChange={(value) => patch({ sshProfileId: value ?? '' })}
                />

                <Select
                    label="Forwarding mode"
                    data={TUNNEL_TYPES.map((type) => ({
                        value: type,
                        label: IMPLEMENTED_TUNNEL_TYPES.includes(type)
                            ? TYPE_LABEL[type]
                            : `${TYPE_LABEL[type]} — not supported yet`,
                        disabled: !IMPLEMENTED_TUNNEL_TYPES.includes(type),
                    }))}
                    value={draft.type}
                    onChange={(value) => patch({ type: (value as TunnelType) ?? 'local' })}
                />

                {unsupported && (
                    <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                        Only local forwarding is implemented so far. A tunnel saved with another
                        mode will refuse to start.
                    </Alert>
                )}

                <Group grow align="flex-start" wrap="nowrap">
                    <TextInput
                        label="Local bind address"
                        description="127.0.0.1 keeps the tunnel on this machine."
                        // Below the input, so both inputs of the row start at the same height.
                        descriptionBelow
                        value={draft.localBindAddress}
                        error={field('localBindAddress')}
                        onChange={(event) => patch({ localBindAddress: event.currentTarget.value })}
                        rightSection={
                            exposed ? (
                                <Button
                                    variant="subtle"
                                    size="compact-xs"
                                    onClick={() =>
                                        patch({ localBindAddress: LOOPBACK_BIND_ADDRESS })
                                    }
                                >
                                    Reset
                                </Button>
                            ) : undefined
                        }
                    />
                    <NumberInput
                        label="Local port"
                        min={1}
                        max={65535}
                        value={draft.localPort || ''}
                        error={field('localPort')}
                        onChange={(value) =>
                            patch({ localPort: typeof value === 'number' ? value : 0 })
                        }
                    />
                </Group>

                {exposed && (
                    <Alert
                        color="red"
                        variant="light"
                        icon={<IconAlertTriangle size={16} />}
                        title="This tunnel will be reachable from the network"
                    >
                        Binding to {draft.localBindAddress} lets other machines reach the forwarded
                        service through this computer, with no authentication of their own. Use
                        127.0.0.1 unless you intend to share it.
                    </Alert>
                )}

                {portTaken && (
                    <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                        Local port {draft.localPort} is already in use. Starting the tunnel will
                        fail until you choose another port or free this one.
                    </Alert>
                )}

                {draft.type !== 'dynamic' && (
                    <Group grow align="flex-start" wrap="nowrap">
                        <Field
                            label="Remote host"
                            value={draft.remoteHost}
                            onChange={(remoteHost) => patch({ remoteHost })}
                            completion
                            mono
                            placeholder="mysql.internal"
                            error={field('remoteHost')}
                        />
                        <NumberInput
                            label="Remote port"
                            min={1}
                            max={65535}
                            value={draft.remotePort || ''}
                            error={field('remotePort')}
                            onChange={(value) =>
                                patch({ remotePort: typeof value === 'number' ? value : 0 })
                            }
                        />
                    </Group>
                )}

                <Text size="xs" className="text-dimmed">
                    <span className="font-mono">
                        {draft.localBindAddress}:{draft.localPort || '?'}
                    </span>{' '}
                    <IconArrowRight size={11} style={{ verticalAlign: 'middle' }} /> SSH{' '}
                    <IconArrowRight size={11} style={{ verticalAlign: 'middle' }} />{' '}
                    <span className="font-mono">
                        {draft.remoteHost || '?'}:{draft.remotePort || '?'}
                    </span>
                </Text>

                <Switch
                    label="Start with the workspace"
                    description="Starts this tunnel as soon as the workspace is opened."
                    checked={draft.autoStart}
                    onChange={(event) => patch({ autoStart: event.currentTarget.checked })}
                />

                <Textarea
                    label="Notes"
                    autosize
                    minRows={2}
                    value={draft.description}
                    onChange={(event) => patch({ description: event.currentTarget.value })}
                />
            </Stack>
        </AppModal>
    );
}
