/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconCopy,
    IconDots,
    IconPencil,
    IconPlayerPlay,
    IconPlayerStop,
    IconPlus,
    IconServer,
    IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { createSshProfile as newSshProfile, type SshProfile } from '@httpreq/shared';
import { confirmAction } from '../confirm';
import { editExisting, editNew, type EditTarget } from '../editTarget';
import { useConnectionsStore } from '../connections';
import { tunnelsUsingSshProfile, useWorkbenchStore } from '../store';
import { isSshBusy, sshProfileConnection, type SshConnectionPhase } from './connectionState';
import { SshProfileDialog } from './SshProfileDialog';
import { useSsh } from './useSsh';
import {
    EMPTY,
    ITEM,
    ITEM_ACTIONS,
    ITEM_DETAIL,
    ITEM_NAME,
    ITEM_TEXT,
    LIST,
    PANEL,
} from './styles';
import { PanelHeader } from '../explorer/PanelHeader';
import {
    BulkDeleteButton,
    RowCheckbox,
    SelectionBar,
    SelectModeButton,
} from '../explorer/Selection';
import { useSelection } from '../explorer/useSelection';
import { ActionIcon, Button, Menu, Text, Tooltip } from '../kit';

const CONTROLS: Record<
    SshConnectionPhase,
    { label: string; preposition: string; color: 'teal' | 'red'; busy: boolean }
> = {
    disconnected: { label: 'Connect', preposition: 'to', color: 'teal', busy: false },
    connecting: { label: 'Connecting', preposition: 'to', color: 'teal', busy: true },
    connected: { label: 'Disconnect', preposition: 'from', color: 'red', busy: false },
    disconnecting: { label: 'Disconnecting', preposition: 'from', color: 'red', busy: true },
};

