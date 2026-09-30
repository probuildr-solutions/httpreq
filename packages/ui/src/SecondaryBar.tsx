import { ActionIcon, Tooltip } from '@mantine/core';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { CommandMap } from './commands';
import classes from './SecondaryBar.module.css';

interface Props {
  toggleSidebar?: CommandMap[string];
  sidebarVisible: boolean;
  /** Items after the sidebar toggle, in order: the workspace menu first. */
  children: ReactNode;
}

/**
 * The navigation layer under the title bar, separated from it by a rule. It reads
 * `Sidebar toggle | Workspace menu | other items`, so workspace-level navigation never blends into
 * the OS or application menu.
 */
export function SecondaryBar({ toggleSidebar, sidebarVisible, children }: Props) {
  return (
    <nav className={classes.bar} aria-label="Workspace">
      {toggleSidebar && (
        <Tooltip label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="md"
            visibleFrom="sm"
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
