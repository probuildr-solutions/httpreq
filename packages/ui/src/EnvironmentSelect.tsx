import { Menu, UnstyledButton } from '@mantine/core';
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
import classes from './EnvironmentSelect.module.css';

const check = (checked: boolean) =>
  checked ? <IconCheck size={14} /> : <span style={{ width: 14 }} aria-hidden />;

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
    return id && !state.workspace.websocketRequests.some((socket) => socket.id === id) ? id : null;
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
    <Menu position="bottom-end" withinPortal shadow="md" width={240}>
      <Menu.Target>
        <UnstyledButton
          className={classes.trigger}
          aria-label={`Environment: ${label}. Select to change the active environment.`}
          // A name too long for the control is truncated, so the full one stays readable on hover.
          title={label}
          data-empty={!active || undefined}
        >
          <IconVariable size={14} aria-hidden className={classes.icon} />
          <span className={classes.name}>{label}</span>
          <IconChevronDown size={13} aria-hidden className={classes.chevron} />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Environment for this request</Menu.Label>
        <Menu.Item
          leftSection={check(!active)}
          aria-current={!active ? 'true' : undefined}
          onClick={() => choose(null)}
        >
          <span className={classes.itemName}>No environment</span>
        </Menu.Item>
        {environments.map((environment) => (
          <Menu.Item
            key={environment.id}
            leftSection={check(environment.id === active?.id)}
            aria-current={environment.id === active?.id ? 'true' : undefined}
            onClick={() => choose(environment.id)}
          >
            <span className={classes.itemName}>{environment.name}</span>
          </Menu.Item>
        ))}
        <Menu.Divider />
        {active && (
          <Menu.Item
            leftSection={<IconPencil size={14} />}
            onClick={() => useWorkbenchStore.getState().openEnvironmentTab(active.id)}
          >
            <span className={classes.itemName}>Edit “{active.name}”</span>
          </Menu.Item>
        )}
        <Menu.Item leftSection={<IconSettings size={14} />} onClick={manage}>
          Manage environments
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
});
