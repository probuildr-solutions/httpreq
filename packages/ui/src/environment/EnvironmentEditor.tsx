/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconCheck,
    IconCopy,
    IconDots,
    IconLayoutSidebarLeftExpand,
    IconTrash,
    IconVariable,
} from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { createId, type EnvironmentVariable } from '@httpreq/shared';
import { confirmAction } from '../confirm';
import { KeyValueTable } from '../editor/KeyValueTable';
import { usePreferences } from '../preferences';
import { useWorkbenchStore } from '../store';
import { ActionIcon, Button, Menu, Text, TextInput, Tooltip } from '../kit';

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
    const active = useWorkbenchStore(
        (state) => state.workspace.activeEnvironmentId === environmentId,
    );
    const naming = useWorkbenchStore((state) => state.namingEnvironmentId === environmentId);
    const actions = useWorkbenchStore.getState;
    const nameRef = useRef<HTMLInputElement>(null);

    // A new environment opens with its placeholder name selected, ready to be typed over.
    useEffect(() => {
        if (!naming) return;
        nameRef.current?.focus();
        nameRef.current?.select();
        actions().clearNamingEnvironment();
    }, [naming, actions]);

    if (!environment) return null;

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
                <TextInput
                    ref={nameRef}
                    aria-label="Environment name"
                    placeholder="Environment name"
                    value={environment.name}
                    onChange={(event) => update({ name: event.currentTarget.value })}
                    onBlur={(event) =>
                        !event.currentTarget.value.trim() && update({ name: 'Environment' })
                    }
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    className="max-w-[480px] min-w-0 flex-1"
                    inputClassName="h-8 min-h-8 font-semibold"
                />
                {active ? (
                    <Button
                        variant="light"
                        leftSection={<IconCheck size={15} />}
                        onClick={() => actions().setActiveEnvironment(null)}
                        title="Requests resolve {{variables}} from this environment. Select to stop using it."
                        className="h-8 flex-none"
                    >
                        Active
                    </Button>
                ) : (
                    <Button
                        variant="default"
                        onClick={() => actions().setActiveEnvironment(environment.id)}
                        className="h-8 flex-none"
                    >
                        Set active
                    </Button>
                )}
                <Menu position="bottom-end">
                    <Menu.Target>
                        <ActionIcon
                            variant="default"
                            size={32}
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
                    Use a variable as <code>{'{{name}}'}</code> in URLs, parameters, headers, bodies
                    and authorization. Secret values are masked and kept only for this session; they
                    are never written to disk.
                </Text>
            </div>
        </div>
    );
}
