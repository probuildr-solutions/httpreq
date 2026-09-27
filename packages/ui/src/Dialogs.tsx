import {
  Anchor,
  Button,
  Group,
  Kbd,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  useMantineColorScheme,
  type MantineColorScheme,
} from '@mantine/core';
import { IconLayoutColumns, IconLayoutRows } from '@tabler/icons-react';
import { Fragment, useEffect, useState } from 'react';
import {
  DOCUMENTATION_URL,
  type AppInfo,
  type BuildInfo,
  type DesktopBridge,
} from '@httpreq/shared';
import { AppLogo } from './AppLogo';
import { AppModal } from './AppModal';
import type { CommandMap } from './commands';
import { DEFAULT_SPLIT_RATIO, usePreferences, type ResponsePosition } from './preferences';
import { formatChord, type KeyChord } from './shortcuts';
import { useUpdates, type UpdateInfo } from './updates';

interface ModalProps {
  opened: boolean;
  onClose: () => void;
}

export function SettingsDialog({ opened, onClose }: ModalProps) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const preferences = usePreferences();

  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      title="Settings"
      size="md"
      footerStart={
        <Button
          variant="default"
          onClick={() => {
            preferences.setSplitRatio('right', DEFAULT_SPLIT_RATIO.right);
            preferences.setSplitRatio('bottom', DEFAULT_SPLIT_RATIO.bottom);
          }}
        >
          Reset panel sizes
        </Button>
      }
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <Stack gap="lg">
        <Stack gap={6}>
          <Text size="sm" fw={600} id="settings-theme">
            Color theme
          </Text>
          <SegmentedControl
            aria-labelledby="settings-theme"
            value={colorScheme}
            onChange={(value) => setColorScheme(value as MantineColorScheme)}
            data={[
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
              { label: 'System', value: 'auto' },
            ]}
          />
        </Stack>
        <Stack gap={6}>
          <Text size="sm" fw={600} id="settings-layout">
            Response panel position
          </Text>
          <SegmentedControl
            aria-labelledby="settings-layout"
            value={preferences.responsePosition}
            onChange={(value) => preferences.setResponsePosition(value as ResponsePosition)}
            data={[
              {
                value: 'right',
                label: (
                  <Group gap={6} justify="center" wrap="nowrap">
                    <IconLayoutColumns size={15} aria-hidden /> Right
                  </Group>
                ),
              },
              {
                value: 'bottom',
                label: (
                  <Group gap={6} justify="center" wrap="nowrap">
                    <IconLayoutRows size={15} aria-hidden /> Bottom
                  </Group>
                ),
              },
            ]}
          />
          <Text size="xs" c="dimmed">
            Applies to every open and new request.
          </Text>
        </Stack>
        <Switch
          label="Show sidebar"
          checked={preferences.sidebarVisible}
          onChange={preferences.toggleSidebar}
        />
        <Switch
          label="Show status bar"
          checked={preferences.statusBarVisible}
          onChange={preferences.toggleStatusBar}
        />
      </Stack>
    </AppModal>
  );
}

interface ShortcutRow {
  label: string;
  keys: string[];
}

const staticRows = (mac: boolean): { group: string; rows: ShortcutRow[] }[] => [
  {
    group: 'Request tabs (when the tab list has focus)',
    rows: [
      { label: 'Move between tabs', keys: ['←', '→'] },
      { label: 'First / last tab', keys: ['Home', 'End'] },
      { label: 'Open the focused tab', keys: ['Enter', 'Space'] },
      { label: 'Close the focused tab', keys: [mac ? '⌦' : 'Delete'] },
    ],
  },
  {
    group: 'General',
    rows: [
      { label: 'Close menu or dialog', keys: ['Esc'] },
      ...(mac ? [] : [{ label: 'Focus the application menu (desktop)', keys: ['Alt'] }]),
    ],
  },
];

