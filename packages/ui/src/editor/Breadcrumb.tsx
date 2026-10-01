/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconBox, IconChevronRight, IconFolder, IconPencil } from '@tabler/icons-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ContainerNode } from '@httpreq/workspace';
import { ActionIcon, Menu, TextInput, Tooltip, UnstyledButton } from '../kit';

interface Props {
    path: ContainerNode[];
    name: string;
    onSelect: (id: string) => void;
    onRename: (name: string) => void;
}

/** More than this many containers collapses the middle into "…". */
const MAX_VISIBLE = 2;

/** A container in the path. Long names truncate harder in a narrow request pane. */
const CRUMB =
    'inline-flex min-w-0 max-w-[220px] items-center gap-1 rounded-xs px-[5px] py-0.5 text-xs text-dimmed hover:bg-hover hover:text-fg @max-[380px]/request-editor:max-w-[90px]';
const CRUMB_TEXT = 'truncate';

/**
 * `Collection > … > folder > request` for the open request. Containers select their node in the
 * explorer; the request name renames in place (by id, so every view updates together).
 */
export function Breadcrumb({ path, name, onSelect, onRename }: Props) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(name);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!editing) setDraft(name);
    }, [name, editing]);
    useEffect(() => {
        if (editing) inputRef.current?.select();
    }, [editing]);

    const commit = () => {
        setEditing(false);
        if (draft.trim() && draft.trim() !== name) onRename(draft.trim());
        else setDraft(name);
    };

    const collapsed = path.length > MAX_VISIBLE;
    const visible = collapsed ? [path[0]!, path[path.length - 1]!] : path;
    const hidden = collapsed ? path.slice(1, -1) : [];

    const crumb = (item: ContainerNode) => (
        <Tooltip label={`Show “${item.node.name}” in the explorer`} key={item.node.id}>
            <UnstyledButton onClick={() => onSelect(item.node.id)} className={CRUMB}>
                {item.kind === 'collection' ? (
                    <IconBox size={13} aria-hidden />
                ) : (
                    <IconFolder size={13} aria-hidden />
                )}
                <span className={CRUMB_TEXT}>{item.node.name}</span>
            </UnstyledButton>
        </Tooltip>
    );
    const separator = <IconChevronRight size={12} className="flex-none opacity-60" aria-hidden />;

    return (
        <nav
            aria-label="Request location"
            className="flex h-[30px] min-w-0 items-center gap-0.5 px-2.5 pt-1 text-xs text-dimmed"
        >
            {path.length === 0 && (
                <>
                    <span className="px-[5px] py-0.5">Drafts</span>
                    {separator}
                </>
            )}
            {visible.map((item, index) => (
                <Fragment key={item.node.id}>
                    {crumb(item)}
                    {separator}
                    {collapsed && index === 0 && (
                        <>
                            <Menu position="bottom-start">
                                <Menu.Target>
                                    <UnstyledButton
                                        aria-label={`${hidden.length} more folders`}
                                        className={CRUMB}
                                    >
                                        …
                                    </UnstyledButton>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    {hidden.map((item) => (
                                        <Menu.Item
                                            key={item.node.id}
                                            leftSection={<IconFolder size={14} />}
                                            onClick={() => onSelect(item.node.id)}
                                        >
                                            {item.node.name}
                                        </Menu.Item>
                                    ))}
                                </Menu.Dropdown>
                            </Menu>
                            {separator}
                        </>
                    )}
                </Fragment>
            ))}
            {editing ? (
                <TextInput
                    ref={inputRef}
                    size="xs"
                    aria-label="Request name"
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') commit();
                        if (event.key === 'Escape') {
                            setDraft(name);
                            setEditing(false);
                        }
                    }}
                    className="max-w-80 min-w-[140px]"
                />
            ) : (
                <span
                    className="inline-flex min-w-0 items-center gap-0.5 pl-[5px] font-semibold text-fg"
                    aria-current="page"
                    onDoubleClick={() => setEditing(true)}
                >
                    <span className={CRUMB_TEXT}>{name}</span>
                    <Tooltip label="Rename (F2 in the explorer)">
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label="Rename request"
                            onClick={() => setEditing(true)}
                        >
                            <IconPencil size={13} />
                        </ActionIcon>
                    </Tooltip>
                </span>
            )}
        </nav>
    );
}
