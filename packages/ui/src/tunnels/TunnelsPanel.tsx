/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconAlertTriangle,
    IconCopy,
    IconDots,
    IconPencil,
    IconPlayerPlay,
    IconPlayerStop,
    IconPlus,
    IconRefresh,
    IconRouter,
    IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import {
    createTunnelProfile as newTunnelProfile,
    type TunnelProfile,
    type TunnelStatus,
} from '@httpreq/shared';
import { confirmAction } from '../confirm';
import { editExisting, editNew, type EditTarget } from '../editTarget';
import { useConnectionsStore } from '../connections';
import { formatSize } from '../format';
import { useWorkbenchStore } from '../store';
import { TunnelDialog } from './TunnelDialog';
import { useTunnels } from './useTunnels';
import {
    EMPTY,
    ITEM,
    ITEM_ACTIONS,
    ITEM_DETAIL,
    ITEM_NAME,
    ITEM_TEXT,
    LIST,
    PANEL,
} from '../ssh/styles';
import { PanelHeader } from '../explorer/PanelHeader';
import {
    BulkButton,
    BulkDeleteButton,
    RowCheckbox,
    SelectionBar,
    SelectModeButton,
} from '../explorer/Selection';
import { useSelection } from '../explorer/useSelection';
import { ActionIcon, Button, Menu, StatusDot, Text, Tooltip, cx, notifications } from '../kit';

const STATUS_LABEL: Record<TunnelStatus, string> = {
    stopped: 'Stopped',
    starting: 'Starting…',
    active: 'Active',
    stopping: 'Stopping…',
    error: 'Error',
};

