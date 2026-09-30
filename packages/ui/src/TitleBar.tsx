import { ActionIcon, Burger, Tooltip, UnstyledButton, useComputedColorScheme } from '@mantine/core';
import { IconMoon, IconSettings, IconSun } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { DesktopBridge, DesktopWindowState } from '@httpreq/shared';
import { AppLogo } from './AppLogo';
import type { CommandMap } from './commands';
import { MenuBar, type MenuDefinition } from './MenuBar';
import classes from './TitleBar.module.css';

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

/** Minimise, maximise/restore and close, drawn by the app on Windows and Linux. */
function WindowControls({ desktop, state }: { desktop: DesktopBridge; state: DesktopWindowState }) {
  const restore = state.maximized || state.fullscreen;
  return (
    <div className={classes.windowControls} role="group" aria-label="Window controls">
      <Tooltip label="Minimize">
        <UnstyledButton
          className={classes.windowButton}
          aria-label="Minimize"
          onClick={() => desktop.performAction('minimize')}
        >
          {MINIMIZE}
        </UnstyledButton>
      </Tooltip>
      <Tooltip label={restore ? 'Restore' : 'Maximize'}>
        <UnstyledButton
          className={classes.windowButton}
          aria-label={restore ? 'Restore' : 'Maximize'}
          onClick={() =>
            desktop.performAction(state.fullscreen ? 'toggle-fullscreen' : 'toggle-maximize')
          }
        >
          {restore ? RESTORE : MAXIMIZE}
        </UnstyledButton>
      </Tooltip>
      <Tooltip label="Close">
        <UnstyledButton
          className={`${classes.windowButton} ${classes.closeButton}`}
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
 * The bar is three zones. The outer two share the leftover space equally, which keeps the middle
 * one centred in the window at any width without taking it out of the flow — so it can never
 * overlap the menu, the window controls or the traffic lights, and simply gives up width (and
 * truncates) when the sides need it.
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
  const colorScheme = useComputedColorScheme('dark');
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
      className={classes.titleBar}
      data-desktop={desktop ? 'true' : undefined}
      data-mac={mac || undefined}
      data-fullscreen={windowState.fullscreen || undefined}
    >
      <div className={`${classes.side} ${classes.sideStart}`}>
        {desktop && mac && !windowState.fullscreen && <div className={classes.trafficLights} />}
        <Burger
          opened={mobileNavOpened}
          onClick={onToggleMobileNav}
          hiddenFrom="sm"
          size="xs"
          className={classes.noDrag}
          aria-label={mobileNavOpened ? 'Close navigation' : 'Open navigation'}
        />
        {/* The mark doubles as the way to the About dialog, so it is a real, focusable target. */}
        <Tooltip label={about?.label ?? 'HttpReq'}>
          <UnstyledButton
            className={classes.brand}
            aria-label={about?.label ?? 'HttpReq'}
            onClick={about?.run}
            disabled={!about}
          >
            <AppLogo size={20} />
            {(mac || !desktop) && <span className={classes.appName}>HttpReq</span>}
          </UnstyledButton>
        </Tooltip>
        {!mac && (
          <MenuBar menus={menus} commands={commands} mac={mac} altKeyNavigation={!!desktop} />
        )}
        <div className={classes.title} title={title}>
          {title}
        </div>
      </div>

      {center && <div className={classes.center}>{center}</div>}

      <div className={`${classes.side} ${classes.sideEnd}`}>
        <div className={classes.actions}>
          {toggleTheme && (
            <Tooltip label="Toggle color scheme">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="md"
                radius={0}
                aria-label="Toggle color scheme"
                onClick={toggleTheme.run}
              >
                {colorScheme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
              </ActionIcon>
            </Tooltip>
          )}
          {settings && (
            <Tooltip label="Settings">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="md"
                radius={0}
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