/** The SSH sidebar view: the workspace's connection profiles and their live sessions. */
export function SshPanel({ onOpened }: { onOpened?: () => void }) {
    const profiles = useWorkbenchStore((state) => state.workspace.sshProfiles);
    const duplicateProfile = useWorkbenchStore((state) => state.duplicateSshProfile);
    const deleteProfile = useWorkbenchStore((state) => state.deleteSshProfile);
    const sessions = useConnectionsStore((state) => state.sessions);
    const ssh = useSsh();
    const [editing, setEditing] = useState<EditTarget<SshProfile> | null>(null);
    const selection = useSelection(
        useMemo(() => profiles.map((profile) => profile.id), [profiles]),
    );

    const liveCount = (profileId: string) =>
        Object.values(sessions).filter(
            (session) => session?.profileId === profileId && session.status === 'connected',
        ).length;

    const connect = (profile: SshProfile) => {
        // A connection or disconnection in flight owns the profile until its lifecycle ends.
        if (isSshBusy(sshProfileConnection(sessions, profile.id).phase)) return;
        void ssh.open(profile);
        onOpened?.();
    };

    const disconnect = (profile: SshProfile) => {
        const { phase, activeSessionIds } = sshProfileConnection(sessions, profile.id);
        if (isSshBusy(phase)) return;
        for (const sessionId of activeSessionIds) void ssh.disconnect(sessionId);
    };

    const remove = async (profile: SshProfile) => {
        const workspace = useWorkbenchStore.getState().workspace;
        const dependents = tunnelsUsingSshProfile(workspace, profile.id);
        const result = await confirmAction({
            title: 'Delete SSH profile',
            message: dependents.length
                ? `Delete “${profile.name}”? ${dependents.length === 1 ? 'The tunnel' : 'The tunnels'} ${dependents
                      .map((tunnel) => `“${tunnel.name}”`)
                      .join(
                          ', ',
                      )} ${dependents.length === 1 ? 'uses' : 'use'} it and will stop working until ${
                      dependents.length === 1 ? 'it is' : 'they are'
                  } pointed at another connection. Its stored credential is deleted too.`
                : `Delete “${profile.name}”? Its stored password or passphrase is deleted with it. This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result !== 'confirm') return;
        // The vault entry goes first: a profile removed without it would orphan the secret.
        await ssh.deleteCredential(profile.credentialId);
        deleteProfile(profile.id);
    };

    const removeSelected = async () => {
        const selected = profiles.filter((profile) => selection.isSelected(profile.id));
        if (selected.length === 0) return;
        const workspace = useWorkbenchStore.getState().workspace;
        const dependents = selected.flatMap((profile) =>
            tunnelsUsingSshProfile(workspace, profile.id),
        );
        const count = selected.length;
        const result = await confirmAction({
            title: count === 1 ? 'Delete SSH profile' : `Delete ${count} SSH profiles`,
            message:
                `Delete ${count === 1 ? `“${selected[0]!.name}”` : `${count} SSH profiles`}? ` +
                `${count === 1 ? 'Its stored credential is' : 'Their stored credentials are'} deleted too.` +
                (dependents.length
                    ? ` ${dependents.length} tunnel${dependents.length === 1 ? ' uses' : 's use'} ${count === 1 ? 'it' : 'them'} and will stop working until pointed at another connection.`
                    : ' This cannot be undone.'),
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result !== 'confirm') return;
        for (const profile of selected) {
            // The vault entry goes first: a profile removed without it would orphan the secret.
            await ssh.deleteCredential(profile.credentialId);
            deleteProfile(profile.id);
        }
        selection.stop();
    };

    return (
        <div className={PANEL}>
            <PanelHeader title="Connections">
                <SelectModeButton selection={selection} noun="connections" />
                <Tooltip label="New SSH connection">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label="New SSH connection"
                        onClick={() => setEditing(editNew(newSshProfile()))}
                    >
                        <IconPlus size={15} />
                    </ActionIcon>
                </Tooltip>
            </PanelHeader>
            <SelectionBar selection={selection} label="Connection selection">
                <BulkDeleteButton
                    selection={selection}
                    noun="connections"
                    onDelete={() => void removeSelected()}
                />
            </SelectionBar>

            <div className={LIST}>
                {profiles.length === 0 ? (
                    <div className={EMPTY}>
                        <Text size="sm" className="text-dimmed mb-2">
                            No SSH connections in this workspace.
                        </Text>
                        <Button
                            size="xs"
                            variant="light"
                            leftSection={<IconPlus size={14} />}
                            onClick={() => setEditing(editNew(newSshProfile()))}
                        >
                            New connection
                        </Button>
                    </div>
                ) : (
                    profiles.map((profile) => {
                        const live = liveCount(profile.id);
                        const { phase, error } = sshProfileConnection(sessions, profile.id);
                        const control = CONTROLS[phase];
                        const checked = selection.isSelected(profile.id);
                        return (
                            <div
                                key={profile.id}
                                className={ITEM}
                                data-checked={checked || undefined}
                                data-selectable={selection.selecting || undefined}
                            >
                                {selection.selecting && (
                                    <RowCheckbox
                                        checked={checked}
                                        label={profile.name}
                                        onChange={() => selection.toggle(profile.id)}
                                    />
                                )}
                                <IconServer size={15} aria-hidden />
                                <button
                                    type="button"
                                    className={ITEM_TEXT}
                                    onDoubleClick={() => !selection.selecting && connect(profile)}
                                    onClick={() =>
                                        selection.selecting
                                            ? selection.toggle(profile.id)
                                            : setEditing(editExisting(profile.id))
                                    }
                                    tabIndex={selection.selecting ? -1 : undefined}
                                    title={`${profile.username || 'user'}@${profile.host || 'host'}:${profile.port}`}
                                >
                                    <span className={ITEM_NAME}>
                                        {profile.name}
                                        {live > 0 && ` · ${live} connected`}
                                    </span>
                                    <span className={ITEM_DETAIL}>
                                        {profile.username || 'user'}@{profile.host || 'host'}:
                                        {profile.port}
                                    </span>
                                    {error && (
                                        <span
                                            role="alert"
                                            className="block truncate text-[11px] text-red-6"
                                            title={error.detail || error.message}
                                        >
                                            {error.message}
                                        </span>
                                    )}
                                </button>
                                <span className={ITEM_ACTIONS} hidden={selection.selecting}>
                                    {/* Driven by the session lifecycle: Play, spinner, Stop, spinner. */}
                                    <Tooltip label={control.label}>
                                        <ActionIcon
                                            variant="light"
                                            color={control.color}
                                            size="sm"
                                            data-state={phase}
                                            loading={control.busy}
                                            aria-busy={control.busy || undefined}
                                            aria-label={`${control.label} ${control.preposition} ${profile.name}`}
                                            onClick={() =>
                                                phase === 'connected'
                                                    ? disconnect(profile)
                                                    : connect(profile)
                                            }
                                            className="transition-colors"
                                        >
                                            {phase === 'connected' ? (
                                                <IconPlayerStop size={13} />
                                            ) : (
                                                <IconPlayerPlay size={13} />
                                            )}
                                        </ActionIcon>
                                    </Tooltip>
                                    <Menu position="bottom-end" width={190}>
                                        <Menu.Target>
                                            <ActionIcon
                                                variant="subtle"
                                                color="gray"
                                                size="sm"
                                                aria-label={`Actions for ${profile.name}`}
                                            >
                                                <IconDots size={14} />
                                            </ActionIcon>
                                        </Menu.Target>
                                        <Menu.Dropdown>
                                            <Menu.Item
                                                leftSection={<IconPencil size={14} />}
                                                onClick={() => setEditing(editExisting(profile.id))}
                                            >
                                                Edit…
                                            </Menu.Item>
                                            <Menu.Item
                                                leftSection={<IconCopy size={14} />}
                                                onClick={() => {
                                                    const copy = duplicateProfile(profile.id);
                                                    if (copy) setEditing(editExisting(copy));
                                                }}
                                            >
                                                Duplicate
                                            </Menu.Item>
                                            <Menu.Divider />
                                            <Menu.Item
                                                color="red"
                                                leftSection={<IconTrash size={14} />}
                                                onClick={() => void remove(profile)}
                                            >
                                                Delete
                                            </Menu.Item>
                                        </Menu.Dropdown>
                                    </Menu>
                                </span>
                            </div>
                        );
                    })
                )}
            </div>

            <SshProfileDialog target={editing} onClose={() => setEditing(null)} />
        </div>
    );
}