/** "2 h 14 m", "3 m", "12 s" — enough to see how long a tunnel has been up. */
const uptime = (startedAt: string | null): string => {
    if (!startedAt) return '';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} m`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
};

/** The Tunnels sidebar view: the workspace's forwarding profiles and their live state. */
export function TunnelsPanel() {
    const profiles = useWorkbenchStore((state) => state.workspace.tunnelProfiles);
    const sshProfiles = useWorkbenchStore((state) => state.workspace.sshProfiles);
    const duplicateTunnel = useWorkbenchStore((state) => state.duplicateTunnelProfile);
    const deleteTunnel = useWorkbenchStore((state) => state.deleteTunnelProfile);
    const states = useConnectionsStore((state) => state.tunnels);
    const api = useTunnels();
    const [editing, setEditing] = useState<EditTarget<TunnelProfile> | null>(null);
    /** A new tunnel, not saved until the dialog's Save, carried by the first SSH connection. */
    const startNew = () => setEditing(editNew(newTunnelProfile(sshProfiles[0]?.id ?? '')));
    const selection = useSelection(useMemo(() => profiles.map((tunnel) => tunnel.id), [profiles]));
    const selected = () => profiles.filter((tunnel) => selection.isSelected(tunnel.id));

    const report = (error: Awaited<ReturnType<typeof api.start>>) => {
        if (error) {
            notifications.show({
                color: 'red',
                title: 'Tunnel not started',
                message: error.message,
            });
        }
    };

    const remove = async (tunnel: TunnelProfile) => {
        const result = await confirmAction({
            title: 'Delete tunnel',
            message: `Delete “${tunnel.name}”? If it is running it will be stopped first.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result !== 'confirm') return;
        await api.stop(tunnel.id);
        deleteTunnel(tunnel.id);
    };

    const startSelected = async () => {
        const failures: string[] = [];
        for (const tunnel of selected()) {
            const status = states[tunnel.id]?.status ?? 'stopped';
            if (status === 'active' || status === 'starting') continue;
            const error = await api.start(tunnel);
            if (error) failures.push(`${tunnel.name}: ${error.message}`);
        }
        if (failures.length) {
            notifications.show({
                color: 'red',
                title: `${failures.length} tunnel${failures.length === 1 ? '' : 's'} not started`,
                message: failures.join(' · '),
            });
        }
    };

    const stopSelected = async () => {
        for (const tunnel of selected()) await api.stop(tunnel.id);
    };

    const removeSelected = async () => {
        const tunnels = selected();
        if (tunnels.length === 0) return;
        const count = tunnels.length;
        const result = await confirmAction({
            title: count === 1 ? 'Delete tunnel' : `Delete ${count} tunnels`,
            message: `Delete ${count === 1 ? `“${tunnels[0]!.name}”` : `${count} tunnels`}? Running tunnels are stopped first.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result !== 'confirm') return;
        for (const tunnel of tunnels) {
            await api.stop(tunnel.id);
            deleteTunnel(tunnel.id);
        }
        selection.stop();
    };

    return (
        <div className={PANEL}>
            <PanelHeader title="Tunnels">
                <SelectModeButton selection={selection} noun="tunnels" />
                <Tooltip label="New tunnel">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label="New tunnel"
                        onClick={startNew}
                    >
                        <IconPlus size={15} />
                    </ActionIcon>
                </Tooltip>
            </PanelHeader>
            <SelectionBar selection={selection} label="Tunnel selection">
                <BulkButton
                    selection={selection}
                    label="Start"
                    title="Start selected tunnels"
                    icon={<IconPlayerPlay size={13} />}
                    onClick={() => void startSelected()}
                />
                <BulkButton
                    selection={selection}
                    color="gray"
                    label="Stop"
                    title="Stop selected tunnels"
                    icon={<IconPlayerStop size={13} />}
                    onClick={() => void stopSelected()}
                />
                <BulkDeleteButton
                    selection={selection}
                    noun="tunnels"
                    onDelete={() => void removeSelected()}
                />
            </SelectionBar>

            <div className={LIST}>
                {profiles.length === 0 ? (
                    <div className={EMPTY}>
                        <Text size="sm" className="text-dimmed mb-2">
                            {sshProfiles.length
                                ? 'No tunnels in this workspace.'
                                : 'Create an SSH connection first, then a tunnel to forward through it.'}
                        </Text>
                        <Button
                            size="xs"
                            variant="light"
                            leftSection={<IconPlus size={14} />}
                            onClick={startNew}
                        >
                            New tunnel
                        </Button>
                    </div>
                ) : (
                    profiles.map((tunnel) => {
                        const state = states[tunnel.id];
                        const status = state?.status ?? 'stopped';
                        const running = status === 'active' || status === 'starting';
                        const transferred = state
                            ? `${formatSize(state.bytesSent)} ↑ · ${formatSize(state.bytesReceived)} ↓`
                            : '';
                        const checked = selection.isSelected(tunnel.id);
                        return (
                            <div
                                key={tunnel.id}
                                className={ITEM}
                                data-checked={checked || undefined}
                                data-selectable={selection.selecting || undefined}
                            >
                                {selection.selecting && (
                                    <RowCheckbox
                                        checked={checked}
                                        label={tunnel.name}
                                        onChange={() => selection.toggle(tunnel.id)}
                                    />
                                )}
                                <IconRouter size={15} aria-hidden />
                                <button
                                    type="button"
                                    className={ITEM_TEXT}
                                    onClick={() =>
                                        selection.selecting
                                            ? selection.toggle(tunnel.id)
                                            : setEditing(editExisting(tunnel.id))
                                    }
                                    tabIndex={selection.selecting ? -1 : undefined}
                                    title={`${tunnel.localBindAddress}:${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}`}
                                >
                                    <span className={ITEM_NAME}>
                                        <StatusDot status={status} className="mr-1 inline-block" />
                                        {tunnel.name}
                                    </span>
                                    <span className={ITEM_DETAIL}>
                                        {tunnel.localBindAddress}:{tunnel.localPort} →{' '}
                                        {tunnel.remoteHost}:{tunnel.remotePort}
                                    </span>
                                    <span className={ITEM_DETAIL}>
                                        {STATUS_LABEL[status]}
                                        {state?.startedAt && status === 'active'
                                            ? ` · ${uptime(state.startedAt)}`
                                            : ''}
                                        {state && status === 'active' ? ` · ${transferred}` : ''}
                                    </span>
                                    {state?.error && (
                                        <span className={cx(ITEM_DETAIL, 'text-danger-text')}>
                                            <IconAlertTriangle
                                                size={10}
                                                className="inline align-middle"
                                            />{' '}
                                            {state.error.message}
                                        </span>
                                    )}
                                </button>
                                <span className={ITEM_ACTIONS} hidden={selection.selecting}>
                                    {running ? (
                                        <Tooltip label="Stop tunnel">
                                            <ActionIcon
                                                variant="subtle"
                                                color="gray"
                                                size="sm"
                                                aria-label={`Stop ${tunnel.name}`}
                                                onClick={() => void api.stop(tunnel.id)}
                                            >
                                                <IconPlayerStop size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                    ) : (
                                        <Tooltip label="Start tunnel">
                                            <ActionIcon
                                                variant="subtle"
                                                color="gray"
                                                size="sm"
                                                aria-label={`Start ${tunnel.name}`}
                                                onClick={() => void api.start(tunnel).then(report)}
                                            >
                                                <IconPlayerPlay size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                    )}
                                    <Menu position="bottom-end" width={190}>
                                        <Menu.Target>
                                            <ActionIcon
                                                variant="subtle"
                                                color="gray"
                                                size="sm"
                                                aria-label={`Actions for ${tunnel.name}`}
                                            >
                                                <IconDots size={14} />
                                            </ActionIcon>
                                        </Menu.Target>
                                        <Menu.Dropdown>
                                            <Menu.Item
                                                leftSection={<IconRefresh size={14} />}
                                                onClick={() =>
                                                    void api.restart(tunnel).then(report)
                                                }
                                            >
                                                Restart
                                            </Menu.Item>
                                            <Menu.Item
                                                leftSection={<IconPencil size={14} />}
                                                onClick={() => setEditing(editExisting(tunnel.id))}
                                            >
                                                Edit…
                                            </Menu.Item>
                                            <Menu.Item
                                                leftSection={<IconCopy size={14} />}
                                                onClick={() => {
                                                    const copy = duplicateTunnel(tunnel.id);
                                                    if (copy) setEditing(editExisting(copy));
                                                }}
                                            >
                                                Duplicate
                                            </Menu.Item>
                                            <Menu.Divider />
                                            <Menu.Item
                                                color="red"
                                                leftSection={<IconTrash size={14} />}
                                                onClick={() => void remove(tunnel)}
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

            <TunnelDialog target={editing} onClose={() => setEditing(null)} />
        </div>
    );
}
