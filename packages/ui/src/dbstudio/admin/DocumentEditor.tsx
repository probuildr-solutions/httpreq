/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconChevronLeft,
    IconChevronRight,
    IconCopy,
    IconPlus,
    IconRefresh,
    IconTrash,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    countStatement,
    deleteDocumentStatement,
    diffDocument,
    findStatement,
    formatNode,
    fromDbValue,
    idOf,
    insertDocumentStatement,
    parseDocument,
    toExtendedJson,
    updateDocumentStatement,
    type BsonNode,
} from '@httpreq/db-admin';
import type { DbCell } from '@httpreq/shared';
import { copyText } from '../../clipboard';
import { confirmAction } from '../../confirm';
import { CodeEditor } from '../../editor/CodeEditor';
import {
    ActionIcon,
    Alert,
    Button,
    Select,
    SegmentedControl,
    Text,
    TextInput,
    Tooltip,
    cx,
    notifications,
} from '../../kit';
import { useDbManager } from '../db/useDbManager';
import { patchAdmin, useAdmin } from './adminStore';
import { BsonTree } from './BsonTree';

interface ViewState {
    filter: string;
    sort: string;
    page: number;
    pageSize: number;
    mode: 'tree' | 'json';
}

const DEFAULT_VIEW: ViewState = { filter: '', sort: '', page: 0, pageSize: 20, mode: 'tree' };
const PAGE_SIZES = ['10', '20', '50', '100'].map((value) => ({
    value,
    label: `${value} documents`,
}));

const preview = (node: BsonNode): string => {
    if (node.t !== 'object') return formatNode(node, 0, 0);
    const fields = node.entries.filter((e) => e.key !== '_id').slice(0, 4);
    return fields
        .map((e) => `${e.key}: ${formatNode(e.value, 0, 0).replace(/\s+/g, ' ').slice(0, 30)}`)
        .join(', ');
};

/**
 * Browse and edit the documents of a MongoDB collection. Documents are read one page at a time
 * (skip and limit on the server) as whole documents, edited as a tree or as text with every value
 * keeping its BSON type, and saved as `$set`/`$unset` of only what changed, so fields that were not
 * touched are never rewritten. Insert, duplicate and delete are here too.
 */