export function ShortcutsDialog({
  opened,
  onClose,
  commands,
  mac,
  web,
}: ModalProps & { commands: CommandMap; mac: boolean; web: boolean }) {
  const chord = (value: KeyChord) => formatChord(value, mac);
  const commandRows: ShortcutRow[] = Object.entries(commands)
    .filter(([id, command]) => command.shortcut?.length && !id.startsWith('request.goto-'))
    .map(([, command]) => ({ label: command.label, keys: command.shortcut!.map(chord) }));
  commandRows.push({
    label: 'Go to request 1–9',
    keys: [`${chord({ key: '1', mod: true })} … ${chord({ key: '9', mod: true })}`],
  });

  const groups = [{ group: 'Commands', rows: commandRows }, ...staticRows(mac)];

  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      title="Keyboard shortcuts"
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {web && (
        <Text size="xs" c="dimmed" mb="sm">
          Browsers reserve some combinations (such as {chord({ key: 't', mod: true })},{' '}
          {chord({ key: 'w', mod: true })} and {chord({ key: 'Tab', ctrl: true })}); those work in
          the desktop app.
        </Text>
      )}
      <Table verticalSpacing={4} fz="sm">
        <Table.Tbody>
          {groups.map(({ group, rows }) => (
            <Fragment key={group}>
              <Table.Tr>
                <Table.Th colSpan={2} pt="md">
                  {group}
                </Table.Th>
              </Table.Tr>
              {rows.map((row) => (
                <Table.Tr key={`${group}-${row.label}`}>
                  <Table.Td>{row.label}</Table.Td>
                  <Table.Td ta="right">
                    <Group gap={4} justify="flex-end" wrap="wrap">
                      {row.keys.map((key) => (
                        <Kbd key={key} size="xs">
                          {key}
                        </Kbd>
                      ))}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Fragment>
          ))}
        </Table.Tbody>
      </Table>
    </AppModal>
  );
}

const buildDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/** "Up to date", "Checking…" or the available update, with the way to get it. */
function UpdateStatusLine({
  onCheck,
  onApply,
}: {
  onCheck: () => Promise<void>;
  onApply?: (update: UpdateInfo) => void;
}) {
  const status = useUpdates((state) => state.status);
  const update = useUpdates((state) => state.update);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      await onCheck();
    } finally {
      setChecking(false);
    }
  };
  return (
    <Stack gap={6} align="center" mt="xs">
      {update ? (
        <Text size="sm" c="violet" fw={600}>
          Version {update.version} is available.
        </Text>
      ) : status === 'current' ? (
        <Text size="xs" c="dimmed">
          HttpReq is up to date.
        </Text>
      ) : status === 'error' ? (
        <Text size="xs" c="dimmed">
          The last update check did not complete.
        </Text>
      ) : null}
      <Group gap="xs" justify="center">
        {update && onApply && (
          <Button size="xs" onClick={() => onApply(update)}>
            {update.kind === 'deployment' ? 'Reload to update' : 'Download update'}
          </Button>
        )}
        <Button
          size="xs"
          variant="default"
          loading={checking || status === 'checking'}
          onClick={() => void check()}
        >
          Check for updates
        </Button>
      </Group>
    </Stack>
  );
}

export function AboutDialog({
  opened,
  onClose,
  version,
  build,
  desktop,
  onOpenDocumentation,
  onCheckForUpdates,
  onApplyUpdate,
}: ModalProps & {
  version?: string;
  build?: BuildInfo;
  desktop?: DesktopBridge;
  onOpenDocumentation: () => void;
  onCheckForUpdates?: () => Promise<void>;
  onApplyUpdate?: (update: UpdateInfo) => void;
}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (opened && desktop && !info) void desktop.getAppInfo().then(setInfo);
  }, [opened, desktop, info]);

  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      title="About HttpReq"
      size="sm"
      centered
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Stack align="center" gap="xs" ta="center">
        <AppLogo size={56} />
        <Text fw={700} size="lg">
          HttpReq
        </Text>
        <Text size="sm" c="dimmed">
          Local-first API client · version {version ?? info?.version ?? 'unknown'}
        </Text>
        {build && build.commit !== 'dev' && (
          <Text size="xs" c="dimmed" ff="monospace">
            Build {build.commit} · {buildDate(build.builtAt)}
          </Text>
        )}
        {info && (
          <Text size="xs" c="dimmed" ff="monospace">
            Electron {info.versions.electron} · Chromium {info.versions.chrome} · Node{' '}
            {info.versions.node} · {info.platform}
          </Text>
        )}
        {!desktop && (
          <Text size="xs" c="dimmed">
            Running in the browser
          </Text>
        )}
        <Anchor
          size="sm"
          href={DOCUMENTATION_URL}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            onOpenDocumentation();
          }}
        >
          Documentation
        </Anchor>
        {onCheckForUpdates && (
          <UpdateStatusLine onCheck={onCheckForUpdates} onApply={onApplyUpdate} />
        )}
      </Stack>
    </AppModal>
  );
}
