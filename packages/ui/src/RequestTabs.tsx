import { ActionIcon, Menu, Tooltip, VisuallyHidden } from '@mantine/core';
import {
  IconAlertCircleFilled,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconLoader2,
  IconPlus,
  IconVariable,
  IconX,
} from '@tabler/icons-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { HttpMethod } from '@httpreq/shared';
import { endTreeDrag, startTreeDrag, TREE_DRAG_TYPE } from './explorer/treeDrag';
import { methodColor, REQUEST_PANEL_ID, requestTabId } from './methods';
import classes from './RequestTabs.module.css';

/** What a tab can hold: an HTTP request, a WebSocket request, an environment or an SSH terminal. */
export type TabKind = 'request' | 'websocket' | 'environment' | 'ssh';

/** Live state of a WebSocket or SSH tab; the SSH and WebSocket status unions are identical. */
export type TabConnectionStatus =
  'connected' | 'connecting' | 'disconnecting' | 'disconnected' | 'error';

const STATUS_LABEL: Record<TabConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnecting: 'Disconnecting…',
  disconnected: 'Disconnected',
  error: 'Error',
};

export interface TabItem {
  id: string;
  kind: TabKind;
  name: string;
  /** HTTP tabs only. */
  method?: HttpMethod;
  url?: string;
  /** Live state for WebSocket and SSH tabs, shown as an icon and a label after the name. */
  status?: TabConnectionStatus;
}

export interface RequestTabsProps {
  requests: TabItem[];
  activeId: string;
  unsavedIds: ReadonlySet<string>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Closes several tabs as one operation (a single unsaved-changes prompt covers them all). */
  onCloseMany?: (ids: string[]) => void;
  onNew: () => void;
  onMove: (id: string, toIndex: number) => void;
  newShortcut?: string;
  closeShortcut?: string;
  /** Extra controls rendered at the right end of the strip. */
  actions?: ReactNode;
}

const DRAG_TYPE = 'application/x-httpreq-tab';
const EDGE_PADDING = 24;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');

/**
 * Scrollable request tab strip (WAI-ARIA tabs pattern with manual activation). Arrow keys,
 * Home and End move focus with a roving tabindex; Enter or Space activates; Delete closes.
 * Tabs never wrap: the strip scrolls horizontally with previous/next controls, the mouse wheel,
 * trackpads, and automatically keeps the selected or focused tab in view.
 */
