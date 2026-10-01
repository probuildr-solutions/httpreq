/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconLayoutColumns, IconLayoutRows } from '@tabler/icons-react';
import { Fragment, useEffect, useState } from 'react';
import {
    DOCUMENTATION_URL,
    type AppInfo,
    type BuildInfo,
    type DesktopBridge,
} from '@httpreq/shared';
import { AppLogo } from './AppLogo';
import { AppModal } from './AppModal';
import type { CommandMap } from './commands';
import { DEFAULT_SPLIT_RATIO, usePreferences, type ResponsePosition } from './preferences';
import { formatChord, type KeyChord } from './shortcuts';
import { useUpdates, type UpdateInfo } from './updates';
import {
    Anchor,
    Button,
    Group,
    Kbd,
    SegmentedControl,
    Stack,
    Switch,
    Table,
    Text,
    useColorSchemePreference,
    type ColorSchemePreference,
} from './kit';

interface ModalProps {
    opened: boolean;
    onClose: () => void;
}

export function SettingsDialog({ opened, onClose }: ModalProps) {
    const { colorScheme, setColorScheme } = useColorSchemePreference();
    const preferences = usePreferences();

    return (
        <AppModal
            opened={opened}
            onClose={onClose}
            title="Settings"
            size="md"
            footerStart={
                <Button
                    variant="default"
                    onClick={() => {
                        preferences.setSplitRatio('right', DEFAULT_SPLIT_RATIO.right);
                        preferences.setSplitRatio('bottom', DEFAULT_SPLIT_RATIO.bottom);
                    }}
                >
                    Reset panel sizes
                </Button>
            }
            footer={<Button onClick={onClose}>Done</Button>}
        >
            <Stack gap="lg">
                <Stack gap={6}>
                    <Text size="sm" id="settings-theme" className="font-semibold">
                        Color theme
                    </Text>
                    <SegmentedControl
                        aria-labelledby="settings-theme"
                        value={colorScheme}
                        onChange={(value) => setColorScheme(value as ColorSchemePreference)}
                        data={[
                            { label: 'Light', value: 'light' },
                            { label: 'Dark', value: 'dark' },
                            { label: 'System', value: 'auto' },
                        ]}
                    />
                </Stack>
                <Stack gap={6}>
                    <Text size="sm" id="settings-layout" className="font-semibold">
                        Response panel position
                    </Text>
                    <SegmentedControl
                        aria-labelledby="settings-layout"
                        value={preferences.responsePosition}
                        onChange={(value) =>
                            preferences.setResponsePosition(value as ResponsePosition)
                        }
                        data={[
                            {
                                value: 'right',
                                label: (
                                    <Group gap={6} justify="center" wrap="nowrap">
                                        <IconLayoutColumns size={15} aria-hidden /> Right
                                    </Group>
                                ),
                            },
                            {
                                value: 'bottom',
                                label: (
                                    <Group gap={6} justify="center" wrap="nowrap">
                                        <IconLayoutRows size={15} aria-hidden /> Bottom
                                    </Group>
                                ),
                            },
                        ]}
                    />
                    <Text size="xs" className="text-dimmed">
                        Applies to every open and new request.
                    </Text>
                </Stack>
                <Switch
                    label="Show sidebar"
                    checked={preferences.sidebarVisible}
                    onChange={preferences.toggleSidebar}
                />
                <Switch
                    label="Show status bar"
                    checked={preferences.statusBarVisible}
                    onChange={preferences.toggleStatusBar}
                />
            </Stack>
        </AppModal>
    );
}

interface ShortcutRow {
    label: string;
    keys: string[];
}

const staticRows = (mac: boolean): { group: string; rows: ShortcutRow[] }[] => [
    {
        group: 'Request tabs (when the tab list has focus)',
        rows: [
            { label: 'Move between tabs', keys: ['←', '→'] },
            { label: 'First / last tab', keys: ['Home', 'End'] },
            { label: 'Open the focused tab', keys: ['Enter', 'Space'] },
            { label: 'Close the focused tab', keys: [mac ? '⌦' : 'Delete'] },
        ],
    },
    {
        group: 'General',
        rows: [
            { label: 'Close menu or dialog', keys: ['Esc'] },
            ...(mac ? [] : [{ label: 'Focus the application menu (desktop)', keys: ['Alt'] }]),
        ],
    },
];

