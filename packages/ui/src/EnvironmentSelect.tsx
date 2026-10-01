/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconCheck,
    IconChevronDown,
    IconPencil,
    IconSettings,
    IconVariable,
} from '@tabler/icons-react';
import { memo } from 'react';
import { usePreferences } from './preferences';
import { useWorkbenchStore } from './store';
import { Menu, PICKER_TRIGGER, TRUNCATE_NAME, UnstyledButton, cx } from './kit';

const check = (checked: boolean) =>
    checked ? <IconCheck size={14} /> : <span className="w-3.5" aria-hidden />;

/**
 * Compact active-environment picker for the tab strip. It follows the workspace switcher (a
 * button naming the current choice, opening a menu of the others) but keeps a visible border, so
 * it reads as a control among the tabs rather than as one more label.
 */
export const EnvironmentSelect = memo(function EnvironmentSelect() {
    const environments = useWorkbenchStore((state) => state.workspace.environments);
    const activeId = useWorkbenchStore((state) => state.workspace.activeEnvironmentId);
    const setActive = useWorkbenchStore((state) => state.setActiveEnvironment);
    const linkEnvironment = useWorkbenchStore((state) => state.linkEnvironment);
    // What a choice is linked to: the open request, else the selected collection or folder.
    const linkTarget = useWorkbenchStore((state) => {
        const id = state.activeRequestId ?? state.selectedNodeId;
        // WebSocket requests cannot be linked to an environment.
        return id && !state.workspace.websocketRequests.some((socket) => socket.id === id)
            ? id
            : null;
    });
    const choose = (environmentId: string | null) =>
        linkTarget ? linkEnvironment(linkTarget, environmentId) : setActive(environmentId);
    const active = environments.find((environment) => environment.id === activeId);
    const label = active?.name ?? 'No environment';

    const manage = () => {
        useWorkbenchStore.getState().setSidebarView('environments');
        const preferences = usePreferences.getState();
        if (!preferences.sidebarVisible) preferences.toggleSidebar();
    };

    return (
        <Menu position="bottom-end" width={240}>
            <Menu.Target>
                <UnstyledButton
                    /*
                     * The picker sizes itself, rather than being sized by whatever is left over in the tab
                     * strip: `flex-none` opts out of the strip's shrinking, and the width is capped so the
                     * tabs keep their space. `vw` in the cap makes it give ground gradually on a narrow
                     * window instead of at one breakpoint.
                     */
                    className={cx(
                        PICKER_TRIGGER,
                        'mx-1.5 h-[26px] min-w-[124px] max-w-[clamp(124px,16vw,200px)] flex-none self-center pr-1.5 pl-2',
                    )}
                    aria-label={`Environment: ${label}. Select to change the active environment.`}
                    // A name too long for the control is truncated, so the full one stays readable on hover.
                    title={label}
                    data-empty={!active || undefined}
                >
                    <IconVariable
                        size={14}
                        aria-hidden
                        className={cx('flex-none', active ? 'text-primary' : 'text-dimmed')}
                    />
                    <span
                        className={cx('min-w-0 truncate font-semibold', !active && 'text-dimmed')}
                    >
                        {label}
                    </span>
                    <IconChevronDown
                        size={13}
                        aria-hidden
                        className="ml-auto flex-none text-dimmed"
                    />
                </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
                <Menu.Label>Environment for this request</Menu.Label>
                <Menu.Item
                    leftSection={check(!active)}
                    aria-current={!active ? 'true' : undefined}
                    onClick={() => choose(null)}
                >
                    <span className={TRUNCATE_NAME}>No environment</span>
                </Menu.Item>
                {environments.map((environment) => (
                    <Menu.Item
                        key={environment.id}
                        leftSection={check(environment.id === active?.id)}
                        aria-current={environment.id === active?.id ? 'true' : undefined}
                        onClick={() => choose(environment.id)}
                    >
                        <span className={TRUNCATE_NAME}>{environment.name}</span>
                    </Menu.Item>
                ))}
                <Menu.Divider />
                {active && (
                    <Menu.Item
                        leftSection={<IconPencil size={14} />}
                        onClick={() => useWorkbenchStore.getState().openEnvironmentTab(active.id)}
                    >
                        <span className={TRUNCATE_NAME}>Edit “{active.name}”</span>
                    </Menu.Item>
                )}
                <Menu.Item leftSection={<IconSettings size={14} />} onClick={manage}>
                    Manage environments
                </Menu.Item>
            </Menu.Dropdown>
        </Menu>
    );
});