export const RequestTabs = memo(function RequestTabs({
  requests,
  activeId,
  unsavedIds,
  onActivate,
  onClose,
  onCloseMany,
  onNew,
  onMove,
  newShortcut,
  closeShortcut,
  actions,
}: RequestTabsProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ previous: false, next: false });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const draggedId = useRef<string | null>(null);
  const focusAfterRender = useRef(false);
  const closable = requests.length > 0;
  const rovingId = requests.some((request) => request.id === focusedId) ? focusedId! : activeId;

  const tabElement = (id: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`) ?? null;

  const updateEdges = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const previous = viewport.scrollLeft > 1;
    const next = viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1;
    setEdges((current) =>
      current.previous === previous && current.next === next ? current : { previous, next },
    );
  }, []);

  const revealTab = useCallback((id: string, behavior: ScrollBehavior = scrollBehavior()) => {
    const viewport = viewportRef.current;
    const wrapper = listRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(id)}"]`,
    )?.parentElement;
    if (!viewport || !wrapper) return;
    const left = wrapper.offsetLeft;
    const right = left + wrapper.offsetWidth;
    if (left < viewport.scrollLeft) {
      viewport.scrollTo({ left: Math.max(0, left - EDGE_PADDING), behavior });
    } else if (right > viewport.scrollLeft + viewport.clientWidth) {
      viewport.scrollTo({ left: right - viewport.clientWidth + EDGE_PADDING, behavior });
    }
  }, []);

  // Keep the selected tab visible whenever it changes or tabs are added, closed or reordered.
  useLayoutEffect(() => {
    revealTab(activeId);
  }, [activeId, requests, revealTab]);

  useEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    tabElement(activeId)?.focus();
  });

  // Track overflow on scroll and whenever the viewport or the tab list changes size.
  useEffect(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          updateEdges();
        });
      }
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    observer.observe(list);
    viewport.addEventListener('scroll', schedule, { passive: true });
    updateEdges();

    // Vertical mouse wheels scroll the strip horizontally; trackpads already send deltaX.
    const onWheel = (event: WheelEvent) => {
      if (viewport.scrollWidth <= viewport.clientWidth) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      viewport.scrollLeft += event.deltaY * unit;
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener('scroll', schedule);
      viewport.removeEventListener('wheel', onWheel);
    };
  }, [updateEdges]);

  /** Scrolls roughly one page, aligned to a tab boundary. */
  const scrollPage = (direction: 1 | -1) => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    const max = viewport.scrollWidth - viewport.clientWidth;
    const target = Math.min(
      max,
      Math.max(0, viewport.scrollLeft + direction * viewport.clientWidth * 0.8),
    );
    const containing = [...list.children].find((child) => {
      const element = child as HTMLElement;
      return element.offsetLeft <= target && target < element.offsetLeft + element.offsetWidth;
    }) as HTMLElement | undefined;
    let left = containing ? containing.offsetLeft : target;
    if (direction > 0 && left <= viewport.scrollLeft) left = target;
    viewport.scrollTo({ left, behavior: scrollBehavior() });
  };

  const focusTab = (id: string) => {
    setFocusedId(id);
    tabElement(id)?.focus();
    revealTab(id);
  };

  const close = (id: string) => {
    if (!closable) return;
    const wasFocused = tabElement(id) === document.activeElement;
    onClose(id);
    if (wasFocused) {
      setFocusedId(null);
      focusAfterRender.current = true;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-tab-id]');
    const currentId = focused?.dataset.tabId ?? rovingId;
    const index = requests.findIndex((request) => request.id === currentId);
    let target: number | undefined;
    if (event.key === 'ArrowRight') target = (index + 1) % requests.length;
    else if (event.key === 'ArrowLeft') target = (index - 1 + requests.length) % requests.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = requests.length - 1;
    else if (event.key === 'Delete') {
      event.preventDefault();
      close(currentId);
      return;
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      openMenuAtTab(currentId);
      return;
    }
    if (target === undefined) return;
    event.preventDefault();
    focusTab(requests[target]!.id);
  };

  const openMenu = (id: string, x: number, y: number) => {
    setFocusedId(id);
    setMenu({ id, x, y });
  };

  /** Opens the menu next to the tab itself, for the keyboard and for programmatic callers. */
  const openMenuAtTab = (id: string) => {
    const rect = tabElement(id)?.getBoundingClientRect();
    openMenu(id, rect ? rect.left : 0, rect ? rect.bottom : 0);
  };

  const closeMenu = () => setMenu(null);

  /** Every menu action closes as one operation, so a single prompt covers the whole set. */
  const runCloseAction = (ids: string[]) => {
    closeMenu();
    if (!ids.length) return;
    if (onCloseMany) onCloseMany(ids);
    else ids.forEach(onClose);
  };

  const onDragStart = (event: DragEvent<HTMLElement>, id: string) => {
    draggedId.current = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, id);
    // A request tab can also be dropped onto the collection tree, to file the request there.
    const kind = requests.find((request) => request.id === id)?.kind;
    if (kind === 'request' || kind === 'websocket') {
      event.dataTransfer.setData(TREE_DRAG_TYPE, id);
      startTreeDrag(id);
    }
  };

  const onDragOver = (event: DragEvent<HTMLElement>, id: string) => {
    if (!draggedId.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setDrop((current) => (current?.id === id && current.side === side ? current : { id, side }));
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const dragged = draggedId.current;
    if (dragged && drop) {
      const from = requests.findIndex((request) => request.id === dragged);
      const over = requests.findIndex((request) => request.id === drop.id);
      let to = drop.side === 'before' ? over : over + 1;
      if (from < to) to -= 1;
      if (from >= 0 && over >= 0) onMove(dragged, to);
    }
    endDrag();
  };

  const endDrag = () => {
    draggedId.current = null;
    setDrop(null);
    endTreeDrag();
  };

  return (
    <div className={classes.bar}>
      <ActionIcon
        className={classes.scrollButton}
        variant="subtle"
        color="gray"
        radius={0}
        aria-label="Scroll to previous tabs"
        title="Scroll to previous tabs"
        disabled={!edges.previous}
        onClick={() => scrollPage(-1)}
      >
        <IconChevronLeft size={15} />
      </ActionIcon>

      <div ref={viewportRef} className={classes.viewport}>
        <div
          ref={listRef}
          role="tablist"
          aria-label="Open requests"
          aria-orientation="horizontal"
          className={classes.list}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
          }}
        >
          {requests.map((request) => (
            <RequestTab
              key={request.id}
              request={request}
              active={request.id === activeId}
              unsaved={unsavedIds.has(request.id)}
              tabbable={request.id === rovingId}
              closable={closable}
              closeShortcut={closeShortcut}
              dropSide={drop?.id === request.id ? drop.side : undefined}
              onActivate={onActivate}
              onFocus={setFocusedId}
              onClose={close}
              onContextMenu={openMenu}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={endDrag}
            />
          ))}
        </div>
      </div>

      <ActionIcon
        className={classes.scrollButton}
        variant="subtle"
        color="gray"
        radius={0}
        aria-label="Scroll to next tabs"
        title="Scroll to next tabs"
        disabled={!edges.next}
        onClick={() => scrollPage(1)}
      >
        <IconChevronRight size={15} />
      </ActionIcon>

      <Tooltip label={newShortcut ? `New request (${newShortcut})` : 'New request'}>
        <ActionIcon
          className={classes.barButton}
          variant="subtle"
          color="gray"
          radius={0}
          aria-label="New request"
          aria-keyshortcuts={newShortcut}
          onClick={onNew}
        >
          <IconPlus size={16} />
        </ActionIcon>
      </Tooltip>

      <Menu position="bottom-end" shadow="md" width={280} withinPortal>
        <Menu.Target>
          <ActionIcon
            className={classes.barButton}
            variant="subtle"
            color="gray"
            radius={0}
            aria-label="Show all open requests"
            title="Show all open requests"
          >
            <IconChevronDown size={15} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown className={classes.allTabsMenu}>
          <Menu.Label>Open requests ({requests.length})</Menu.Label>
          {requests.map((request) => (
            <Menu.Item
              key={request.id}
              onClick={() => onActivate(request.id)}
              leftSection={<TabBadge item={request} />}
              rightSection={request.id === activeId ? <span aria-hidden>●</span> : undefined}
              aria-current={request.id === activeId ? 'true' : undefined}
            >
              <span className={classes.menuName}>{request.name}</span>
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>

      <div className={classes.spacer} />
      {/*
       * The trailing controls are their own zone. Without it they would be flex children of the
       * strip alongside the scrollable viewport, and a strip full of tabs would shrink them —
       * the environment picker would collapse to a few unreadable pixels.
       */}
      {actions && <div className={classes.actions}>{actions}</div>}

      <TabContextMenu
        target={menu}
        requests={requests}
        onClose={closeMenu}
        onRun={runCloseAction}
      />
    </div>
  );
});

