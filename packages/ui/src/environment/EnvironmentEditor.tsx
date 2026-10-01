/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconCheck,
    IconCopy,
    IconDots,
    IconLayoutSidebarLeftExpand,
    IconPencil,
    IconTrash,
    IconVariable,
    IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createId, type EnvironmentVariable } from '@httpreq/shared';
import { confirmAction } from '../confirm';
import { KeyValueTable } from '../editor/KeyValueTable';
import { usePreferences } from '../preferences';
import { useWorkbenchStore } from '../store';
import { ActionIcon, Menu, Text, TextInput, Tooltip } from '../kit';

const createVariable = (patch: Partial<EnvironmentVariable>): EnvironmentVariable => ({
    id: createId(),
    key: '',
    value: '',
    enabled: true,
    secret: false,
    ...patch,
});

/**
 * An environment's name and variables, in a tab of its own beside the request tabs, so several
 * environments can be open and compared at once. Every edit is committed as it is made: there is
 * nothing to save, and closing the tab loses nothing.
 */
export function EnvironmentEditor({ environmentId }: { environmentId: string }) {
    const environment = useWorkbenchStore((state) =>
        state.workspace.environments.find((item) => item.id === environmentId),
    );
    const collections = useWorkbenchStore((state) => state.workspace.collections);
    const linked = useMemo(
        () => collections.filter((item) => item.environmentId === environmentId),
        [collections, environmentId],
    );
    const naming = useWorkbenchStore((state) => state.namingEnvironmentId === environmentId);
    const actions = useWorkbenchStore.getState;
    const nameRef = useRef<HTMLInputElement>(null);
    // The name is text until Edit is chosen; the draft is only written back by Save.
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');

    const startEditing = () => {
        setDraft(environment?.name ?? '');
        setEditing(true);
    };

    // A new environment opens with its placeholder name selected, ready to be typed over.
    useEffect(() => {
        if (!naming) return;
        setDraft(environment?.name ?? '');
        setEditing(true);
        actions().clearNamingEnvironment();
    }, [naming, actions, environment?.name]);

    useEffect(() => {
        if (!editing) return;
        nameRef.current?.focus();
        nameRef.current?.select();
    }, [editing]);

    if (!environment) return null;

    const saveName = () => {
        update({ name: draft.trim() || 'Environment' });
        setEditing(false);
    };
    const cancelName = () => setEditing(false);

    const update = (patch: Parameters<ReturnType<typeof actions>['updateEnvironment']>[1]) =>
        actions().updateEnvironment(environment.id, patch);

    const remove = async () => {
        const result = await confirmAction({
            title: 'Delete environment',
            message: `Delete “${environment.name}” and its variables? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result === 'confirm') actions().deleteEnvironment(environment.id);
    };

    const showInSidebar = () => {
        actions().setSidebarView('environments');
        const preferences = usePreferences.getState();
        if (!preferences.sidebarVisible) preferences.toggleSidebar();
    };

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <nav
                aria-label="Environment location"
                className="flex h-[30px] min-w-0 items-center px-2.5 pt-1"
            >
                <Tooltip label="Show environments in the sidebar">
                    <button
                        type="button"
                        className="inline-flex cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent px-[5px] py-0.5 text-xs text-dimmed hover:bg-hover hover:text-fg"
                        onClick={showInSidebar}
                    >
                        <IconVariable size={13} aria-hidden />
                        Environments
                    </button>
                </Tooltip>
            </nav>

            <div className="flex items-center gap-1.5 border-b border-line px-2.5 pt-1.5 pb-2">
                {editing ? (
                    <>
                        <TextInput
                            ref={nameRef}
                            aria-label="Environment name"
                            placeholder="Environment name"
                            value={draft}
                            onChange={(event) => setDraft(event.currentTarget.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') saveName();
                                if (event.key === 'Escape') cancelName();
                            }}
                            className="max-w-[480px] min-w-0 flex-1"
                            inputClassName="font-semibold"
                        />
                        <Tooltip label="Save name">
                            <ActionIcon
                                variant="light"
                                size={30}
                                aria-label="Save environment name"
                                onClick={saveName}
                            >
                                <IconCheck size={16} />
                            </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Cancel">
                            <ActionIcon
                                variant="default"
                                size={30}
                                aria-label="Cancel renaming"
                                onClick={cancelName}
                            >
                                <IconX size={16} />
                            </ActionIcon>
                        </Tooltip>
                    </>
                ) : (
                    <>
                        <h2
                            className="m-0 flex h-[30px] max-w-[480px] min-w-0 items-center truncate text-sm font-semibold"
                            title={environment.name}
                        >
                            {environment.name}
                        </h2>
                        <Tooltip label="Rename environment">
                            <ActionIcon
                                variant="default"
                                size={30}
                                aria-label="Edit environment name"
                                onClick={startEditing}
                            >
                                <IconPencil size={15} />
                            </ActionIcon>
                        </Tooltip>
                    </>
                )}
                <span className="flex-1" />
                <Menu position="bottom-end">
                    <Menu.Target>
                        <ActionIcon
                            variant="default"
                            size={30}
                            aria-label={`More actions for ${environment.name}`}
                        >
                            <IconDots size={16} />
                        </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item
                            leftSection={<IconCopy size={14} />}
                            onClick={() => {
                                const copyId = actions().duplicateEnvironment(environment.id);
                                if (copyId) actions().openEnvironmentTab(copyId);
                            }}
                        >
                            Duplicate
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconLayoutSidebarLeftExpand size={14} />}
                            onClick={showInSidebar}
                        >
                            Show in sidebar
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => void remove()}
                        >
                            Delete
                        </Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2.5">
                <KeyValueTable<EnvironmentVariable>
                    label="Variables"
                    keyPlaceholder="Variable"
                    items={environment.variables}
                    onChange={(variables) => update({ variables })}
                    createRow={createVariable}
                    allowSecret
                    showDescription={false}
                />
                <Text size="xs" className="text-dimmed mt-2.5">
                    {linked.length > 0 ? (
                        <>Used by every request in {linked.map((item) => item.name).join(', ')}. </>
                    ) : (
                        <>
                            Not linked to a collection yet; link it in a collection’s settings or
                            from the environment picker above a request.{' '}
                        </>
                    )}
                    Use a variable as <code>{'{{name}}'}</code> in URLs, parameters, headers, bodies
                    and authorization. Secret values are masked and kept only for this session; they
                    are never written to disk.
                </Text>
            </div>
        </div>
    );
}
