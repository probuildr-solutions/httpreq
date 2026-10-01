/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { IconMenu2, IconMoon, IconSettings, IconSun, IconX } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { DesktopBridge, DesktopWindowState } from '@httpreq/shared';
import { AppLogo } from './AppLogo';
import type { CommandMap } from './commands';
import { ActionIcon, Tooltip, UnstyledButton, cx, useComputedColorScheme } from './kit';
import { MenuBar, type MenuDefinition } from './MenuBar';

interface Props {
    title: string;
    /** Centred in the bar, independently of what sits on either side: the workspace switcher. */
    center?: ReactNode;
    menus: MenuDefinition[];
    commands: CommandMap;
    mac: boolean;
    desktop?: DesktopBridge;
    mobileNavOpened: boolean;
    onToggleMobileNav: () => void;
}

/** Thin 10px glyphs, drawn to sit with the app's line icons rather than the OS caption font. */
const glyph = (path: ReactNode) => (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {path}
    </svg>
);
const MINIMIZE = glyph(<path d="M0 5.5h10" stroke="currentColor" />);
const MAXIMIZE = glyph(
    <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" fill="none" />,
);
const RESTORE = glyph(
    <>
        <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" fill="none" />
        <path
            d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"
            stroke="currentColor"
            fill="none"
        />
    </>,
);
const CLOSE = glyph(<path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />);

const WINDOW_BUTTON =
    'flex w-[46px] items-center justify-center text-inherit transition-colors hover:bg-chrome-hover active:bg-chrome-pressed focus-visible:outline-offset-[-2px]';

/** Minimise, maximise/restore and close, drawn by the app on Windows and Linux. */
function WindowControls({ desktop, state }: { desktop: DesktopBridge; state: DesktopWindowState }) {
    const restore = state.maximized || state.fullscreen;
    return (
        <div
            className="ml-1 flex flex-none items-stretch"
            role="group"
            aria-label="Window controls"
        >
            <Tooltip label="Minimize">
                <UnstyledButton
                    className={WINDOW_BUTTON}
                    aria-label="Minimize"
                    onClick={() => desktop.performAction('minimize')}
                >
                    {MINIMIZE}
                </UnstyledButton>
            </Tooltip>
            <Tooltip label={restore ? 'Restore' : 'Maximize'}>
                <UnstyledButton
                    className={WINDOW_BUTTON}
                    aria-label={restore ? 'Restore' : 'Maximize'}
                    onClick={() =>
                        desktop.performAction(
                            state.fullscreen ? 'toggle-fullscreen' : 'toggle-maximize',
                        )
                    }
                >
                    {restore ? RESTORE : MAXIMIZE}
                </UnstyledButton>
            </Tooltip>
            <Tooltip label="Close">
                <UnstyledButton
                    className={cx(
                        WINDOW_BUTTON,
                        'hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c] active:text-white',
                    )}
                    aria-label="Close"
                    onClick={() => desktop.performAction('close')}
                >
                    {CLOSE}
                </UnstyledButton>
            </Tooltip>
        </div>
    );
}

/**
 * Integrated title bar. In Electron it is the window's drag region, hosts the application menu
 * on Windows and Linux (macOS keeps its native global menu), and draws its own minimise,
 * maximise and close buttons there; macOS keeps the native traffic lights.
 *
 * The bar is three zones. The outer two share the leftover space equally (`flex: 1 1 0`), which
 * keeps the middle one centred in the window at any width without taking it out of the flow, so
 * it can never overlap the menu, the window controls or the traffic lights, and simply gives up
 * width (and truncates) when the sides need it. A side never shrinks below its content: the menu
 * buttons cannot wrap, so anything narrower would spill over the centre.
 */