export function DocumentEditor({ id }: { id: string }) {
    const manager = useDbManager();
    const tab = useAdmin((state) => state.tabs[id]);
    const profileId = tab?.profileId ?? '';
    const { ops } = manager;

    const saved = (tab?.state.view as ViewState | undefined) ?? DEFAULT_VIEW;
    const [view, setViewState] = useState<ViewState>(saved);
    const setView = useCallback(
        (patch: Partial<ViewState>) =>
            setViewState((current) => {
                const next = { ...current, ...patch };
                patchAdmin(id, (t) => ({ state: { ...t.state, view: next } }));
                return next;
            }),
        [id],
    );

    const [docs, setDocs] = useState<BsonNode[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [version, setVersion] = useState(0);
    const [total, setTotal] = useState<number | null>(null);
    const [selected, setSelected] = useState<number | null>(null);
    /** `new` is a document being inserted; otherwise the draft edits docs[selected]. */
    const [inserting, setInserting] = useState(false);
    const [draft, setDraft] = useState<BsonNode | null>(null);
    const [text, setText] = useState('');
    const [parseError, setParseError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [queryDraft, setQueryDraft] = useState({ filter: view.filter, sort: view.sort });
    const request = useRef(0);

    const original = !inserting && selected !== null ? docs[selected] : undefined;
    const dirty =
        draft !== null &&
        (inserting ||
            (original !== undefined && JSON.stringify(draft) !== JSON.stringify(original)));
    useEffect(() => patchAdmin(id, { dirty }), [id, dirty]);

    useEffect(() => {
        if (!ops || !tab?.name) return;
        const mine = ++request.current;
        setLoading(true);
        setError(null);
        const statement = findStatement(tab.database, tab.name, {
            filter: view.filter,
            sort: view.sort,
            skip: view.page * view.pageSize,
            limit: view.pageSize,
            asDocuments: true,
        });
        void ops
            .fetchRows(profileId, statement, { maxRows: view.pageSize })
            .then((result) => {
                if (request.current !== mine) return;
                const column = result.columns.findIndex((c) => c.name === 'document');
                const nodes = result.rows.map((row) =>
                    fromDbValue(row[Math.max(0, column)] as DbCell as never),
                );
                setDocs(nodes);
                setSelected(nodes.length ? 0 : null);
                setInserting(false);
                setDraft(nodes[0] ?? null);
                setText(nodes[0] ? formatNode(nodes[0]) : '');
                setParseError(null);
            })
            .catch(
                (e) =>
                    request.current === mine &&
                    setError(e instanceof Error ? e.message : String(e)),
            )
            .finally(() => request.current === mine && setLoading(false));
    }, [
        ops,
        profileId,
        tab?.database,
        tab?.name,
        view.filter,
        view.sort,
        view.page,
        view.pageSize,
        version,
    ]);

    useEffect(() => setTotal(null), [view.filter, version]);

    const discardOk = async (): Promise<boolean> => {
        if (!dirty) return true;
        const answer = await confirmAction({
            title: 'Discard your changes to this document?',
            message: 'The document has changes that are not saved.',
            confirmLabel: 'Discard changes',
            danger: true,
        });
        return answer === 'confirm';
    };

    const select = async (index: number) => {
        if (index === selected && !inserting) return;
        if (!(await discardOk())) return;
        setInserting(false);
        setSelected(index);
        setDraft(docs[index] ?? null);
        setText(docs[index] ? formatNode(docs[index]!) : '');
        setParseError(null);
    };

    const startInsert = async (from?: BsonNode) => {
        if (!(await discardOk())) return;
        let node: BsonNode = from ?? { t: 'object', entries: [] };
        // A copy gets its own id from the server.
        if (from?.t === 'object')
            node = { t: 'object', entries: from.entries.filter((e) => e.key !== '_id') };
        setInserting(true);
        setDraft(node);
        setText(formatNode(node));
        setParseError(null);
    };

    const onText = (value: string) => {
        setText(value);
        const parsed = parseDocument(value);
        if (parsed.ok) {
            setDraft(parsed.node);
            setParseError(null);
        } else {
            const before = value.slice(0, parsed.position);
            const line = before.split('\n').length;
            setParseError(`Line ${line}: ${parsed.error}`);
        }
    };

    const setMode = (mode: 'tree' | 'json') => {
        if (mode === 'tree' && parseError) {
            notifications.show({
                color: 'yellow',
                message: 'Fix the text first: it is not a valid document yet.',
            });
            return;
        }
        if (mode === 'json' && draft) setText(formatNode(draft));
        setView({ mode });
    };

    const save = async () => {
        if (!ops || !tab?.name || !draft || draft.t !== 'object') return;
        setSaving(true);
        try {
            let statement: string;
            if (inserting) {
                statement = insertDocumentStatement(tab.database, tab.name, formatNode(draft));
            } else {
                if (!original) return;
                const change = diffDocument(original, draft);
                if (!change.ok) {
                    notifications.show({
                        color: 'red',
                        title: 'Cannot save',
                        message: change.error,
                    });
                    return;
                }
                if (change.set.length === 0 && change.unset.length === 0) return;
                const idText = idOf(original);
                if (!idText) {
                    notifications.show({
                        color: 'red',
                        message: 'This document has no _id, so it cannot be addressed.',
                    });
                    return;
                }
                statement = updateDocumentStatement(tab.database, tab.name, idText, change);
            }
            const [outcome] = await ops.execute(profileId, [statement]);
            if (!outcome?.ok) {
                notifications.show({
                    color: 'red',
                    title: 'The document was not saved',
                    message: outcome?.error ?? 'The statement failed.',
                    autoClose: 10_000,
                });
                return;
            }
            notifications.show({
                color: 'teal',
                message: inserting ? 'Document inserted.' : 'Document saved.',
                autoClose: 2500,
            });
            setVersion((v) => v + 1);
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!ops || !tab?.name || !original) return;
        const idText = idOf(original);
        if (!idText) return;
        const answer = await confirmAction({
            title: 'Delete this document?',
            message: `The document with _id ${idText} is removed from “${tab.name}”. This cannot be undone.`,
            confirmLabel: 'Delete document',
            danger: true,
        });
        if (answer !== 'confirm') return;
        const [outcome] = await ops.execute(profileId, [
            deleteDocumentStatement(tab.database, tab.name, idText),
        ]);
        if (!outcome?.ok)
            notifications.show({
                color: 'red',
                title: 'Not deleted',
                message: outcome?.error ?? 'The statement failed.',
            });
        else {
            setDraft(null);
            setVersion((v) => v + 1);
        }
    };

    const count = async () => {
        if (!ops || !tab?.name) return;
        try {
            const result = await ops.fetchRows(
                profileId,
                countStatement(tab.database, tab.name, view.filter),
                { maxRows: 1 },
            );
            setTotal(Number(result.rows[0]?.[0] ?? 0));
        } catch (e) {
            notifications.show({
                color: 'red',
                title: 'Could not count',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    const applyQuery = async () => {
        if (!(await discardOk())) return;
        setView({ filter: queryDraft.filter, sort: queryDraft.sort, page: 0 });
    };

    const hasNext =
        total === null ? docs.length === view.pageSize : (view.page + 1) * view.pageSize < total;
    const idLabel = useMemo(
        () =>
            docs.map((d) =>
                d.t === 'object' ? (d.entries.find((e) => e.key === '_id')?.value ?? null) : null,
            ),
        [docs],
    );

    if (!tab) return null;
    if (!ops)
        return (
            <div className="p-6">
                <Text size="sm" className="text-dimmed">
                    Editing documents is part of the desktop app.
                </Text>
            </div>
        );

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="document-editor">
            <div className="flex flex-none flex-wrap items-center gap-1 border-b border-line bg-chrome px-2 py-1">
                <TextInput
                    size="xs"
                    aria-label="Filter"
                    placeholder='Filter, for example { status: "open" }'
                    value={queryDraft.filter}
                    onChange={(e) => setQueryDraft((q) => ({ ...q, filter: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && void applyQuery()}
                    className="min-w-48 flex-1"
                />
                <TextInput
                    size="xs"
                    aria-label="Sort"
                    placeholder="Sort, for example { createdAt: -1 }"
                    value={queryDraft.sort}
                    onChange={(e) => setQueryDraft((q) => ({ ...q, sort: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && void applyQuery()}
                    className="w-52"
                />
                <Button size="xs" onClick={() => void applyQuery()}>
                    Find
                </Button>
                <Tooltip label="Reload">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Reload"
                        onClick={async () => (await discardOk()) && setVersion((v) => v + 1)}
                    >
                        <IconRefresh size={15} />
                    </ActionIcon>
                </Tooltip>
                <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => void startInsert()}
                >
                    Insert document
                </Button>
            </div>
            {error && (
                <Alert color="red" className="m-2">
                    {error}
                </Alert>
            )}

            <div className="flex min-h-0 flex-1">
                <div className="flex w-72 flex-none flex-col border-r border-line">
                    <div
                        role="listbox"
                        aria-label="Documents"
                        className={cx('min-h-0 flex-1 overflow-auto', loading && 'opacity-60')}
                    >
                        {docs.map((doc, index) => (
                            <button
                                key={index}
                                type="button"
                                role="option"
                                aria-selected={!inserting && selected === index}
                                className={cx(
                                    'block w-full border-0 border-b border-line/60 bg-transparent px-2 py-1.5 text-left hover:bg-hover',
                                    !inserting && selected === index && 'bg-primary-soft',
                                )}
                                onClick={() => void select(index)}
                            >
                                <span className="block truncate font-mono text-xs font-semibold">
                                    {idLabel[index]
                                        ? formatNode(idLabel[index]!, 0, 0)
                                        : `#${view.page * view.pageSize + index + 1}`}
                                </span>
                                <span className="block truncate text-[11px] text-dimmed">
                                    {preview(doc) || '{}'}
                                </span>
                            </button>
                        ))}
                        {docs.length === 0 && !loading && (
                            <Text size="sm" className="p-3 text-dimmed">
                                {view.filter
                                    ? 'No documents match the filter.'
                                    : 'This collection is empty.'}
                            </Text>
                        )}
                    </div>
                    <div className="flex h-8 flex-none items-center gap-1 border-t border-line bg-chrome px-2 text-xs text-dimmed">
                        <ActionIcon
                            size="xs"
                            variant="subtle"
                            aria-label="Previous page"
                            disabled={view.page === 0}
                            onClick={async () =>
                                (await discardOk()) && setView({ page: view.page - 1 })
                            }
                        >
                            <IconChevronLeft size={14} />
                        </ActionIcon>
                        <span>
                            {docs.length
                                ? `${view.page * view.pageSize + 1}–${view.page * view.pageSize + docs.length}`
                                : '0'}
                            {total !== null ? ` of ${total.toLocaleString('en-US')}` : ''}
                        </span>
                        <ActionIcon
                            size="xs"
                            variant="subtle"
                            aria-label="Next page"
                            disabled={!hasNext}
                            onClick={async () =>
                                (await discardOk()) && setView({ page: view.page + 1 })
                            }
                        >
                            <IconChevronRight size={14} />
                        </ActionIcon>
                        {total === null && (
                            <Button size="compact-xs" variant="subtle" onClick={() => void count()}>
                                Count
                            </Button>
                        )}
                        <Select
                            size="xs"
                            aria-label="Documents per page"
                            data={PAGE_SIZES}
                            value={String(view.pageSize)}
                            onChange={async (v) =>
                                v &&
                                (await discardOk()) &&
                                setView({ pageSize: Number(v), page: 0 })
                            }
                            className="ml-auto w-32"
                        />
                    </div>
                </div>

                <div className="flex min-w-0 flex-1 flex-col">
                    {draft ? (
                        <>
                            <div className="flex h-9 flex-none items-center gap-2 border-b border-line bg-chrome px-2">
                                <SegmentedControl
                                    size="xs"
                                    value={view.mode}
                                    onChange={(v) => setMode(v as 'tree' | 'json')}
                                    data={[
                                        { value: 'tree', label: 'Tree' },
                                        { value: 'json', label: 'JSON' },
                                    ]}
                                />
                                <Text size="xs" className="text-dimmed">
                                    {inserting ? 'New document' : dirty ? 'Unsaved changes' : ''}
                                </Text>
                                <span className="ml-auto" />
                                {!inserting && original && (
                                    <>
                                        <Tooltip label="Copy as extended JSON">
                                            <ActionIcon
                                                size="sm"
                                                variant="subtle"
                                                aria-label="Copy as JSON"
                                                onClick={() =>
                                                    void copyText(
                                                        JSON.stringify(
                                                            toExtendedJson(draft),
                                                            null,
                                                            2,
                                                        ),
                                                    )
                                                }
                                            >
                                                <IconCopy size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                        <Button
                                            size="xs"
                                            variant="subtle"
                                            onClick={() => void startInsert(original)}
                                        >
                                            Duplicate
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="subtle"
                                            color="red"
                                            leftSection={<IconTrash size={14} />}
                                            onClick={() => void remove()}
                                        >
                                            Delete
                                        </Button>
                                    </>
                                )}
                                <Button
                                    size="xs"
                                    variant="subtle"
                                    disabled={!dirty}
                                    onClick={() => {
                                        const base = inserting
                                            ? ({ t: 'object', entries: [] } as BsonNode)
                                            : original!;
                                        setDraft(base);
                                        setText(formatNode(base));
                                        setParseError(null);
                                    }}
                                >
                                    Revert
                                </Button>
                                <Button
                                    size="xs"
                                    loading={saving}
                                    disabled={!dirty || !!parseError}
                                    onClick={() => void save()}
                                >
                                    {inserting ? 'Insert' : 'Save'}
                                </Button>
                            </div>
                            {parseError && (
                                <Alert color="red" className="m-2">
                                    {parseError}
                                </Alert>
                            )}
                            <div className="min-h-0 flex-1 overflow-auto">
                                {view.mode === 'tree' ? (
                                    <BsonTree
                                        root={draft}
                                        onChange={(next) => {
                                            setDraft(next);
                                            setText(formatNode(next));
                                        }}
                                    />
                                ) : (
                                    <CodeEditor
                                        value={text}
                                        onChange={onText}
                                        language="javascript"
                                        ariaLabel="Document JSON"
                                        purpose={{ kind: 'output' }}
                                        className="h-full"
                                    />
                                )}
                            </div>
                        </>
                    ) : (
                        <Text size="sm" className="p-4 text-dimmed">
                            Select a document, or insert a new one.
                        </Text>
                    )}
                </div>
            </div>
        </div>
    );
}
