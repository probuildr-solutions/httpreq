/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { CommandMap } from './commands';
import { ActionIcon, Tooltip } from './kit';

interface Props {
    toggleSidebar?: CommandMap[string];
    sidebarVisible: boolean;
    /** Items after the sidebar toggle, in order: the workspace menu first. */
    children: ReactNode;
}

/**
 * The navigation layer under the title bar, separated from it by a rule above and below. It reads
 * `Sidebar toggle | Workspace menu | other items`, so workspace-level navigation never blends into
 * the OS or application menu.
 */
export function SecondaryBar({ toggleSidebar, sidebarVisible, children }: Props) {
    return (
        <nav
            className="box-border flex h-full items-center gap-1.5 border-y border-line bg-chrome px-2 select-none"
            aria-label="Workspace"
        >
            {toggleSidebar && (
                <Tooltip label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}>
                    <ActionIcon
                        variant="subtle"
                        size="md"
                        className="max-md:hidden"
                        aria-label="Toggle sidebar"
                        aria-pressed={sidebarVisible}
                        onClick={toggleSidebar.run}
                    >
                        {sidebarVisible ? (
                            <IconLayoutSidebarLeftCollapse size={17} />
                        ) : (
                            <IconLayoutSidebarLeftExpand size={17} />
                        )}
                    </ActionIcon>
                </Tooltip>
            )}
            {children}
        </nav>
    );
}
