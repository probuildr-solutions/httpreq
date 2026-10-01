/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    IconArrowsMove,
    IconBolt,
    IconBox,
    IconChevronRight,
    IconCopy,
    IconDots,
    IconDownload,
    IconFolder,
    IconFolderOpen,
    IconFolderPlus,
    IconPencil,
    IconPlus,
    IconSettings,
    IconTrash,
} from '@tabler/icons-react';
import {
    memo,
    useEffect,
    useState,
    type CSSProperties,
    type DragEvent,
    type MouseEvent,
} from 'react';
import type { DropPosition } from '@httpreq/workspace';
import { ActionIcon, Menu, Text, TextInput, Tooltip, cx } from '../kit';
import { isLeafRow, requestBadge, WEBSOCKET_TEXT } from '../methods';
import type { TreeRow } from './rows';
import { treeItemId } from './treeIds';
import { RowCheckbox } from './Selection';
import { METHOD_LABEL, ROW_NAME } from './styles';

/** Pixels of indentation per level of the tree. */
const INDENT = 12;

/**
 * A tree row. Drag and drop states arrive as data attributes: "inside" outlines the container
 * that receives the node; "before" and "after" draw an insertion line at the row's indentation,
 * and the container the node would land in is tinted, so the destination is always visible. Rows
 * the node cannot go to are dimmed.
 */
const ROW = [
    'group/row relative flex h-[26px] cursor-pointer items-center gap-[5px] rounded-xs pr-1 text-[12.5px] outline-none select-none',
    'hover:bg-chrome-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-primary)]',
    'data-[selected]:bg-primary-soft data-[drop-parent]:bg-primary-soft',
    'data-[drop=inside]:bg-primary-soft data-[drop=inside]:shadow-[inset_0_0_0_1px_var(--color-primary)]',
    'data-[drop=before]:before:absolute data-[drop=after]:before:absolute data-[drop=before]:before:z-[1] data-[drop=after]:before:z-[1]',
    'data-[drop=before]:before:right-1 data-[drop=after]:before:right-1 data-[drop=before]:before:left-[var(--row-indent,6px)] data-[drop=after]:before:left-[var(--row-indent,6px)]',
    'data-[drop=before]:before:h-0.5 data-[drop=after]:before:h-0.5 data-[drop=before]:before:rounded-[1px] data-[drop=after]:before:rounded-[1px]',
    'data-[drop=before]:before:bg-primary data-[drop=after]:before:bg-primary data-[drop=before]:before:pointer-events-none data-[drop=after]:before:pointer-events-none',
    'data-[drop=before]:before:content-[""] data-[drop=after]:before:content-[""]',
    'data-[drop=before]:before:-top-px data-[drop=after]:before:-bottom-px',
    'data-[drag=source]:opacity-50 data-[drag=invalid]:cursor-no-drop data-[drag=invalid]:opacity-40',
    'aria-[current=page]:font-semibold',
].join(' ');

/**
 * Everything a row can ask the explorer to do, as one object whose identity never changes. Rows
 * are memoized, and passing fresh closures to every row (as this used to) re-rendered every row,
 * each with its own menu and tooltip, on every keystroke anywhere in the app.
 */
export interface RowHandlers {
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
    moveTo: (id: string) => void;
    remove: (id: string) => void;
    settings: (id: string) => void;
    exportNode: (id: string) => void;
    dragStart: (row: TreeRow, event: DragEvent) => void;
    dragEnd: () => void;
    dragOver: (target: TreeRow | 'drafts', key: string, event: DragEvent) => void;
    dragLeave: (key: string, event: DragEvent) => void;
    drop: (target: TreeRow | 'drafts', event: DragEvent) => void;
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
    /** Set while a dragged node is over this row: where it would be dropped. */
    dropPosition?: DropPosition;
    /** The dragged node would land in this container (dropped beside one of its children). */
    dropParent: boolean;
    dragState?: 'source' | 'invalid';
    menuOpen: boolean;
    /** Selection mode: rows show a checkbox and a click checks them instead of opening them. */
    selecting: boolean;
    checked: boolean;
    handlers: RowHandlers;
}

/** One row of the collections tree: a collection, folder or request, with its actions menu. */
export const ExplorerRow = memo(function ExplorerRow({
    row,
    selected,
    active,
    tabbable,
    unsaved,
    renaming,
    anyRenaming,
    dropPosition,
    dropParent,
    dragState,
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
            className={ROW}
            data-selected={(selecting ? checked : selected) || undefined}
            data-drop={dropPosition}
            data-drop-parent={dropParent || undefined}
            data-drag={dragState}
            style={
                {
                    paddingLeft: 6 + row.depth * INDENT,
                    '--row-indent': `${6 + row.depth * INDENT}px`,
                } as CSSProperties
            }
            onClick={() => (selecting ? handlers.check(row.id) : handlers.open(row))}
            onFocus={(event) => event.target === event.currentTarget && handlers.focus(row.id)}
            onContextMenu={selecting ? undefined : onContextMenu}
            onDoubleClick={(event) => {
                if (!selecting && isLeafRow(row.kind)) {
                    event.preventDefault();
                    handlers.startRename(row.id);
                }
            }}
            title={
                row.url ? `${row.kind === 'websocket' ? 'WS' : row.method} ${row.url}` : row.name
            }
            draggable={!renaming && !selecting}
            onDragStart={(event) => handlers.dragStart(row, event)}
            onDragEnd={handlers.dragEnd}
            onDragOver={(event) => handlers.dragOver(row, row.id, event)}
            onDragLeave={(event) => handlers.dragLeave(row.id, event)}
            onDrop={(event) => handlers.drop(row, event)}
        >
            {selecting && (
                <RowCheckbox
                    checked={checked}
                    label={row.name}
                    onChange={() => handlers.check(row.id)}
                />
            )}
            <span
                className="grid flex-[0_0_14px] place-items-center text-dimmed transition-transform duration-100 data-[open]:rotate-90"
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
                <span className={cx(METHOD_LABEL, requestBadge(row.method, row.protocol).color)}>
                    {requestBadge(row.method, row.protocol).label}
                </span>
            ) : row.kind === 'websocket' ? (
                <span className={cx(METHOD_LABEL, WEBSOCKET_TEXT)}>WS</span>
            ) : (
                <Icon size={15} className="flex-none text-dimmed" aria-hidden />
            )}
            {renaming ? (
                <TextInput
                    size="xs"
                    className="min-w-0 flex-1"
                    inputClassName="h-[22px] min-h-[22px]"
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
                <span className={ROW_NAME}>{row.name}</span>
            )}
            {unsaved && (
                <span
                    className="size-1.5 flex-[0_0_6px] rounded-full bg-dimmed"
                    aria-label="unsaved changes"
                />
            )}

            <span
                // Always laid out (so they can be hit without a prior hover, and on touch screens), but
                // only visible for the hovered, focused or selected row.
                className="flex flex-none items-center opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-data-[selected]/row:opacity-100 data-[open]:opacity-100 pointer-coarse:opacity-100 [&[hidden]]:hidden"
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
                {container && (
                    <Tooltip label="New folder">
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="xs"
                            tabIndex={-1}
                            aria-label={`New folder in ${row.name}`}
                            onClick={() => handlers.newFolder(row.id)}
                        >
                            <IconFolderPlus size={13} />
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
                                <Text size="xs" className="text-dimmed">
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
                        {row.kind !== 'collection' && (
                            <Menu.Item
                                leftSection={<IconArrowsMove size={14} />}
                                onClick={() => handlers.moveTo(row.id)}
                            >
                                Move to…
                            </Menu.Item>
                        )}
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
