import { ActionIcon, CloseButton, Menu, Text, TextInput, Tooltip } from '@mantine/core';
import {
  IconBolt,
  IconBox,
  IconChevronRight,
  IconCopy,
  IconDots,
  IconDownload,
  IconFileImport,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFold,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import { flushSync } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { collectSubtree, findNode, getAncestors, isLeafNode } from '@httpreq/workspace';
import { confirmAction } from '../confirm';
import { openExportDialog } from '../export/exportDialogStore';
import { openImportDialog } from '../import/importDialogStore';
import { isLeafRow, methodColor } from '../methods';
import { useWorkbenchStore } from '../store';
import { buildRows, type TreeRow } from './rows';
import { PanelHeader } from './PanelHeader';
import { BulkDeleteButton, RowCheckbox, SelectionBar, SelectModeButton } from './Selection';
import { useSelection } from './useSelection';
import classes from './Sidebar.module.css';

const DRAG_TYPE = 'application/x-httpreq-node';
const INDENT = 12;

interface Props {
  onOpenSettings: (id: string) => void;
  /** Called after a request is opened (e.g. to close the mobile drawer). */
  onOpened?: () => void;
}

const treeItemId = (id: string) => `explorer-${id}`;

/** Rows are a fixed height (see `.row` in Sidebar.module.css), which is what makes windowing cheap. */
const ROW_HEIGHT = 26;
/** Trees up to this size render every row; larger ones render only what is on screen. */
const VIRTUALIZE_AFTER = 150;
const OVERSCAN = 12;

/**
 * Everything a row can ask the explorer to do, as one object whose identity never changes. Rows
 * are memoized, and passing fresh closures to every row (as this used to) re-rendered every row,
 * each with its own menu and tooltip, on every keystroke anywhere in the app.
 */
interface RowHandlers {
  open: (row: TreeRow) => void;
  /** Selection mode: checks or unchecks a row. */
  check: (id: string) => void;
  focus: (id: string) => void;
  menuChange: (id: string, opened: boolean) => void;
  rename: (id: string, name: string) => void;
  cancelRename: () => void;
  startRename: (id: string) => void;
  newRequest: (id: string) => void;
  newWebSocket: (id: string) => void;
  newFolder: (id: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  settings: (id: string) => void;
  exportNode: (id: string) => void;
  dragStart: (row: TreeRow, event: DragEvent) => void;
  dragEnd: () => void;
  dragOver: (target: TreeRow | 'drafts', key: string, event: DragEvent) => void;
  dragLeave: (key: string, event: DragEvent) => void;
  drop: (target: TreeRow | 'drafts', event: DragEvent) => void;
}

const ROW_FIELDS: readonly (keyof TreeRow)[] = [
  'id',
  'kind',
  'name',
  'depth',
  'parentId',
  'method',
  'url',
  'hasChildren',
  'expanded',
];
const sameRow = (a: TreeRow, b: TreeRow) => ROW_FIELDS.every((field) => a[field] === b[field]);

export function CollectionsExplorer({ onOpenSettings, onOpened }: Props) {
  const workspace = useWorkbenchStore((state) => state.workspace);
  // Only which requests have drafts matters here, not what is in them: typing must not re-render
  // the tree.
  const unsavedIds = useWorkbenchStore(useShallow((state) => Object.keys(state.drafts)));
  const expandedIds = useWorkbenchStore((state) => state.expandedIds);
  const selectedId = useWorkbenchStore((state) => state.selectedNodeId);
  const activeId = useWorkbenchStore((state) => state.activeRequestId);
  const renamingId = useWorkbenchStore((state) => state.renamingId);
  const revealNonce = useWorkbenchStore((state) => state.revealNonce);
  const actions = useWorkbenchStore.getState;

  const [filter, setFilter] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  const unsaved = useMemo(() => new Set(unsavedIds), [unsavedIds]);

  // Rows that did not change keep their identity, so a rename or a move re-renders one row, not
  // the whole tree.
  const rowCache = useRef(new Map<string, TreeRow>());
  const { collections, drafts: draftRows } = useMemo(() => {
    const built = buildRows(workspace, expandedIds, filter);
    const previous = rowCache.current;
    const next = new Map<string, TreeRow>();
    const keep = (row: TreeRow) => {
      const old = previous.get(row.id);
      const kept = old && sameRow(old, row) ? old : row;
      next.set(row.id, kept);
      return kept;
    };
    const result = { collections: built.collections.map(keep), drafts: built.drafts.map(keep) };
    rowCache.current = next;
    return result;
  }, [workspace, expandedIds, filter]);
  const rows = useMemo(() => [...collections, ...draftRows], [collections, draftRows]);
  // Select all takes the rows that are listed: a filter narrows it, collapsed children are
  // covered by their collection or folder.
  const selection = useSelection(useMemo(() => rows.map((row) => row.id), [rows]));
  const rovingId = rows.some((row) => row.id === focusedId)
    ? focusedId
    : rows.some((row) => row.id === selectedId)
      ? selectedId
      : (rows[0]?.id ?? null);

  /* ---------- Windowing ---------- */

  const virtual = collections.length > VIRTUALIZE_AFTER;
  useEffect(() => {
    const element = treeRef.current;
    if (!virtual || !element) return;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtual]);
  const scrollFrame = useRef(0);
  const onScroll = () => {
    const element = treeRef.current;
    if (!element || scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    });
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  const windowStart = virtual ? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN) : 0;
  const windowEnd = virtual
    ? Math.min(
        collections.length,
        Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN,
      )
    : collections.length;

  /** Scrolls a windowed row into the rendered range, so it is in the DOM to be focused. */
  const bringIntoWindow = (id: string) => {
    const element = treeRef.current;
    const index = collections.findIndex((row) => row.id === id);
    if (!virtual || !element || index < 0) return;
    const top = index * ROW_HEIGHT;
    let scrollTop = element.scrollTop;
    if (top < scrollTop) scrollTop = top;
    else if (top + ROW_HEIGHT > scrollTop + element.clientHeight) {
      scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
    if (scrollTop === element.scrollTop && index >= windowStart && index < windowEnd) return;
    element.scrollTop = scrollTop;
    flushSync(() => setViewport({ top: scrollTop, height: element.clientHeight }));
  };

  const focusRow = (id: string) => {
    bringIntoWindow(id);
    setFocusedId(id);
    document.getElementById(treeItemId(id))?.focus();
  };

  // Breadcrumb navigation asks the explorer to reveal and focus a node.
  const reveal = useRef(bringIntoWindow);
  reveal.current = bringIntoWindow;
  useEffect(() => {
    if (!revealNonce || !selectedId) return;
    const frame = requestAnimationFrame(() => {
      reveal.current(selectedId);
      const element = document.getElementById(treeItemId(selectedId));
      element?.scrollIntoView({ block: 'nearest' });
      element?.focus({ preventScroll: true });
      setFocusedId(selectedId);
    });
    return () => cancelAnimationFrame(frame);
  }, [revealNonce, selectedId]);

  const open = (row: TreeRow) => {
    if (isLeafRow(row.kind)) {
      actions().openRequest(row.id);
      onOpened?.();
    } else {
      actions().selectNode(row.id);
      actions().toggleExpanded(row.id);
    }
  };

  const remove = async (id: string) => {
    const { workspace: current, drafts } = actions();
    const node = findNode(current, id);
    if (!node) return;
    const subtree = collectSubtree(current, id);
    const requests = new Set([...subtree.requests, ...subtree.websockets]);
    const count = isLeafNode(node) ? 0 : requests.size;
    const unsavedCount = [...requests].filter((requestId) => drafts[requestId]).length;
    const result = await confirmAction({
      title: `Delete ${node.kind === 'websocket' ? 'WebSocket request' : node.kind}`,
      message:
        `Delete “${node.node.name}”` +
        (count ? ` and the ${count} request${count === 1 ? '' : 's'} inside it` : '') +
        '? This cannot be undone.' +
        (unsavedCount
          ? ` ${unsavedCount} open request${unsavedCount === 1 ? ' has' : 's have'} unsaved changes.`
          : ''),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (result === 'confirm') actions().deleteNode(id);
  };

  /**
   * Deletes the checked items. A checked item inside a checked collection or folder goes with its
   * container, so it is neither deleted twice nor counted twice.
   */
  const removeSelected = async () => {
    const { workspace: current, drafts } = actions();
    const checked = new Set(selection.ids);
    const roots = selection.ids.filter(
      (id) => !getAncestors(current, id).some((ancestor) => checked.has(ancestor.node.id)),
    );
    if (roots.length === 0) return;
    const requests = new Set<string>();
    for (const id of roots) {
      const node = findNode(current, id);
      if (!node) continue;
      if (isLeafNode(node)) requests.add(id);
      else {
        const subtree = collectSubtree(current, id);
        for (const requestId of [...subtree.requests, ...subtree.websockets])
          requests.add(requestId);
      }
    }
    const unsavedCount = [...requests].filter((requestId) => drafts[requestId]).length;
    const containers = roots.length - roots.filter((id) => requests.has(id)).length;
    const parts = [
      containers &&
        `${containers} collection${containers === 1 ? '' : 's'} or folder${containers === 1 ? '' : 's'}`,
      requests.size && `${requests.size} request${requests.size === 1 ? '' : 's'}`,
    ].filter(Boolean);
    const result = await confirmAction({
      title: `Delete ${roots.length} item${roots.length === 1 ? '' : 's'}`,
      message:
        `Delete ${parts.join(' and ')}? This cannot be undone.` +
        (unsavedCount
          ? ` ${unsavedCount} open request${unsavedCount === 1 ? ' has' : 's have'} unsaved changes.`
          : ''),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (result !== 'confirm') return;
    for (const id of roots) actions().deleteNode(id);
    selection.stop();
  };

  const exportNode = (id: string) => openExportDialog({ kind: 'collection', id });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const index = rows.findIndex((row) => row.id === rovingId);
    const row = rows[index];
    if (!row) return;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'ArrowDown':
        handled();
        if (rows[index + 1]) focusRow(rows[index + 1]!.id);
        break;
      case 'ArrowUp':
        handled();
        if (rows[index - 1]) focusRow(rows[index - 1]!.id);
        break;
      case 'Home':
        handled();
        focusRow(rows[0]!.id);
        break;
      case 'End':
        handled();
        focusRow(rows[rows.length - 1]!.id);
        break;
      case 'ArrowRight':
        handled();
        if (!isLeafRow(row.kind) && !row.expanded && row.hasChildren)
          actions().toggleExpanded(row.id, true);
        else if (row.expanded && rows[index + 1]) focusRow(rows[index + 1]!.id);
        break;
      case 'ArrowLeft':
        handled();
        if (!isLeafRow(row.kind) && row.expanded && !filter)
          actions().toggleExpanded(row.id, false);
        else if (row.parentId && rows.some((item) => item.id === row.parentId))
          focusRow(row.parentId);
        break;
      case 'Enter':
      case ' ':
        handled();
        if (selection.selecting) selection.toggle(row.id);
        else open(row);
        break;
      case 'F2':
        handled();
        if (!selection.selecting) actions().setRenaming(row.id);
        break;
      case 'Delete':
        handled();
        if (selection.selecting) void removeSelected();
        else void remove(row.id);
        break;
    }
  };

  /* Drag and drop: onto a container moves inside it; onto a request moves next to it. */
  const canDrop = (target: TreeRow | 'drafts') => {
    const source = dragged.current;
    if (!source) return false;
    const current = actions().workspace;
    const node = findNode(current, source);
    if (!node) return false;
    if (target === 'drafts') return isLeafNode(node);
    if (target.id === source) return false;
    if (node.kind === 'collection') return target.kind === 'collection';
    if (node.kind === 'folder') {
      const destination = isLeafRow(target.kind) ? target.parentId : target.id;
      return !!destination && !collectSubtree(current, source).containers.has(destination);
    }
    return true;
  };

  const onDrop = (target: TreeRow | 'drafts') => {
    const source = dragged.current;
    dragged.current = null;
    setDrop(null);
    if (!source || !canDrop(target)) return;
    const node = findNode(actions().workspace, source)!;
    if (target === 'drafts') actions().moveNode(source, null);
    else if (node.kind === 'collection') actions().moveNode(source, null, target.id);
    else if (isLeafRow(target.kind)) actions().moveNode(source, target.parentId, target.id);
    else actions().moveNode(source, target.id);
  };

  // Created once; each handler calls through to the closures of the latest render, so the object
  // stays stable without going stale.
  const latest = useRef({ open, remove, exportNode, canDrop, onDrop, onOpenSettings, selection });
  latest.current = { open, remove, exportNode, canDrop, onDrop, onOpenSettings, selection };
  const handlers = useMemo<RowHandlers>(
    () => ({
      open: (row) => latest.current.open(row),
      check: (id) => latest.current.selection.toggle(id),
      focus: setFocusedId,
      menuChange: (id, opened) =>
        setMenuFor((current) => (opened ? id : current === id ? null : current)),
      rename: (id, name) => actions().renameNode(id, name),
      cancelRename: () => actions().setRenaming(null),
      startRename: (id) => actions().setRenaming(id),
      newRequest: (id) => actions().createRequest(id),
      newWebSocket: (id) => actions().createWebSocketRequest(id),
      newFolder: (id) => actions().createFolder(id),
      duplicate: (id) => actions().duplicateNode(id),
      remove: (id) => void latest.current.remove(id),
      settings: (id) => latest.current.onOpenSettings(id),
      exportNode: (id) => latest.current.exportNode(id),
      dragStart: (row, event) => {
        dragged.current = row.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(DRAG_TYPE, row.id);
      },
      dragEnd: () => {
        dragged.current = null;
        setDrop(null);
      },
      dragOver: (target, key, event) => {
        if (!latest.current.canDrop(target)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDrop((current) => (current === key ? current : key));
      },
      dragLeave: (key, event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setDrop((current) => (current === key ? null : current));
      },
      drop: (target, event) => {
        event.preventDefault();
        latest.current.onDrop(target);
      },
    }),
    [actions],
  );

  const renderRow = (row: TreeRow) => (
    <ExplorerRow
      key={row.id}
      row={row}
      selected={row.id === selectedId}
      active={row.id === activeId}
      tabbable={row.id === rovingId}
      unsaved={unsaved.has(row.id)}
      renaming={row.id === renamingId}
      anyRenaming={renamingId !== null}
      dropTarget={drop === row.id}
      menuOpen={menuFor === row.id}
      selecting={selection.selecting}
      checked={selection.selecting && selection.isSelected(row.id)}
      handlers={handlers}
    />
  );

  // When the row holding the tab stop is scrolled out of the window, the tree itself takes the
  // tab stop and passes focus on to that row, so keyboard users can always get back in.
  const rovingIndex = collections.findIndex((row) => row.id === rovingId);
  const rovingOutside =
    virtual && rovingIndex >= 0 && (rovingIndex < windowStart || rovingIndex >= windowEnd);

  return (
    <div className={classes.explorer}>
      <PanelHeader title="Collections">
        <SelectModeButton selection={selection} noun="collections and requests" />
        <Tooltip label="New collection">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="New collection"
            onClick={() => actions().createCollection()}
          >
            <IconPlus size={15} />
          </ActionIcon>
        </Tooltip>
        <Menu position="bottom-end" withinPortal shadow="md">
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Collection actions">
              <IconDots size={15} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconBox size={14} />}
              onClick={() => actions().createCollection()}
            >
              New collection
            </Menu.Item>
            <Menu.Item
              leftSection={<IconPlus size={14} />}
              onClick={() => {
                actions().createRequest(null);
                onOpened?.();
              }}
            >
              New draft request
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item
              leftSection={<IconFileImport size={14} />}
              onClick={() => openImportDialog('files')}
            >
              Import files or folders…
            </Menu.Item>
            <Menu.Item
              leftSection={<IconTerminal2 size={14} />}
              onClick={() => openImportDialog('curl')}
            >
              Import from cURL…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item
              leftSection={<IconFold size={14} />}
              onClick={() => useWorkbenchStore.setState({ expandedIds: new Set() })}
            >
              Collapse all
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </PanelHeader>
      <SelectionBar selection={selection} label="Collection selection">
        <BulkDeleteButton
          selection={selection}
          noun="items"
          onDelete={() => void removeSelected()}
        />
      </SelectionBar>

      <TextInput
        size="xs"
        mx={8}
        my={6}
        aria-label="Filter collections"
        placeholder="Search requests…"
        leftSection={<IconSearch size={14} />}
        value={filter}
        onChange={(event) => setFilter(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setFilter('');
          if (event.key === 'ArrowDown' && rows[0]) {
            event.preventDefault();
            focusRow(rows[0].id);
          }
        }}
        rightSection={
          filter ? (
            <CloseButton size="xs" aria-label="Clear filter" onClick={() => setFilter('')} />
          ) : null
        }
      />

      <div
        ref={treeRef}
        role="tree"
        aria-label="Collections"
        className={classes.tree}
        onKeyDown={onKeyDown}
        onScroll={virtual ? onScroll : undefined}
        tabIndex={rovingOutside ? 0 : undefined}
        onFocus={(event) => {
          if (rovingOutside && rovingId && event.target === event.currentTarget) focusRow(rovingId);
        }}
      >
        {windowStart > 0 && <div style={{ height: windowStart * ROW_HEIGHT }} aria-hidden />}
        {collections.slice(windowStart, windowEnd).map(renderRow)}
        {windowEnd < collections.length && (
          <div style={{ height: (collections.length - windowEnd) * ROW_HEIGHT }} aria-hidden />
        )}
        {workspace.collections.length === 0 && !filter && (
          <div className={classes.emptyTree}>
            <Text size="xs" c="dimmed">
              Collections group requests into folders that can share authorization.
            </Text>
            <ActionIcon.Group>
              <Tooltip label="New collection">
                <ActionIcon
                  variant="light"
                  aria-label="Create a collection"
                  onClick={() => actions().createCollection()}
                >
                  <IconPlus size={15} />
                </ActionIcon>
              </Tooltip>
            </ActionIcon.Group>
          </div>
        )}

        <div
          className={classes.sectionHeading}
          data-drop={drop === 'drafts' || undefined}
          onDragOver={(event) => handlers.dragOver('drafts', 'drafts', event)}
          onDragLeave={(event) => handlers.dragLeave('drafts', event)}
          onDrop={(event) => handlers.drop('drafts', event)}
          role="presentation"
        >
          Drafts
        </div>
        {draftRows.map(renderRow)}
        {draftRows.length === 0 && (
          <Text size="xs" c="dimmed" px={12} py={4}>
            {filter ? 'No matching drafts.' : 'Requests not saved in a collection appear here.'}
          </Text>
        )}
        {filter && rows.length === 0 && (
          <Text size="xs" c="dimmed" px={12} py={8}>
            Nothing matches “{filter}”.
          </Text>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  row: TreeRow;
  selected: boolean;
  active: boolean;
  tabbable: boolean;
  unsaved: boolean;
  renaming: boolean;
  /** Whether any row (this one or, after "New folder", a new one) is being renamed. */
  anyRenaming: boolean;
  dropTarget: boolean;
  menuOpen: boolean;
  /** Selection mode: rows show a checkbox and a click checks them instead of opening them. */
  selecting: boolean;
  checked: boolean;
  handlers: RowHandlers;
}

const ExplorerRow = memo(function ExplorerRow({
  row,
  selected,
  active,
  tabbable,
  unsaved,
  renaming,
  anyRenaming,
  dropTarget,
  menuOpen,
  selecting,
  checked,
  handlers,
}: RowProps) {
  const container = !isLeafRow(row.kind);
  const [name, setName] = useState(row.name);
  useEffect(() => {
    if (renaming) setName(row.name);
  }, [renaming, row.name]);

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    handlers.menuChange(row.id, true);
  };

  const Icon = row.kind === 'collection' ? IconBox : row.expanded ? IconFolderOpen : IconFolder;

  return (
    <div
      id={treeItemId(row.id)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={container ? row.expanded : undefined}
      aria-current={active ? 'page' : undefined}
      tabIndex={tabbable ? 0 : -1}
      className={classes.row}
      data-selected={(selecting ? checked : selected) || undefined}
      data-drop={dropTarget || undefined}
      style={{ paddingLeft: 6 + row.depth * INDENT }}
      onClick={() => (selecting ? handlers.check(row.id) : handlers.open(row))}
      onFocus={(event) => event.target === event.currentTarget && handlers.focus(row.id)}
      onContextMenu={selecting ? undefined : onContextMenu}
      onDoubleClick={(event) => {
        if (!selecting && isLeafRow(row.kind)) {
          event.preventDefault();
          handlers.startRename(row.id);
        }
      }}
      title={row.url ? `${row.kind === 'websocket' ? 'WS' : row.method} ${row.url}` : row.name}
      draggable={!renaming && !selecting}
      onDragStart={(event) => handlers.dragStart(row, event)}
      onDragEnd={handlers.dragEnd}
      onDragOver={(event) => handlers.dragOver(row, row.id, event)}
      onDragLeave={(event) => handlers.dragLeave(row.id, event)}
      onDrop={(event) => handlers.drop(row, event)}
    >
      {selecting && (
        <RowCheckbox checked={checked} label={row.name} onChange={() => handlers.check(row.id)} />
      )}
      <span
        className={classes.chevron}
        data-open={row.expanded || undefined}
        aria-hidden
        onClick={
          selecting && container
            ? (event) => {
                event.stopPropagation();
                handlers.open(row);
              }
            : undefined
        }
      >
        {container && row.hasChildren && <IconChevronRight size={13} />}
      </span>
      {row.kind === 'request' ? (
        <span
          className={classes.method}
          style={{ color: `var(--mantine-color-${methodColor[row.method!]}-text)` }}
        >
          {row.method === 'DELETE' ? 'DEL' : row.method === 'OPTIONS' ? 'OPT' : row.method}
        </span>
      ) : row.kind === 'websocket' ? (
        <span className={classes.method} style={{ color: 'var(--mantine-color-violet-text)' }}>
          WS
        </span>
      ) : (
        <Icon size={15} className={classes.nodeIcon} aria-hidden />
      )}
      {renaming ? (
        <TextInput
          size="xs"
          className={classes.renameInput}
          aria-label={`Rename ${row.name}`}
          value={name}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setName(event.currentTarget.value)}
          onBlur={() => handlers.rename(row.id, name)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') handlers.rename(row.id, name);
            if (event.key === 'Escape') handlers.cancelRename();
          }}
        />
      ) : (
        <span className={classes.rowName}>{row.name}</span>
      )}
      {unsaved && <span className={classes.unsavedDot} aria-label="unsaved changes" />}

      <span
        className={classes.rowActions}
        data-open={menuOpen || undefined}
        hidden={selecting}
        onClick={(event) => event.stopPropagation()}
      >
        {container && (
          <Tooltip label="New request">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="xs"
              tabIndex={-1}
              aria-label={`New request in ${row.name}`}
              onClick={() => handlers.newRequest(row.id)}
            >
              <IconPlus size={13} />
            </ActionIcon>
          </Tooltip>
        )}
        <Menu
          opened={menuOpen}
          onChange={(opened) => handlers.menuChange(row.id, opened)}
          position="bottom-end"
          // Closing the menu hands focus back to its button 10ms later. When the chosen item opened
          // a rename field ("Rename", "New folder", "New request"), that stole focus from the field,
          // whose blur then committed the unchanged name and closed it before anyone could type.
          returnFocus={!anyRenaming}
          withinPortal
          shadow="md"
          width={210}
        >
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="xs"
              tabIndex={-1}
              aria-label={`Actions for ${row.name}`}
            >
              <IconDots size={13} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {container && (
              <>
                <Menu.Item
                  leftSection={<IconPlus size={14} />}
                  onClick={() => handlers.newRequest(row.id)}
                >
                  New request
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconBolt size={14} />}
                  onClick={() => handlers.newWebSocket(row.id)}
                >
                  New WebSocket request
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconFolderPlus size={14} />}
                  onClick={() => handlers.newFolder(row.id)}
                >
                  New folder
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconSettings size={14} />}
                  onClick={() => handlers.settings(row.id)}
                >
                  Settings & authorization…
                </Menu.Item>
                <Menu.Divider />
              </>
            )}
            <Menu.Item
              leftSection={<IconPencil size={14} />}
              rightSection={
                <Text size="xs" c="dimmed">
                  F2
                </Text>
              }
              onClick={() => handlers.startRename(row.id)}
            >
              Rename
            </Menu.Item>
            <Menu.Item
              leftSection={<IconCopy size={14} />}
              onClick={() => handlers.duplicate(row.id)}
            >
              Duplicate
            </Menu.Item>
            {row.kind === 'collection' && (
              <Menu.Item
                leftSection={<IconDownload size={14} />}
                onClick={() => handlers.exportNode(row.id)}
              >
                Export…
              </Menu.Item>
            )}
            <Menu.Divider />
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={14} />}
              onClick={() => handlers.remove(row.id)}
            >
              Delete
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </span>
    </div>
  );
});
