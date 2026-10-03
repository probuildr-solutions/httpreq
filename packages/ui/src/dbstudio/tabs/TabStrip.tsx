/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconHistory, IconPin, IconPlus, IconTerminal2, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { Menu, Tooltip, UnstyledButton, cx } from '../../kit';
import { formatSize } from '../../format';
import { ObjectIcon, type ObjectKind } from '../icons';
import { useDbManager } from '../db/useDbManager';
import { useStudioStore } from '../studioStore';
import { useDbStudio } from '../useDbStudio';
import { closeTargets } from './tabCommands';
import { useTabInfos, type TabInfo, type TabKind } from './tabInfo';
import { useTabMeta } from './tabMetaStore';
import { TaskCenter } from '../tasks/TaskCenter';
import { useTabActions } from './useTabActions';

const ICON_OF: Record<TabKind, ObjectKind> = {
    query: 'query',
    file: 'file',
    table: 'table',
    design: 'design',
    er: 'diagram',
    documents: 'collection',
    indexes: 'index',
    triggers: 'trigger',
};

/**
 * The tab strip of Database Studio. One strip for every kind of tab: query tabs, opened SQL and
 * script files, table and collection editors, designers and diagrams all rename, duplicate, pin,
 * reorder and close the same way, and share one context menu.
 */
