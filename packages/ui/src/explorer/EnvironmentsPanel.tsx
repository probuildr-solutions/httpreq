/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconCopy,
    IconDots,
    IconLink,
    IconPencil,
    IconPlus,
    IconTrash,
    IconVariable,
} from '@tabler/icons-react';
import { useMemo } from 'react';
import { confirmAction } from '../confirm';
import { useWorkbenchStore } from '../store';
import { ActionIcon, Button, Menu, Stack, Text, Tooltip, UnstyledButton, cx } from '../kit';
import { PanelHeader } from './PanelHeader';
import { BulkDeleteButton, RowCheckbox, SelectionBar, SelectModeButton } from './Selection';
import { useSelection } from './useSelection';
import { EXPLORER, ROW_NAME, SIMPLE_ROW, TREE } from './styles';

/** One environment line: the radio or checkbox, its name and its actions. */
const ENV_ROW = cx(SIMPLE_ROW, 'flex min-h-7 items-center gap-2 pr-1 pl-2');
const ENV_NAME = 'flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px]';

interface Props {
    /** Called after an environment's tab is opened (e.g. to close the mobile drawer). */
    onOpened?: () => void;
}

/**
 * Lists the environments. There is no globally active one: an environment is linked to a
 * collection (in its settings or from the picker above the request) and every folder and request
 * in the collection uses it. Editing happens in the environment's own tab beside the request tabs,
 * so several can be open at once. A selection mode shows checkboxes so several environments can
 * be deleted together.
 */
export function EnvironmentsPanel({ onOpened }: Props) {
    const environments = useWorkbenchStore((state) => state.workspace.environments);
    const collections = useWorkbenchStore((state) => state.workspace.collections);
    const openTabId = useWorkbenchStore((state) => state.activeEnvironmentTabId);
    const actions = useWorkbenchStore.getState;
    const selection = useSelection(
        useMemo(() => environments.map((environment) => environment.id), [environments]),
    );

    const removeSelected = async () => {
        const selected = environments.filter((environment) => selection.isSelected(environment.id));
        if (selected.length === 0) return;
        const count = selected.length;
        const result = await confirmAction({
            title: count === 1 ? 'Delete environment' : `Delete ${count} environments`,
            message:
                count === 1
                    ? `Delete “${selected[0]!.name}” and its variables? This cannot be undone.`
                    : `Delete ${count} environments and all of their variables? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result !== 'confirm') return;
        actions().deleteEnvironments(selected.map((environment) => environment.id));
        selection.stop();
    };

    const edit = (id: string, naming = false) => {
        actions().openEnvironmentTab(id, { naming });
        onOpened?.();
    };
    const create = () => edit(actions().createEnvironment(), true);

    const remove = async (id: string, name: string) => {
        const result = await confirmAction({
            title: 'Delete environment',
            message: `Delete “${name}” and its variables? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result === 'confirm') actions().deleteEnvironment(id);
    };

    return (
        <div className={EXPLORER}>
            <PanelHeader title="Environments">
                <SelectModeButton selection={selection} noun="environments" />
                <Tooltip label="New environment">
                    <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label="New environment"
                        onClick={create}
                    >
                        <IconPlus size={15} />
                    </ActionIcon>
                </Tooltip>
            </PanelHeader>
            {selection.selecting ? (
                <SelectionBar selection={selection} label="Environment selection">
                    <BulkDeleteButton
                        selection={selection}
                        noun="environments"
                        onDelete={() => void removeSelected()}
                    />
                </SelectionBar>
            ) : (
                <Text size="xs" className="px-3 py-1.5 text-dimmed">
                    Link an environment to a collection; its requests resolve{' '}
                    <code>{'{{variables}}'}</code> from it.
                </Text>
            )}
            {selection.selecting ? (
                <Stack gap={2} className={TREE}>
                    {environments.map((environment) => (
                        <div
                            key={environment.id}
                            className={ENV_ROW}
                            data-checked={selection.isSelected(environment.id) || undefined}
                            data-selectable
                            onClick={() => selection.toggle(environment.id)}
                        >
                            <RowCheckbox
                                checked={selection.isSelected(environment.id)}
                                label={environment.name}
                                onChange={() => selection.toggle(environment.id)}
                            />
                            <span className={ENV_NAME}>
                                <IconVariable size={14} aria-hidden />
                                <span className={ROW_NAME}>{environment.name}</span>
                            </span>
                        </div>
                    ))}
                </Stack>
            ) : (
                <Stack gap={2} className={TREE}>
                    {environments.map((environment) => {
                        const linked = collections
                            .filter((collection) => collection.environmentId === environment.id)
                            .map((collection) => collection.name);
                        return (
                            <div
                                key={environment.id}
                                className={ENV_ROW}
                                data-editing={environment.id === openTabId || undefined}
                            >
                                <UnstyledButton
                                    // The environment whose tab is showing is set in bold, like the open request.
                                    className={cx(
                                        ENV_NAME,
                                        environment.id === openTabId && 'font-semibold',
                                    )}
                                    aria-current={environment.id === openTabId ? 'page' : undefined}
                                    title={
                                        linked.length
                                            ? `Linked to ${linked.join(', ')}`
                                            : `Edit “${environment.name}” in a tab`
                                    }
                                    onClick={() => edit(environment.id)}
                                >
                                    <IconVariable size={14} aria-hidden />
                                    <span className={ROW_NAME}>{environment.name}</span>
                                    <Text component="span" size="xs" className="text-dimmed">
                                        {
                                            environment.variables.filter(
                                                (variable) => variable.enabled && variable.key,
                                            ).length
                                        }
                                    </Text>
                                </UnstyledButton>
                                {linked.length > 0 && (
                                    <IconLink
                                        size={12}
                                        aria-label={`Linked to ${linked.join(', ')}`}
                                        className="flex-none text-dimmed"
                                    />
                                )}
                                <Menu position="bottom-end">
                                    <Menu.Target>
                                        <ActionIcon
                                            variant="subtle"
                                            size="xs"
                                            aria-label={`Actions for ${environment.name}`}
                                        >
                                            <IconDots size={13} />
                                        </ActionIcon>
                                    </Menu.Target>
                                    <Menu.Dropdown>
                                        <Menu.Item
                                            leftSection={<IconPencil size={14} />}
                                            onClick={() => edit(environment.id)}
                                        >
                                            Edit variables
                                        </Menu.Item>
                                        <Menu.Item
                                            leftSection={<IconCopy size={14} />}
                                            onClick={() =>
                                                actions().duplicateEnvironment(environment.id)
                                            }
                                        >
                                            Duplicate
                                        </Menu.Item>
                                        <Menu.Item
                                            color="red"
                                            leftSection={<IconTrash size={14} />}
                                            onClick={() =>
                                                void remove(environment.id, environment.name)
                                            }
                                        >
                                            Delete
                                        </Menu.Item>
                                    </Menu.Dropdown>
                                </Menu>
                            </div>
                        );
                    })}
                </Stack>
            )}
            {environments.length === 0 && (
                <Stack align="flex-start" gap="xs" className="px-3 py-2.5">
                    <Text size="xs" className="text-dimmed">
                        Create an environment such as “Development” with a <code>base_url</code>{' '}
                        variable.
                    </Text>
                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlus size={14} />}
                        onClick={create}
                    >
                        New environment
                    </Button>
                </Stack>
            )}
        </div>
    );
}
