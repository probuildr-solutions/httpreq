/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './kit';
import { Z_LAYERS } from './zLayers';

/** The CSS variable the sidebar's resize handle writes while dragging, so nothing re-renders. */
export const SIDEBAR_WIDTH_VAR = '--hr-sidebar-width';

interface Props {
    /** The title bar and the workspace row beneath it. */
    header: ReactNode;
    headerHeight: number;
    /** The sidebar. Absent while it has nothing to show. */
    navbar: ReactNode;
    navbarWidth: number;
    /** The sidebar is shown beside the content (wide windows). */
    navbarVisible: boolean;
    /** The sidebar is open as a slide-over (narrow windows). */
    navbarOpen: boolean;
    footer?: ReactNode;
    footerHeight: number;
    children: ReactNode;
}

/**
 * The application frame: a header across the top, an optional sidebar beside the content, and a
 * status bar along the bottom. The frame is exactly the window, so only the panes inside it
 * scroll and a large response can never make the window itself overflow.
 *
 * The height is the viewport divided by the page zoom: CSS zoom scales content but not viewport
 * units, so without the division a zoomed-in page would overflow the window.
 */
export function AppShell({
    header,
    headerHeight,
    navbar,
    navbarWidth,
    navbarVisible,
    navbarOpen,
    footer,
    footerHeight,
    children,
}: Props) {
    return (
        <div className="flex h-[calc(100dvh/var(--hr-zoom,1))] min-h-0 flex-col overflow-hidden bg-surface">
            {/* Above the sidebar so the menus drop down over it; below every dialog. */}
            <header
                className="relative flex-none overflow-visible bg-titlebar"
                style={{ height: headerHeight, zIndex: Z_LAYERS.header }}
            >
                {header}
            </header>

            <div className="relative flex min-h-0 flex-1">
                {/*
                 * The sidebar stays mounted and animates: wide windows collapse its width to
                 * zero, narrow ones slide it in over the content. Its content keeps a fixed
                 * width so it is clipped, not squeezed, while it moves; `visibility` flips at
                 * the end of a collapse, so hidden controls cannot take focus. The drag handle
                 * sticks out 3px, hence the clip margin. While the user drags the edge the
                 * width follows the pointer with no easing.
                 */}
                <aside
                    aria-label="Sidebar"
                    data-closed-wide={!navbarVisible || undefined}
                    data-closed-narrow={!navbarOpen || undefined}
                    className={cx(
                        'min-h-0 w-[var(--sidebar-w)] flex-none overflow-clip border-r border-line bg-chrome [overflow-clip-margin:4px]',
                        'transition-[width,translate,visibility] duration-[120ms] ease-out in-data-[resizing=col]:transition-none motion-reduce:transition-none',
                        'md:data-[closed-wide]:invisible md:data-[closed-wide]:w-0 md:data-[closed-wide]:border-r-0',
                        'max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-[140] max-md:max-w-full max-md:shadow-popup',
                        'max-md:data-[closed-narrow]:invisible max-md:data-[closed-narrow]:-translate-x-full',
                    )}
                    style={
                        {
                            '--sidebar-w': `var(${SIDEBAR_WIDTH_VAR}, ${navbarWidth}px)`,
                        } as CSSProperties
                    }
                >
                    <div className="h-full w-[var(--sidebar-w)] min-w-0 max-w-full">{navbar}</div>
                </aside>

                <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface">
                    {children}
                </main>
            </div>

            {footer && (
                <footer className="flex-none" style={{ height: footerHeight }}>
                    {footer}
                </footer>
            )}
        </div>
    );
}
