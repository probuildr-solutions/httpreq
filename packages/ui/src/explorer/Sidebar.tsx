/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconDatabase,
    IconFolders,
    IconHistory,
    IconRouter,
    IconServer,
    IconVariable,
} from '@tabler/icons-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { SIDEBAR_WIDTH_VAR } from '../AppShell';
import { useCapabilities } from '../capabilities';
import { Tooltip, UnstyledButton, cx } from '../kit';
import { clampSidebarWidth, usePreferences } from '../preferences';
import { DbStudioPanel } from '../dbstudio/DbStudioPanel';
import { SshPanel } from '../ssh/SshPanel';
import { TunnelsPanel } from '../tunnels/TunnelsPanel';
import { DESKTOP_SIDEBAR_VIEWS, useWorkbenchStore, type SidebarView } from '../store';
import { CollectionsExplorer } from './CollectionsExplorer';
import { ContainerSettingsDialog } from './ContainerSettingsDialog';
import { EnvironmentsPanel } from './EnvironmentsPanel';
import { HistoryPanel } from './HistoryPanel';

interface ViewDefinition {
    id: SidebarView;
    label: string;
    icon: typeof IconFolders;
    /** Only shown when the platform supports it; the browser sees it disabled instead. */
    desktopOnly?: boolean;
    /** Needs this capability on top of being the desktop app (the add-on's own bridge). */
    requires?: 'databaseStudio';
}

const VIEWS: ViewDefinition[] = [
    { id: 'collections', label: 'Collections', icon: IconFolders },
    { id: 'environments', label: 'Environments', icon: IconVariable },
    { id: 'history', label: 'History', icon: IconHistory },
    { id: 'ssh', label: 'SSH', icon: IconServer, desktopOnly: true },
    { id: 'tunnels', label: 'Tunnels', icon: IconRouter, desktopOnly: true },
    {
        id: 'dbstudio',
        label: 'Database Studio',
        icon: IconDatabase,
        desktopOnly: true,
        requires: 'databaseStudio',
    },
];

const KEYBOARD_STEP = 16;

interface Props {
    onClearHistory: () => void;
    onRemoveHistory: (entryIds: string[]) => Promise<void>;
    /** Closes the navigation drawer on small screens after something was opened. */
    onNavigate?: () => void;
}

/** Activity rail + the selected view, with a resize handle on the right edge. */
export function Sidebar({ onClearHistory, onRemoveHistory, onNavigate }: Props) {
    const view = useWorkbenchStore((state) => state.sidebarView);
    const setView = useWorkbenchStore((state) => state.setSidebarView);
    const capabilities = useCapabilities();
    const desktopViews = capabilities.ssh;
    const isAvailable = (item: Pick<ViewDefinition, 'desktopOnly' | 'requires'>) =>
        (!item.desktopOnly || desktopViews) && (!item.requires || capabilities[item.requires]);

    // A stored view from a desktop session must not leave the browser on an empty panel.
    useEffect(() => {
        const current = VIEWS.find((item) => item.id === view);
        if (current && DESKTOP_SIDEBAR_VIEWS.includes(view) && !isAvailable(current)) {
            setView('collections');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- isAvailable only reads the two values below
    }, [desktopViews, capabilities.databaseStudio, setView, view]);
    const width = usePreferences((state) => state.sidebarWidth);
    const setWidth = usePreferences((state) => state.setSidebarWidth);
    const [settingsId, setSettingsId] = useState<string | null>(null);
    const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);

    // While dragging, only a CSS variable on the shell changes, so nothing re-renders; the width
    // is committed to preferences once, on release.
    const applyWidth = (next: number) => {
        document.documentElement.style.setProperty(SIDEBAR_WIDTH_VAR, `${next}px`);
    };
    const clearOverride = () => document.documentElement.style.removeProperty(SIDEBAR_WIDTH_VAR);

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width, width };
        document.body.dataset.resizing = 'col';
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        const next = clampSidebarWidth(
            drag.current.startWidth + event.clientX - drag.current.startX,
        );
        drag.current.width = next;
        applyWidth(next);
    };
    const onPointerUp = () => {
        if (!drag.current) return;
        setWidth(drag.current.width);
        drag.current = null;
        delete document.body.dataset.resizing;
        // Let the shell pick up the committed width before removing the temporary override.
        requestAnimationFrame(clearOverride);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setWidth(width + (event.key === 'ArrowRight' ? KEYBOARD_STEP : -KEYBOARD_STEP));
        }
    };

    return (
        <div className="relative flex h-full min-h-0">
            <nav
                className="flex flex-[0_0_44px] flex-col items-center gap-0.5 border-r border-line bg-titlebar py-1.5"
                aria-label="Sidebar views"
            >
                {VIEWS.map((item) => {
                    const unavailable = !isAvailable(item);
                    return (
                        <Tooltip
                            key={item.id}
                            label={unavailable ? `${item.label} (desktop app only)` : item.label}
                            position="right"
                        >
                            <UnstyledButton
                                className={cx(
                                    'relative grid size-9 place-items-center rounded-sm text-dimmed',
                                    'hover:not-data-[disabled]:bg-chrome-hover hover:not-data-[disabled]:text-fg',
                                    'data-[active]:text-fg data-[active]:before:absolute data-[active]:before:inset-y-2 data-[active]:before:-left-1 data-[active]:before:w-0.5 data-[active]:before:rounded-[1px] data-[active]:before:bg-primary data-[active]:before:content-[""]',
                                    'data-[disabled]:cursor-default data-[disabled]:opacity-45',
                                )}
                                data-active={(!unavailable && view === item.id) || undefined}
                                data-disabled={unavailable || undefined}
                                aria-label={
                                    unavailable ? `${item.label}, desktop app only` : item.label
                                }
                                aria-pressed={!unavailable && view === item.id}
                                aria-disabled={unavailable || undefined}
                                onClick={() => {
                                    if (!unavailable) setView(item.id);
                                }}
                            >
                                <item.icon size={19} stroke={1.6} />
                            </UnstyledButton>
                        </Tooltip>
                    );
                })}
                <div className="flex-1" />
            </nav>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {view === 'collections' && (
                    <CollectionsExplorer onOpenSettings={setSettingsId} onOpened={onNavigate} />
                )}
                {view === 'environments' && <EnvironmentsPanel onOpened={onNavigate} />}
                {view === 'history' && (
                    <HistoryPanel
                        onClear={onClearHistory}
                        onRemove={onRemoveHistory}
                        onOpened={onNavigate}
                    />
                )}
                {view === 'ssh' && desktopViews && <SshPanel onOpened={onNavigate} />}
                {view === 'tunnels' && desktopViews && <TunnelsPanel />}
                {view === 'dbstudio' && desktopViews && capabilities.databaseStudio && (
                    <DbStudioPanel />
                )}
            </div>

            <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                aria-valuemin={220}
                aria-valuemax={560}
                aria-valuenow={width}
                tabIndex={0}
                // A 6px hit area straddling the sidebar's edge; the accent line shows on hover, focus
                // and while dragging (the body carries `data-resizing`). Hidden where the sidebar is a
                // slide-over and cannot be resized.
                className="absolute inset-y-0 -right-[3px] z-[5] w-1.5 cursor-col-resize touch-none outline-none hover:resize-line focus-visible:resize-line in-data-[resizing=col]:resize-line max-md:hidden"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={onKeyDown}
                onDoubleClick={() => setWidth(300)}
            />
            <ContainerSettingsDialog nodeId={settingsId} onClose={() => setSettingsId(null)} />
        </div>
    );
}