interface ContextMenuProps {
  target: { id: string; x: number; y: number } | null;
  requests: TabItem[];
  onClose: () => void;
  onRun: (ids: string[]) => void;
}

/**
 * Tab context menu, anchored to the pointer. The close actions follow the strip order, so
 * "to the left" and "to the right" always mean what the user sees.
 */
function TabContextMenu({ target, requests, onClose, onRun }: ContextMenuProps) {
  const index = target ? requests.findIndex((request) => request.id === target.id) : -1;
  const ids = requests.map((request) => request.id);
  const left = index > 0 ? ids.slice(0, index) : [];
  const right = index >= 0 ? ids.slice(index + 1) : [];
  const others = [...left, ...right];
  return (
    <Menu
      opened={index >= 0}
      onClose={onClose}
      position="bottom-start"
      shadow="md"
      width={230}
      withinPortal
      trapFocus
      closeOnClickOutside
      closeOnEscape
    >
      <Menu.Target>
        <span
          aria-hidden
          className={classes.menuAnchor}
          style={{ left: target?.x ?? 0, top: target?.y ?? 0 }}
        />
      </Menu.Target>
      <Menu.Dropdown aria-label="Tab actions">
        <Menu.Item onClick={() => onRun(target ? [target.id] : [])}>Close Tab</Menu.Item>
        <Menu.Item disabled={!right.length} onClick={() => onRun(right)}>
          Close Tabs to the Right
        </Menu.Item>
        <Menu.Item disabled={!left.length} onClick={() => onRun(left)}>
          Close Tabs to the Left
        </Menu.Item>
        <Menu.Item disabled={!others.length} onClick={() => onRun(others)}>
          Close Other Tabs
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item onClick={() => onRun(ids)}>Close All Tabs</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** The short kind badge at the left of a tab: an HTTP verb, WS / SSH, or an environment's icon. */
function TabBadge({ item }: { item: TabItem }) {
  if (item.kind === 'environment') {
    return (
      <span className={classes.method} style={{ color: 'var(--mantine-color-teal-text)' }}>
        <IconVariable size={14} aria-label="Environment" />
      </span>
    );
  }
  const { label, color } =
    item.kind === 'websocket'
      ? { label: 'WS', color: 'violet' }
      : item.kind === 'ssh'
        ? { label: 'SSH', color: 'cyan' }
        : { label: item.method ?? 'GET', color: methodColor[item.method ?? 'GET'] };
  return (
    <span className={classes.method} style={{ color: `var(--mantine-color-${color}-text)` }}>
      {label}
    </span>
  );
}

/**
 * A connection tab's state as an icon followed by a word, inside the tab's label and apart from
 * its close button: the two never compete for the same slot.
 */
function TabStatus({ status }: { status: TabConnectionStatus }) {
  const icon =
    status === 'connecting' || status === 'disconnecting' ? (
      <IconLoader2 size={11} className={classes.statusSpin} aria-hidden />
    ) : status === 'error' ? (
      <IconAlertCircleFilled size={11} aria-hidden />
    ) : (
      <span className={classes.statusDot} aria-hidden />
    );
  return (
    <span className={classes.status} data-status={status}>
      {icon}
      <span className={classes.statusLabel}>{STATUS_LABEL[status]}</span>
    </span>
  );
}

interface TabProps {
  request: TabItem;
  active: boolean;
  unsaved: boolean;
  tabbable: boolean;
  closable: boolean;
  closeShortcut?: string;
  dropSide?: 'before' | 'after';
  onActivate: (id: string) => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onDragStart: (event: DragEvent<HTMLElement>, id: string) => void;
  onDragOver: (event: DragEvent<HTMLElement>, id: string) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

const RequestTab = memo(function RequestTab({
  request,
  active,
  unsaved,
  tabbable,
  closable,
  closeShortcut,
  dropSide,
  onActivate,
  onFocus,
  onClose,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TabProps) {
  return (
    <div
      role="presentation"
      className={classes.tabWrapper}
      data-active={active || undefined}
      data-unsaved={unsaved || undefined}
      data-drop={dropSide}
      data-connection={request.status ? '' : undefined}
      draggable
      onDragStart={(event) => onDragStart(event, request.id)}
      onDragOver={(event) => onDragOver(event, request.id)}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(request.id, event.clientX, event.clientY);
      }}
      onMouseDown={(event) => {
        // Middle-click closes, as in browsers and editors; suppress the autoscroll cursor.
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && closable) onClose(request.id);
      }}
    >
      <button
        type="button"
        role="tab"
        id={requestTabId(request.id)}
        data-tab-id={request.id}
        className={classes.tab}
        aria-selected={active}
        aria-controls={REQUEST_PANEL_ID}
        aria-keyshortcuts={closable ? 'Delete' : undefined}
        tabIndex={tabbable ? 0 : -1}
        title={
          request.url
            ? `${request.name}\n${request.kind === 'websocket' ? 'WS' : (request.method ?? '')} ${request.url}`
            : request.name
        }
        onClick={() => onActivate(request.id)}
        onFocus={() => onFocus(request.id)}
      >
        <TabBadge item={request} />
        <span className={classes.name}>{request.name}</span>
        {request.status && <TabStatus status={request.status} />}
        {unsaved && <VisuallyHidden>(unsaved changes)</VisuallyHidden>}
      </button>
      <span className={classes.trailing}>
        {unsaved && <span className={classes.unsavedDot} aria-hidden />}
        {closable && (
          <button
            type="button"
            className={classes.close}
            tabIndex={-1}
            aria-label={`Close ${request.name}`}
            title={closeShortcut ? `Close (${closeShortcut})` : 'Close'}
            onClick={() => onClose(request.id)}
          >
            <IconX size={13} aria-hidden />
          </button>
        )}
      </span>
    </div>
  );
});
