import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import {
  IconBox,
  IconFileText,
  IconFolder,
  IconFolderPlus,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { Workspace } from '@httpreq/shared';
import { collectSubtree, findNode, isLeafNode } from '@httpreq/workspace';
import { AppModal } from '../AppModal';
import { useWorkbenchStore } from '../store';
import { closeSaveAsDialog, useSaveAsDialog } from './saveAsDialogStore';
import classes from './SaveAsDialog.module.css';

/** A place a request or folder can be filed: a collection, a folder, or (`id: null`) Drafts. */
interface Location {
  id: string | null;
  kind: 'collection' | 'folder' | 'drafts';
  name: string;
  depth: number;
  /** Ids of the containers above it, for filtering and the destination path. */
  ancestors: string[];
  path: string;
}

/** Every collection and folder, depth-first in explorer order. */
const listLocations = (workspace: Workspace): Location[] => {
  const byParent = new Map<string, Workspace['folders']>();
  for (const folder of workspace.folders) {
    const list = byParent.get(folder.parentId);
    if (list) list.push(folder);
    else byParent.set(folder.parentId, [folder]);
  }
  const result: Location[] = [];
  const visit = (parentId: string, depth: number, ancestors: string[], path: string) => {
    for (const folder of byParent.get(parentId) ?? []) {
      const folderPath = `${path} / ${folder.name}`;
      result.push({
        id: folder.id,
        kind: 'folder',
        name: folder.name,
        depth,
        ancestors,
        path: folderPath,
      });
      visit(folder.id, depth + 1, [...ancestors, folder.id], folderPath);
    }
  };
  for (const collection of workspace.collections) {
    result.push({
      id: collection.id,
      kind: 'collection',
      name: collection.name,
      depth: 0,
      ancestors: [],
      path: collection.name,
    });
    visit(collection.id, 1, [collection.id], collection.name);
  }
  return result;
};

const DRAFTS: Location = {
  id: null,
  kind: 'drafts',
  name: 'Drafts (no collection)',
  depth: 0,
  ancestors: [],
  path: 'Drafts',
};

const optionId = (id: string | null) => `save-location-${id ?? 'drafts'}`;

interface Props {
  /**
   * Files a request: renames and saves it into `parentId`. The dialog closes once it resolves;
   * the caller reports failures.
   */
  onSaveAs: (id: string, parentId: string, name: string) => Promise<void> | void;
}

/**
 * "Save as" and "Move to" for the collection tree: a name (when saving) and a location picker
 * listing every collection and folder. Locations a folder cannot move to (itself and its own
 * subfolders) are shown but disabled, so the hierarchy stays readable.
 */
export function SaveAsDialog({ onSaveAs }: Props) {
  const { opened, target } = useSaveAsDialog();
  const workspace = useWorkbenchStore((state) => state.workspace);
  const found = target ? findNode(workspace, target.id) : undefined;
  const node = found && found.kind !== 'collection' ? found : undefined;
  const mode = target?.mode ?? 'save-as';
  const saving = mode === 'save-as';

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState<'collection' | 'folder' | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const currentParent = node ? node.node.parentId : null;

  // Start from where the node is now each time the dialog opens.
  useEffect(() => {
    if (!opened || !node) return;
    setName(node.node.name);
    setSelected(currentParent ?? (saving ? workspace.collections[0]?.id : null));
    setFilter('');
    setCreating(null);
    setBusy(false);
    // Only when the dialog opens for a node, not on every workspace change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, target]);

  /** A folder cannot go into itself or anything beneath it. */
  const blocked = useMemo(
    () =>
      node?.kind === 'folder' ? collectSubtree(workspace, node.node.id).containers : new Set(),
    [workspace, node],
  );

  const locations = useMemo(() => {
    const all = listLocations(workspace);
    // Drafts holds requests only, and only when moving: "Save as" files into a collection.
    const withDrafts = !saving && node && isLeafNode(node) ? [DRAFTS, ...all] : all;
    const query = filter.trim().toLowerCase();
    if (!query) return withDrafts;
    const shown = new Set<string | null>();
    for (const location of withDrafts) {
      if (!location.path.toLowerCase().includes(query)) continue;
      shown.add(location.id);
      for (const ancestor of location.ancestors) shown.add(ancestor);
    }
    return withDrafts.filter((location) => shown.has(location.id));
  }, [workspace, saving, node, filter]);

  const allowed = (id: string | null | undefined): id is string | null => {
    if (id === undefined || (id !== null && blocked.has(id))) return false;
    if (id === null) return !saving && !!node && isLeafNode(node);
    return true;
  };
  const selectedLocation = locations.find((location) => location.id === selected);
  const unchanged = !saving && selected === currentParent;
  const canConfirmTo = (destination: string | null | undefined) =>
    !!node &&
    allowed(destination) &&
    (saving || destination !== currentParent) &&
    !busy &&
    (!saving || name.trim() !== '');
  const canConfirm = canConfirmTo(selected);

  const confirm = async (destination = selected) => {
    if (!node || !canConfirmTo(destination) || destination === undefined) return;
    if (saving) {
      if (destination === null) return;
      setBusy(true);
      try {
        await onSaveAs(node.node.id, destination, name);
      } finally {
        setBusy(false);
      }
    } else {
      useWorkbenchStore.getState().moveNode(node.node.id, destination);
    }
    closeSaveAsDialog();
  };

  const createLocation = () => {
    const label = newName.trim();
    if (!creating || !label) return;
    const store = useWorkbenchStore.getState();
    const parent = selected ?? null;
    if (creating === 'folder' && parent === null) return;
    const id = creating === 'collection' ? store.createCollection() : store.createFolder(parent!);
    // Named here rather than in the explorer's inline rename field.
    store.renameNode(id, label);
    store.setRenaming(null);
    setSelected(id);
    setCreating(null);
    setNewName('');
    requestAnimationFrame(() =>
      document.getElementById(optionId(id))?.scrollIntoView({ block: 'nearest' }),
    );
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void confirm();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    let index = locations.findIndex((location) => location.id === selected);
    for (let i = 0; i < locations.length; i += 1) {
      index += step;
      if (index < 0 || index >= locations.length) return;
      const next = locations[index]!;
      if (allowed(next.id)) {
        setSelected(next.id);
        document.getElementById(optionId(next.id))?.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
  };

  const kindLabel = node?.kind === 'folder' ? 'folder' : node ? 'request' : 'item';
  const title = saving
    ? node?.kind === 'websocket'
      ? 'Save WebSocket request'
      : 'Save request'
    : `Move ${kindLabel}`;

  return (
    <AppModal
      opened={opened && !!node}
      onClose={closeSaveAsDialog}
      title={title}
      size="md"
      footerStart={
        <Text size="xs" c="dimmed" className={classes.destination} truncate>
          {selectedLocation && allowed(selected)
            ? `${saving ? 'Save to' : 'Move to'}: ${selectedLocation.path}`
            : saving
              ? 'Choose a collection or folder'
              : 'Choose where to move it'}
        </Text>
      }
      footer={
        <>
          <Button variant="default" onClick={closeSaveAsDialog}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={!canConfirm} loading={busy}>
            {saving ? 'Save' : unchanged ? 'Already here' : 'Move'}
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        {saving && (
          <TextInput
            label="Name"
            value={name}
            data-autofocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void confirm();
              }
            }}
          />
        )}
        <div>
          <Group justify="space-between" mb={6} wrap="nowrap">
            <Text size="sm" fw={500} id="save-location-label">
              {saving ? 'Save to' : 'Move to'}
            </Text>
            <Group gap={4} wrap="nowrap">
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconFolderPlus size={13} />}
                disabled={typeof selected !== 'string'}
                onClick={() => {
                  setCreating('folder');
                  setNewName('');
                }}
              >
                New folder
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconPlus size={13} />}
                onClick={() => {
                  setCreating('collection');
                  setNewName('');
                }}
              >
                New collection
              </Button>
            </Group>
          </Group>
          {creating && (
            <TextInput
              size="xs"
              mb={6}
              autoFocus
              aria-label={creating === 'collection' ? 'New collection name' : 'New folder name'}
              placeholder={
                creating === 'collection'
                  ? 'Collection name, then Enter'
                  : `Folder in “${selectedLocation?.name ?? ''}”, then Enter`
              }
              value={newName}
              onChange={(event) => setNewName(event.currentTarget.value)}
              onBlur={() => !newName.trim() && setCreating(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  createLocation();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setCreating(null);
                }
              }}
            />
          )}
          {locations.length > 8 || filter ? (
            <TextInput
              size="xs"
              mb={6}
              aria-label="Filter locations"
              placeholder="Filter collections and folders…"
              leftSection={<IconSearch size={13} />}
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
          ) : null}
          <div
            role="listbox"
            tabIndex={0}
            aria-labelledby="save-location-label"
            aria-activedescendant={selected !== undefined ? optionId(selected) : undefined}
            className={classes.list}
            onKeyDown={onListKeyDown}
          >
            {locations.map((location) => {
              const disabled = !allowed(location.id);
              const Icon =
                location.kind === 'collection'
                  ? IconBox
                  : location.kind === 'folder'
                    ? IconFolder
                    : IconFileText;
              return (
                <div
                  key={location.id ?? 'drafts'}
                  id={optionId(location.id)}
                  role="option"
                  aria-selected={location.id === selected}
                  aria-disabled={disabled || undefined}
                  className={classes.option}
                  style={{ paddingLeft: 8 + location.depth * 14 }}
                  onClick={() => !disabled && setSelected(location.id)}
                  onDoubleClick={() => {
                    if (disabled) return;
                    setSelected(location.id);
                    void confirm(location.id);
                  }}
                >
                  <Icon size={14} className={classes.icon} aria-hidden />
                  <span className={classes.name}>{location.name}</span>
                  {location.id === currentParent && (
                    <Text span size="xs" c="dimmed">
                      current
                    </Text>
                  )}
                </div>
              );
            })}
            {locations.length === 0 && (
              <Text size="xs" c="dimmed" p="xs">
                {filter
                  ? `Nothing matches “${filter}”.`
                  : 'No collections yet. Create one to save into.'}
              </Text>
            )}
          </div>
        </div>
      </Stack>
    </AppModal>
  );
}
