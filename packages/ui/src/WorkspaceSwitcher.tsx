/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconCheck,
    IconChevronDown,
    IconCopy,
    IconPencil,
    IconPlus,
    IconStack2,
    IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { describeActiveResources, totalActiveResources } from '@httpreq/workspace';
import { AppModal } from './AppModal';
import { confirmAction } from './confirm';
import { useShallow } from 'zustand/react/shallow';
import { activeConnectionCounts, useConnectionsStore } from './connections';
import { useWorkbenchStore } from './store';
import type { WorkspaceActions } from './usePersistence';
import {
    Button,
    Menu,
    PICKER_TRIGGER,
    Stack,
    Text,
    TextInput,
    TRUNCATE_NAME,
    UnstyledButton,
    cx,
    notifications,
} from './kit';

interface RenameState {
    id: string;
    /** The name to restore when the rename is abandoned. */
    previous: string;
    value: string;
    /** Set once the user has edited the field, so the dialog does not open showing an error. */
    touched?: boolean;
}

interface Props {
    actions: WorkspaceActions;
    /** Closes every live connection the current workspace owns, before it is swapped out. */
    releaseConnections: () => Promise<void>;
}

/**
 * The workspace switcher.
 *
 * Switching replaces everything the user is looking at, and it tears down the live connections
 * the outgoing workspace owns, so anything running is named in a confirmation first rather than
 * disappearing silently.
 */
