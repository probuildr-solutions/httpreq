/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ReactNode } from 'react';
import { Menu } from '../../kit';
import { closeTargets, type CloseMode, type StripTab } from './tabCommands';

export interface CloseTabsMenuProps {
    /** Where the menu opens (the pointer position of the context-menu event); null keeps it closed. */
    point: { x: number; y: number } | null;
    onClose: () => void;
    /** The tab the menu is for. */
    targetId: string | null;
    tabs: StripTab[];
    /** What the tabs are called, singular and plural: `Result` / `Results`. */
    noun: { one: string; many: string };
    /** Closes the given tabs, and says which command chose them. */
    onCloseTabs: (ids: string[], mode: CloseMode) => void;
    ariaLabel: string;
    /** More items below the close commands. */
    children?: ReactNode;
}

/**
 * The close commands every tab strip offers: this tab, the ones to its left and right, the others
 * and all of them. The same rules (`closeTargets`) and wording serve query tabs, result tabs and
 * any other strip, so they behave the same everywhere.
 */
export function CloseTabsMenu({
    point,
    onClose,
    targetId,
    tabs,
    noun,
    onCloseTabs,
    ariaLabel,
    children,
}: CloseTabsMenuProps) {
    const targets = (mode: 'left' | 'right' | 'others' | 'all') =>
        targetId ? closeTargets(tabs, targetId, mode) : [];
    const left = targets('left');
    const right = targets('right');
    const others = targets('others');
    const all = targets('all');
    return (
        <Menu opened={!!point && !!targetId} onClose={onClose} position="bottom-start" width={250}>
            <Menu.Target>
                <span
                    aria-hidden
                    className="fixed block size-0"
                    style={{ left: point?.x ?? 0, top: point?.y ?? 0 }}
                />
            </Menu.Target>
            {/* Named by its label: the anchor it would otherwise be labelled by is an empty marker. */}
            <Menu.Dropdown aria-label={ariaLabel} aria-labelledby={undefined}>
                <Menu.Item onClick={() => targetId && onCloseTabs([targetId], 'self')}>
                    Close {noun.one}
                </Menu.Item>
                <Menu.Item disabled={!left.length} onClick={() => onCloseTabs(left, 'left')}>
                    Close {noun.many} to the Left
                </Menu.Item>
                <Menu.Item disabled={!right.length} onClick={() => onCloseTabs(right, 'right')}>
                    Close {noun.many} to the Right
                </Menu.Item>
                <Menu.Item disabled={!others.length} onClick={() => onCloseTabs(others, 'others')}>
                    Close Other {noun.many}
                </Menu.Item>
                <Menu.Item disabled={!all.length} onClick={() => onCloseTabs(all, 'all')}>
                    Close All {noun.many}
                </Menu.Item>
                {children}
            </Menu.Dropdown>
        </Menu>
    );
}