export function TabStrip() {
    const infos = useTabInfos();
    const activeId = useStudioStore((state) => state.activeId);
    const files = useStudioStore((state) => state.tabs);
    const opening = useStudioStore((state) => state.opening);
    const closedCount = useTabMeta((state) => state.closed.length);
    const api = useDbStudio();
    const manager = useDbManager();
    const actions = useTabActions();

    const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [dragging, setDragging] = useState<string | null>(null);
    const strip = infos.map((info) => ({ id: info.id, pinned: info.pinned }));
    const anyPinned = infos.some((info) => info.pinned);
    const activate = (id: string) => useStudioStore.setState({ activeId: id });

    const menuInfo = menu ? infos.find((info) => info.id === menu.id) : undefined;
    const left = menu ? closeTargets(strip, menu.id, 'left') : [];
    const right = menu ? closeTargets(strip, menu.id, 'right') : [];
    const others = menu ? closeTargets(strip, menu.id, 'others') : [];
    const othersWithPinned = menu ? closeTargets(strip, menu.id, 'others', true) : [];
    const allWithPinned = menu ? closeTargets(strip, menu.id, 'all', true) : [];
    const all = menu ? closeTargets(strip, menu.id, 'all') : [];

    return (
        <div
            role="tablist"
            aria-label="Open tabs"
            className="flex h-[var(--hr-strip-height)] flex-none items-stretch overflow-x-auto border-b border-line bg-chrome"
        >
            {infos.map((info) => (
                <TabItem
                    key={info.id}
                    info={info}
                    selected={info.id === activeId}
                    renaming={renaming === info.id}
                    dragging={dragging === info.id}
                    tooltip={
                        info.kind === 'file' && files[info.id]
                            ? `${info.title} · ${formatSize(files[info.id]!.file.size)}`
                            : [
                                  info.title,
                                  info.subtitle,
                                  info.fileName && info.fileName !== info.title
                                      ? info.fileName
                                      : '',
                              ]
                                  .filter(Boolean)
                                  .join(' · ')
                    }
                    onSelect={() => activate(info.id)}
                    onClose={() => void actions.closeTabs([info.id])}
                    onContextMenu={(x, y) => {
                        setMenu({ id: info.id, x, y });
                    }}
                    onStartRename={() => setRenaming(info.id)}
                    onRename={(title) => {
                        if (title !== null) actions.rename(info.id, title);
                        setRenaming(null);
                    }}
                    onDragStart={() => setDragging(info.id)}
                    onDragEnd={() => setDragging(null)}
                    onDropOn={() => {
                        if (dragging) actions.move(dragging, info.id);
                        setDragging(null);
                    }}
                />
            ))}
            {manager.available && (
                <Tooltip label="New query">
                    <UnstyledButton
                        aria-label="New query"
                        className="grid w-8 flex-none place-items-center text-dimmed hover:bg-chrome-hover hover:text-fg"
                        onClick={() => manager.newQuery(null)}
                    >
                        <IconTerminal2 size={15} />
                    </UnstyledButton>
                </Tooltip>
            )}
            <Tooltip label="Open a file">
                <UnstyledButton
                    aria-label="Open a file"
                    className="grid w-8 flex-none place-items-center text-dimmed hover:bg-chrome-hover hover:text-fg"
                    onClick={() => void api.openFile()}
                    disabled={opening}
                >
                    <IconPlus size={15} />
                </UnstyledButton>
            </Tooltip>
            {closedCount > 0 && (
                <Tooltip label="Reopen the last closed tab">
                    <UnstyledButton
                        aria-label="Reopen closed tab"
                        className="grid w-8 flex-none place-items-center text-dimmed hover:bg-chrome-hover hover:text-fg"
                        onClick={() => actions.reopenClosed()}
                    >
                        <IconHistory size={15} />
                    </UnstyledButton>
                </Tooltip>
            )}
            <span className="flex-1" />
            <TaskCenter />

            <Menu
                opened={!!menuInfo}
                onClose={() => setMenu(null)}
                position="bottom-start"
                width={250}
            >
                <Menu.Target>
                    <span
                        aria-hidden
                        className="fixed block size-0"
                        style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
                    />
                </Menu.Target>
                <Menu.Dropdown aria-label="Tab actions">
                    {menuInfo && (
                        <>
                            <Menu.Item onClick={() => void actions.closeTabs([menuInfo.id])}>
                                Close Tab
                            </Menu.Item>
                            <Menu.Item
                                disabled={!left.length}
                                onClick={() => void actions.closeTabs(left)}
                            >
                                Close Tabs to the Left
                            </Menu.Item>
                            <Menu.Item
                                disabled={!right.length}
                                onClick={() => void actions.closeTabs(right)}
                            >
                                Close Tabs to the Right
                            </Menu.Item>
                            <Menu.Item
                                disabled={!others.length}
                                onClick={() => void actions.closeTabs(others)}
                            >
                                Close Other Tabs
                            </Menu.Item>
                            <Menu.Item
                                disabled={!all.length}
                                onClick={() => void actions.closeTabs(all)}
                            >
                                Close All Tabs
                            </Menu.Item>
                            {anyPinned && (
                                <>
                                    <Menu.Item
                                        disabled={!othersWithPinned.length}
                                        onClick={() => void actions.closeTabs(othersWithPinned)}
                                    >
                                        Close Other Tabs, Including Pinned
                                    </Menu.Item>
                                    <Menu.Item
                                        onClick={() => void actions.closeTabs(allWithPinned)}
                                    >
                                        Close All Tabs, Including Pinned
                                    </Menu.Item>
                                </>
                            )}
                            <Menu.Divider />
                            <Menu.Item
                                disabled={!actions.canDuplicate(menuInfo.id)}
                                onClick={() => actions.duplicate(menuInfo.id)}
                            >
                                Duplicate Tab
                            </Menu.Item>
                            <Menu.Item onClick={() => setRenaming(menuInfo.id)}>
                                Rename Tab
                            </Menu.Item>
                            {menuInfo.pinned ? (
                                <Menu.Item onClick={() => actions.pin(menuInfo.id, false)}>
                                    Unpin Tab
                                </Menu.Item>
                            ) : (
                                <Menu.Item onClick={() => actions.pin(menuInfo.id, true)}>
                                    Pin Tab
                                </Menu.Item>
                            )}
                            {(menuInfo.kind === 'query' || menuInfo.kind === 'file') && (
                                <>
                                    <Menu.Divider />
                                    <Menu.Item onClick={() => void actions.saveTab(menuInfo.id)}>
                                        Save
                                    </Menu.Item>
                                    <Menu.Item
                                        onClick={() =>
                                            void actions.saveTab(menuInfo.id, { as: true })
                                        }
                                    >
                                        Save As…
                                    </Menu.Item>
                                </>
                            )}
                            <Menu.Divider />
                            <Menu.Item
                                disabled={closedCount === 0}
                                onClick={() => actions.reopenClosed()}
                            >
                                Reopen Closed Tab
                            </Menu.Item>
                        </>
                    )}
                </Menu.Dropdown>
            </Menu>
        </div>
    );
}