export function WorkspaceSwitcher({ actions, releaseConnections }: Props) {
    const current = useWorkbenchStore((state) => state.workspace);
    const workspaces = useWorkbenchStore((state) => state.workspaces);
    const switching = useWorkbenchStore((state) => state.switching);
    // Shallow-compared: the selector derives a fresh object, so it needs a stable comparison.
    const counts = useConnectionsStore(useShallow(activeConnectionCounts));
    /**
     * The open rename dialog. `previous` is the name to fall back to, so cancelling — or leaving
     * the field blank — can always restore a valid name rather than losing the workspace's own.
     */
    const [renaming, setRenaming] = useState<RenameState | null>(null);

    const blankName = !!renaming?.touched && !renaming.value.trim();

    /** True when it is safe to proceed: nothing is running, or the user said to close it. */
    const confirmTeardown = async (verb: string): Promise<boolean> => {
        if (totalActiveResources(counts) === 0) return true;
        const result = await confirmAction({
            title: 'Close active connections?',
            message: `${describeActiveResources(counts)} belong to “${current.name}”. ${verb} closes ${
                totalActiveResources(counts) === 1 ? 'it' : 'them'
            }.`,
            confirmLabel: `${verb} anyway`,
            danger: true,
        });
        return result === 'confirm';
    };

    const switchTo = async (id: string) => {
        if (id === current.id) return;
        if (!(await confirmTeardown('Switching workspace'))) return;
        await releaseConnections();
        if (!(await actions.switchTo(id))) {
            notifications.show({
                color: 'red',
                title: 'Workspace unavailable',
                message: 'That workspace could not be opened. It may have been deleted.',
            });
        }
    };

    const create = async () => {
        if (!(await confirmTeardown('Creating a workspace'))) return;
        await releaseConnections();
        await actions.create();
    };

    const duplicate = async () => {
        const id = await actions.duplicate(current.id);
        if (!id) return;
        notifications.show({
            title: 'Workspace duplicated',
            message:
                current.sshProfiles.length > 0
                    ? 'Stored SSH passwords and passphrases are not copied; re-enter them in the copy.'
                    : 'The copy is ready in the workspace list.',
        });
    };

    const remove = async (id: string, name: string) => {
        const isCurrent = id === current.id;
        if (isCurrent && !(await confirmTeardown('Deleting this workspace'))) return;
        const result = await confirmAction({
            title: 'Delete workspace',
            message: `Delete “${name}” and everything in it — collections, requests, environments and connection profiles? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result !== 'confirm') return;
        if (isCurrent) await releaseConnections();
        await actions.remove(id);
    };

    /**
     * Applies the rename. A blank or whitespace-only name is refused in place — the dialog stays
     * open with the error — because silently closing it would look like the name had been erased.
     */
    const commitRename = async () => {
        if (!renaming) return;
        const { id, value, previous } = renaming;
        const name = value.trim();
        if (!name) {
            setRenaming({ id, previous, value: '', touched: true });
            return;
        }
        setRenaming(null);
        if (name !== previous) await actions.rename(id, name);
    };

    /** Escape, the close button, the overlay: the workspace keeps the name it already had. */
    const cancelRename = () => setRenaming(null);

    return (
        <>
            {/* Centred under the trigger, which sits in the middle of the title bar. */}
            <Menu position="bottom" width={280}>
                <Menu.Target>
                    <UnstyledButton
                        /*
                         * Sized to the name it holds, up to a cap, and free to shrink further when the bar is
                         * narrow: the centre zone gives way to the controls on either side before anything
                         * can overlap.
                         */
                        className={cx(
                            PICKER_TRIGGER,
                            'app-no-drag h-6 max-w-[min(260px,100%)] min-w-0 px-2',
                        )}
                        aria-label={`Workspace: ${current.name}. Select to switch workspace.`}
                        // A name too long for the bar is truncated, so the full one stays readable on hover.
                        title={current.name}
                        disabled={switching}
                    >
                        <IconStack2 size={14} aria-hidden />
                        <span className="min-w-0 truncate font-semibold">{current.name}</span>
                        <IconChevronDown size={13} aria-hidden />
                    </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                    <Menu.Label>Switch workspace</Menu.Label>
                    {workspaces.map((workspace) => (
                        <Menu.Item
                            key={workspace.id}
                            onClick={() => void switchTo(workspace.id)}
                            leftSection={
                                workspace.id === current.id ? (
                                    <IconCheck size={14} />
                                ) : (
                                    <span className="w-3.5" aria-hidden />
                                )
                            }
                            aria-current={workspace.id === current.id ? 'true' : undefined}
                        >
                            <span className={TRUNCATE_NAME}>{workspace.name}</span>
                        </Menu.Item>
                    ))}
                    <Menu.Divider />
                    {/*
                     * Rename, duplicate and delete act on the current workspace rather than on each row:
                     * a row is one control that switches, so putting more buttons inside it would nest
                     * interactive elements. Managing another workspace means switching to it first.
                     */}
                    <Menu.Label>“{current.name}”</Menu.Label>
                    <Menu.Item
                        leftSection={<IconPencil size={14} />}
                        onClick={() =>
                            setRenaming({
                                id: current.id,
                                previous: current.name,
                                value: current.name,
                            })
                        }
                    >
                        Rename…
                    </Menu.Item>
                    <Menu.Item
                        leftSection={<IconCopy size={14} />}
                        onClick={() => void duplicate()}
                    >
                        Duplicate
                    </Menu.Item>
                    <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        disabled={workspaces.length <= 1}
                        onClick={() => void remove(current.id, current.name)}
                    >
                        Delete
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => void create()}>
                        New workspace
                    </Menu.Item>
                </Menu.Dropdown>
            </Menu>

            <AppModal
                opened={!!renaming}
                onClose={cancelRename}
                title="Rename workspace"
                centered
                size="sm"
                footer={
                    <>
                        <Button variant="default" onClick={cancelRename}>
                            Cancel
                        </Button>
                        <Button disabled={blankName} onClick={() => void commitRename()}>
                            Rename
                        </Button>
                    </>
                }
            >
                <Stack gap="sm">
                    <TextInput
                        label="Name"
                        data-autofocus
                        value={renaming?.value ?? ''}
                        error={blankName ? 'Enter a name for the workspace.' : null}
                        onChange={(event) => {
                            // Read out of the event before the updater runs: React clears `currentTarget` as
                            // soon as the handler returns, and a lazy updater would then read it as null and
                            // take the whole application down with it.
                            const value = event.currentTarget.value;
                            setRenaming((state) =>
                                state ? { ...state, value, touched: true } : state,
                            );
                        }}
                        onBlur={() =>
                            // Never leave the field empty behind the user: put the current name back so the
                            // dialog always shows something valid to accept.
                            setRenaming((state) =>
                                state && !state.value.trim()
                                    ? { ...state, value: state.previous }
                                    : state,
                            )
                        }
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                void commitRename();
                            }
                            if (event.key === 'Escape') cancelRename();
                        }}
                    />
                    <Text size="xs" className="text-dimmed">
                        Requests, environments and connection profiles keep their identifiers, so
                        nothing breaks when a workspace is renamed.
                    </Text>
                </Stack>
            </AppModal>
        </>
    );
}
