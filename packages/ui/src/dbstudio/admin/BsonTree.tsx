/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconChevronDown, IconChevronRight, IconDots } from '@tabler/icons-react';
import { useState } from 'react';
import {
    BSON_TYPE_LABELS,
    addEntry,
    defaultNode,
    parseScalar,
    removeEntry,
    renameField,
    scalarText,
    setValue,
    type BsonNode,
    type BsonType,
    type Path,
} from '@httpreq/db-admin';
import { ActionIcon, Menu, Text, cx, notifications } from '../../kit';

const BADGE: Record<BsonType, string> = {
    object: 'text-slate-500',
    array: 'text-slate-500',
    string: 'text-green-700 dark:text-green-400',
    int32: 'text-blue-700 dark:text-blue-400',
    int64: 'text-blue-700 dark:text-blue-400',
    double: 'text-blue-700 dark:text-blue-400',
    decimal128: 'text-blue-700 dark:text-blue-400',
    bool: 'text-amber-700 dark:text-amber-400',
    null: 'text-slate-500',
    objectId: 'text-purple-700 dark:text-purple-400',
    date: 'text-teal-700 dark:text-teal-400',
    uuid: 'text-purple-700 dark:text-purple-400',
    binary: 'text-rose-700 dark:text-rose-400',
    regex: 'text-orange-700 dark:text-orange-400',
    timestamp: 'text-teal-700 dark:text-teal-400',
    minKey: 'text-slate-500',
    maxKey: 'text-slate-500',
};

const isContainer = (node: BsonNode): node is Extract<BsonNode, { t: 'object' | 'array' }> =>
    node.t === 'object' || node.t === 'array';

const summary = (node: BsonNode): string => {
    if (node.t === 'object')
        return `{ ${node.entries.length} field${node.entries.length === 1 ? '' : 's'} }`;
    if (node.t === 'array')
        return `[ ${node.items.length} item${node.items.length === 1 ? '' : 's'} ]`;
    const text = scalarText(node);
    return node.t === 'string'
        ? JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text)
        : text.length > 120
          ? `${text.slice(0, 120)}…`
          : text;
};

const pathKey = (path: Path) => JSON.stringify(path);

interface Props {
    root: BsonNode;
    onChange: (root: BsonNode) => void;
    readOnly?: boolean;
}

/**
 * The tree view of a document: every field with its BSON type, scalars editable in place with
 * type-aware validation, objects and arrays expandable, fields addable, removable and renamable,
 * and a field's type changeable. It edits the same node model as the JSON view, so the two always
 * agree. `_id` of the document cannot be edited.
 */