interface ItemProps {
    info: TabInfo;
    selected: boolean;
    renaming: boolean;
    dragging: boolean;
    tooltip: string;
    onSelect: () => void;
    onClose: () => void;
    onContextMenu: (x: number, y: number) => void;
    onStartRename: () => void;
    onRename: (title: string | null) => void;
    onDragStart: () => void;
    onDragEnd: () => void;
    onDropOn: () => void;
}

function TabItem({
    info,
    selected,
    renaming,
    dragging,
    tooltip,
    onSelect,
    onClose,
    onContextMenu,
    onStartRename,
    onRename,
    onDragStart,
    onDragEnd,
    onDropOn,
}: ItemProps) {
    const input = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    useEffect(() => {
        if (renaming) {
            input.current?.focus();
            input.current?.select();
        }
    }, [renaming]);

    return (
        <div
            role="presentation"
            draggable={!renaming}
            data-pinned={info.pinned || undefined}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', info.id);
                onDragStart();
            }}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                onDropOn();
            }}
            onContextMenu={(event) => {
                event.preventDefault();
                onSelect();
                onContextMenu(event.clientX, event.clientY);
            }}
            className={cx(
                'group flex flex-none items-center gap-1.5 border-r border-line pr-1 pl-2.5',
                info.pinned ? 'max-w-[10rem]' : 'max-w-[18rem]',
                selected ? 'bg-surface' : 'hover:bg-hover',
                dragging && 'opacity-50',
                over && !dragging && 'shadow-[inset_2px_0_0_var(--color-primary)]',
            )}
        >
            <Tooltip label={tooltip}>
                <UnstyledButton
                    role="tab"
                    aria-selected={selected}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
                    onClick={onSelect}
                    onDoubleClick={onStartRename}
                    onAuxClick={(event) => {
                        if (event.button === 1) onClose();
                    }}
                >
                    <ObjectIcon kind={ICON_OF[info.kind]} />
                    {info.pinned && (
                        <IconPin size={11} className="flex-none text-dimmed" aria-label="Pinned" />
                    )}
                    {renaming ? (
                        <input
                            ref={input}
                            aria-label="Tab name"
                            defaultValue={info.title}
                            className="h-5 min-w-0 flex-1 rounded-xs border border-primary bg-surface px-1 text-sm outline-none"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === 'Enter') onRename(event.currentTarget.value);
                                else if (event.key === 'Escape') onRename(null);
                            }}
                            onBlur={(event) => onRename(event.currentTarget.value)}
                        />
                    ) : (
                        <>
                            <span className="truncate">{info.title}</span>
                            {info.subtitle && !info.pinned && (
                                <span className="truncate text-[11px] text-dimmed">
                                    {info.subtitle}
                                </span>
                            )}
                        </>
                    )}
                    {info.dirty && (
                        <span
                            aria-label="Unsaved changes"
                            className="size-1.5 flex-none rounded-full bg-primary"
                        />
                    )}
                </UnstyledButton>
            </Tooltip>
            <Tooltip label="Close">
                <UnstyledButton
                    aria-label={`Close ${info.title}`}
                    className="grid size-5 flex-none place-items-center rounded-sm text-dimmed hover:bg-chrome-hover hover:text-fg"
                    onClick={onClose}
                >
                    <IconX size={13} />
                </UnstyledButton>
            </Tooltip>
        </div>
    );
}