export function ShortcutsDialog({
    opened,
    onClose,
    commands,
    mac,
    web,
}: ModalProps & { commands: CommandMap; mac: boolean; web: boolean }) {
    const chord = (value: KeyChord) => formatChord(value, mac);
    const commandRows: ShortcutRow[] = Object.entries(commands)
        .filter(([id, command]) => command.shortcut?.length && !id.startsWith('request.goto-'))
        .map(([, command]) => ({ label: command.label, keys: command.shortcut!.map(chord) }));
    commandRows.push({
        label: 'Go to request 1–9',
        keys: [`${chord({ key: '1', mod: true })} … ${chord({ key: '9', mod: true })}`],
    });

    const groups = [{ group: 'Commands', rows: commandRows }, ...staticRows(mac)];

    return (
        <AppModal
            opened={opened}
            onClose={onClose}
            title="Keyboard shortcuts"
            size="lg"
            footer={<Button onClick={onClose}>Close</Button>}
        >
            {web && (
                <Text size="xs" className="text-dimmed mb-2.5">
                    Browsers reserve some combinations (such as {chord({ key: 't', mod: true })},{' '}
                    {chord({ key: 'w', mod: true })} and {chord({ key: 'Tab', ctrl: true })}); those
                    work in the desktop app.
                </Text>
            )}
            <Table>
                <Table.Tbody>
                    {groups.map(({ group, rows }) => (
                        <Fragment key={group}>
                            <Table.Tr>
                                <Table.Th colSpan={2} className="pt-3.5">
                                    {group}
                                </Table.Th>
                            </Table.Tr>
                            {rows.map((row) => (
                                <Table.Tr key={`${group}-${row.label}`}>
                                    <Table.Td>{row.label}</Table.Td>
                                    <Table.Td className="text-right">
                                        <Group gap={4} justify="flex-end" wrap="wrap">
                                            {row.keys.map((key) => (
                                                <Kbd key={key} size="xs">
                                                    {key}
                                                </Kbd>
                                            ))}
                                        </Group>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Fragment>
                    ))}
                </Table.Tbody>
            </Table>
        </AppModal>
    );
}

const buildDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? iso
        : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** "Up to date", "Checking…" or the available update, with the way to get it. */
function UpdateStatusLine({
    onCheck,
    onApply,
}: {
    onCheck: () => Promise<void>;
    onApply?: (update: UpdateInfo) => void;
}) {
    const status = useUpdates((state) => state.status);
    const update = useUpdates((state) => state.update);
    const [checking, setChecking] = useState(false);
    const check = async () => {
        setChecking(true);
        try {
            await onCheck();
        } finally {
            setChecking(false);
        }
    };
    return (
        <Stack gap={6} align="center" className="mt-2">
            {update ? (
                <Text size="sm" className="text-primary-text font-semibold">
                    Version {update.version} is available.
                </Text>
            ) : status === 'current' ? (
                <Text size="xs" className="text-dimmed">
                    HttpReq is up to date.
                </Text>
            ) : status === 'error' ? (
                <Text size="xs" className="text-dimmed">
                    The last update check did not complete.
                </Text>
            ) : null}
            <Group gap="xs" justify="center">
                {update && onApply && (
                    <Button size="xs" onClick={() => onApply(update)}>
                        {update.kind === 'deployment' ? 'Reload to update' : 'Download update'}
                    </Button>
                )}
                <Button
                    size="xs"
                    variant="default"
                    loading={checking || status === 'checking'}
                    onClick={() => void check()}
                >
                    Check for updates
                </Button>
            </Group>
        </Stack>
    );
}

export function AboutDialog({
    opened,
    onClose,
    version,
    build,
    desktop,
    onOpenDocumentation,
    onCheckForUpdates,
    onApplyUpdate,
}: ModalProps & {
    version?: string;
    build?: BuildInfo;
    desktop?: DesktopBridge;
    onOpenDocumentation: () => void;
    onCheckForUpdates?: () => Promise<void>;
    onApplyUpdate?: (update: UpdateInfo) => void;
}) {
    const [info, setInfo] = useState<AppInfo | null>(null);
    useEffect(() => {
        if (opened && desktop && !info) void desktop.getAppInfo().then(setInfo);
    }, [opened, desktop, info]);

    return (
        <AppModal
            opened={opened}
            onClose={onClose}
            title="About HttpReq"
            size="sm"
            centered
            footer={<Button onClick={onClose}>Close</Button>}
        >
            <Stack align="center" gap="xs" className="text-center">
                <AppLogo size={56} />
                <Text size="lg" className="font-bold">
                    HttpReq
                </Text>
                <Text size="sm" className="text-dimmed">
                    Local-first API client · version {version ?? info?.version ?? 'unknown'}
                </Text>
                {build && build.commit !== 'dev' && (
                    <Text size="xs" className="text-dimmed font-mono">
                        Build {build.commit} · {buildDate(build.builtAt)}
                    </Text>
                )}
                {info && (
                    <Text size="xs" className="text-dimmed font-mono">
                        Electron {info.versions.electron} · Chromium {info.versions.chrome} · Node{' '}
                        {info.versions.node} · {info.platform}
                    </Text>
                )}
                {!desktop && (
                    <Text size="xs" className="text-dimmed">
                        Running in the browser
                    </Text>
                )}
                <Anchor
                    size="sm"
                    href={DOCUMENTATION_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                        event.preventDefault();
                        onOpenDocumentation();
                    }}
                >
                    Documentation
                </Anchor>
                {onCheckForUpdates && (
                    <UpdateStatusLine onCheck={onCheckForUpdates} onApply={onApplyUpdate} />
                )}
            </Stack>
        </AppModal>
    );
}