export function BsonTree({ root, onChange, readOnly }: Props) {
    const [open, setOpen] = useState<Set<string>>(new Set([pathKey([])]));
    const [editing, setEditing] = useState<{ path: Path; what: 'value' | 'key' } | null>(null);
    const [adding, setAdding] = useState<{ path: Path; type: BsonType } | null>(null);

    const toggle = (path: Path) =>
        setOpen((current) => {
            const next = new Set(current);
            if (next.has(pathKey(path))) next.delete(pathKey(path));
            else next.add(pathKey(path));
            return next;
        });

    const apply = (next: BsonNode | { error: string }) => {
        if ('error' in next) {
            notifications.show({ color: 'red', message: next.error });
            return false;
        }
        onChange(next);
        return true;
    };

    const convert = (path: Path, node: BsonNode, type: BsonType) => {
        const parsed =
            isContainer(node) || type === 'object' || type === 'array'
                ? null
                : parseScalar(type, scalarText(node));
        const next = parsed?.ok ? parsed.node : defaultNode(type);
        onChange(setValue(root, path, next));
    };

    const rows: React.ReactNode[] = [];
    const walk = (
        node: BsonNode,
        path: Path,
        label: string,
        depth: number,
        parentIsArray: boolean,
    ) => {
        const key = pathKey(path);
        const container = isContainer(node);
        const expanded = open.has(key);
        const locked = path.length === 1 && path[0] === '_id';
        const isEditingValue = editing && pathKey(editing.path) === key && editing.what === 'value';
        const isEditingKey = editing && pathKey(editing.path) === key && editing.what === 'key';
        rows.push(
            <div
                key={key}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={container ? expanded : undefined}
                className="group flex min-h-6 items-center gap-1 rounded-xs pr-1 hover:bg-hover"
                style={{ paddingLeft: depth * 16 + 4 }}
            >
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={container ? (expanded ? 'Collapse' : 'Expand') : undefined}
                    className="grid size-4 flex-none place-items-center border-0 bg-transparent p-0 text-dimmed"
                    onClick={() => container && toggle(path)}
                >
                    {container &&
                        (expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />)}
                </button>
                {path.length > 0 &&
                    (isEditingKey ? (
                        <input
                            autoFocus
                            aria-label="Field name"
                            defaultValue={label}
                            className="h-5 w-32 rounded-xs border border-primary bg-surface px-1 text-xs outline-none"
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    if (apply(renameField(root, path, event.currentTarget.value)))
                                        setEditing(null);
                                } else if (event.key === 'Escape') setEditing(null);
                            }}
                            onBlur={() => setEditing(null)}
                        />
                    ) : (
                        <span
                            className={cx(
                                'font-mono text-xs',
                                parentIsArray ? 'text-dimmed' : 'font-semibold',
                            )}
                        >
                            {label}
                        </span>
                    ))}
                {path.length > 0 && <span className="text-dimmed">:</span>}
                {isEditingValue ? (
                    <input
                        autoFocus
                        aria-label="Field value"
                        defaultValue={scalarText(node)}
                        className="h-5 min-w-0 flex-1 rounded-xs border border-primary bg-surface px-1 font-mono text-xs outline-none"
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditing(null);
                            if (event.key !== 'Enter') return;
                            const parsed = parseScalar(node.t, event.currentTarget.value);
                            if (!parsed.ok)
                                notifications.show({ color: 'red', message: parsed.error });
                            else {
                                onChange(setValue(root, path, parsed.node));
                                setEditing(null);
                            }
                        }}
                        onBlur={() => setEditing(null)}
                    />
                ) : (
                    <span
                        className={cx(
                            'min-w-0 truncate font-mono text-xs',
                            container && 'text-dimmed',
                            !readOnly && !locked && !container && 'cursor-text',
                        )}
                        onDoubleClick={() =>
                            !readOnly &&
                            !locked &&
                            !container &&
                            node.t !== 'null' &&
                            setEditing({ path, what: 'value' })
                        }
                    >
                        {summary(node)}
                    </span>
                )}
                <span className={cx('ml-auto flex-none text-[10px]', BADGE[node.t])}>{node.t}</span>
                {!readOnly && path.length > 0 && !locked && (
                    <Menu position="bottom-end" width={200}>
                        <Menu.Target>
                            <ActionIcon
                                size="xs"
                                variant="subtle"
                                aria-label={`Actions for ${label}`}
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            >
                                <IconDots size={12} />
                            </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                            {!container && node.t !== 'null' && (
                                <Menu.Item onClick={() => setEditing({ path, what: 'value' })}>
                                    Edit value
                                </Menu.Item>
                            )}
                            {!parentIsArray && (
                                <Menu.Item onClick={() => setEditing({ path, what: 'key' })}>
                                    Rename field
                                </Menu.Item>
                            )}
                            {container && (
                                <Menu.Item
                                    onClick={() => {
                                        setOpen((c) => new Set(c).add(key));
                                        setAdding({ path, type: 'string' });
                                    }}
                                >
                                    {node.t === 'object' ? 'Add field' : 'Add item'}
                                </Menu.Item>
                            )}
                            <Menu.Divider />
                            <Menu.Label>Change type</Menu.Label>
                            {BSON_TYPE_LABELS.filter((t) => t.type !== node.t).map((t) => (
                                <Menu.Item key={t.type} onClick={() => convert(path, node, t.type)}>
                                    {t.label}
                                </Menu.Item>
                            ))}
                            <Menu.Divider />
                            <Menu.Item
                                color="red"
                                onClick={() => onChange(removeEntry(root, path))}
                            >
                                Remove
                            </Menu.Item>
                        </Menu.Dropdown>
                    </Menu>
                )}
                {!readOnly && path.length === 0 && (
                    <ActionIcon
                        size="xs"
                        variant="subtle"
                        aria-label="Add field"
                        onClick={() => setAdding({ path: [], type: 'string' })}
                    >
                        <span className="text-xs">+</span>
                    </ActionIcon>
                )}
            </div>,
        );
        if (container && expanded) {
            if (node.t === 'object')
                for (const entry of node.entries)
                    walk(entry.value, [...path, entry.key], entry.key, depth + 1, false);
            else
                node.items.forEach((item, index) =>
                    walk(item, [...path, index], String(index), depth + 1, true),
                );
            if (adding && pathKey(adding.path) === key) {
                rows.push(
                    <AddRow
                        key={`${key}:add`}
                        depth={depth + 1}
                        isArray={node.t === 'array'}
                        onCancel={() => setAdding(null)}
                        onAdd={(name, type) => {
                            if (apply(addEntry(root, path, name, defaultNode(type))))
                                setAdding(null);
                        }}
                    />,
                );
            }
        }
    };
    walk(root, [], 'document', 0, false);

    return (
        <div role="tree" aria-label="Document" className="py-1">
            {rows}
            {root.t !== 'object' && (
                <Text size="xs" className="p-2 text-dimmed">
                    The document is not an object.
                </Text>
            )}
        </div>
    );
}

function AddRow({
    depth,
    isArray,
    onAdd,
    onCancel,
}: {
    depth: number;
    isArray: boolean;
    onAdd: (name: string, type: BsonType) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState('');
    const [type, setType] = useState<BsonType>('string');
    return (
        <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: depth * 16 + 24 }}>
            {!isArray && (
                <input
                    autoFocus
                    aria-label="New field name"
                    placeholder="field name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-5 w-32 rounded-xs border border-line bg-surface px-1 text-xs outline-none focus:border-primary"
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') onAdd(name, type);
                        if (e.key === 'Escape') onCancel();
                    }}
                />
            )}
            <select
                aria-label="New field type"
                value={type}
                onChange={(e) => setType(e.target.value as BsonType)}
                className="h-5 rounded-xs border border-line bg-surface text-xs"
            >
                {BSON_TYPE_LABELS.map((t) => (
                    <option key={t.type} value={t.type}>
                        {t.label}
                    </option>
                ))}
            </select>
            <button
                type="button"
                className="rounded-xs border border-line bg-surface px-2 text-xs"
                onClick={() => onAdd(name, type)}
            >
                Add
            </button>
            <button
                type="button"
                className="border-0 bg-transparent px-1 text-xs text-dimmed"
                onClick={onCancel}
            >
                Cancel
            </button>
        </div>
    );
}