export function TitleBar({
    title,
    center,
    menus,
    commands,
    mac,
    desktop,
    mobileNavOpened,
    onToggleMobileNav,
}: Props) {
    const colorScheme = useComputedColorScheme();
    const [windowState, setWindowState] = useState<DesktopWindowState>({
        maximized: false,
        zoomLevel: 0,
        fullscreen: false,
    });

    useEffect(() => {
        if (!desktop) return;
        void desktop.getWindowState().then((state) => state && setWindowState(state));
        return desktop.onWindowStateChange(setWindowState);
    }, [desktop]);

    const toggleTheme = commands['view.toggle-theme'];
    const settings = commands['tools.settings'];
    const about = commands['help.about'];

    return (
        <div
            className={cx(
                'flex h-full items-stretch gap-0.5 bg-titlebar text-titlebar-fg select-none',
                desktop && 'app-drag-region',
            )}
        >
            {/*
              The bar's inset is a margin on the first thing in the left zone, not padding on the
              zone: a flex item with `flex-basis: 0` cannot be narrower than its own padding, so
              padding would make the left zone wider than the right and push the centre off.
            */}
            <div className="flex min-w-min flex-[1_1_0] items-stretch gap-0.5 *:first:ml-2">
                {desktop && mac && !windowState.fullscreen && <div className="flex-[0_0_64px]" />}
                <ActionIcon
                    size="xs"
                    variant="subtle"
                    onClick={onToggleMobileNav}
                    className="app-no-drag self-center md:hidden"
                    aria-label={mobileNavOpened ? 'Close navigation' : 'Open navigation'}
                >
                    {mobileNavOpened ? <IconX size={16} /> : <IconMenu2 size={16} />}
                </ActionIcon>
                {/* The mark doubles as the way to the About dialog, so it is a real, focusable target. */}
                <Tooltip label={about?.label ?? 'HttpReq'}>
                    <UnstyledButton
                        className="flex h-7 items-center gap-2 self-center rounded-md px-2 text-inherit transition-colors hover:not-disabled:bg-chrome-hover focus-visible:outline-offset-[-2px]"
                        aria-label={about?.label ?? 'HttpReq'}
                        onClick={about?.run}
                        disabled={!about}
                    >
                        <AppLogo size={20} />
                        {(mac || !desktop) && (
                            <span className="text-[13px] font-semibold tracking-[0.01em]">
                                HttpReq
                            </span>
                        )}
                    </UnstyledButton>
                </Tooltip>
                {!mac && (
                    <MenuBar
                        menus={menus}
                        commands={commands}
                        mac={mac}
                        altKeyNavigation={!!desktop}
                    />
                )}
                {/*
                  The workspace name is in the centre zone, so the title reads from the left of it.
                  It takes whatever the left zone has left over and truncates; `w-0` keeps it out
                  of that zone's minimum width, so a long tab name can never push the centre off.
                */}
                <div
                    className="w-0 min-w-0 flex-auto self-center overflow-hidden px-2.5 text-xs text-ellipsis whitespace-nowrap opacity-80 max-md:hidden"
                    title={title}
                >
                    {title}
                </div>
            </div>

            {center && (
                <div className="flex min-w-0 flex-[0_1_auto] items-center justify-center px-2">
                    {center}
                </div>
            )}

            <div className="flex min-w-min flex-[1_1_0] items-stretch justify-end gap-0.5">
                <div className="flex items-stretch">
                    {toggleTheme && (
                        <Tooltip label="Toggle color scheme">
                            <ActionIcon
                                variant="subtle"
                                size={34}
                                className="h-auto! rounded-none"
                                aria-label="Toggle color scheme"
                                onClick={toggleTheme.run}
                            >
                                {colorScheme === 'dark' ? (
                                    <IconSun size={17} />
                                ) : (
                                    <IconMoon size={17} />
                                )}
                            </ActionIcon>
                        </Tooltip>
                    )}
                    {settings && (
                        <Tooltip label="Settings">
                            <ActionIcon
                                variant="subtle"
                                size={34}
                                className="h-auto! rounded-none"
                                aria-label="Settings"
                                onClick={settings.run}
                            >
                                <IconSettings size={17} />
                            </ActionIcon>
                        </Tooltip>
                    )}
                </div>
                {desktop && !mac && <WindowControls desktop={desktop} state={windowState} />}
            </div>
        </div>
    );
}
