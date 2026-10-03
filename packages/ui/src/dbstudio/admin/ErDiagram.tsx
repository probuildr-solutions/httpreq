/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconFocusCentered,
    IconLayoutDistributeHorizontal,
    IconMinus,
    IconPlus,
    IconRefresh,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    HEADER_HEIGHT,
    MAX_VISIBLE_COLUMNS,
    ROW_HEIGHT,
    autoLayout,
    boundsOf,
    buildErModel,
    edgeEndpoints,
    nodeSize,
    relationshipsOf,
    type ErInput,
    type ErModel,
    type ErRelationship,
    type ErTable,
    type NodeBox,
} from '@httpreq/db-admin';
import type { DbColumnInfo, DbConstraintInfo, DbIndexInfo, DbTableInfo } from '@httpreq/shared';
import { ActionIcon, Alert, Button, Checkbox, Select, Text, Tooltip, cx } from '../../kit';
import { useDbManager } from '../db/useDbManager';
import { openAdminTab, patchAdmin, useAdmin } from './adminStore';

/** Most tables loaded into one diagram without the user choosing; the rest is one click away. */
const AUTO_LIMIT = 80;
const HARD_LIMIT = 400;
const CONCURRENCY = 6;

interface Point {
    x: number;
    y: number;
}

interface Viewport {
    x: number;
    y: number;
    zoom: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A relationship diagram for MySQL and PostgreSQL schemas. It is built on the reusable
 * `buildErModel` (tables, columns, keys, relationships with cardinality) and `autoLayout`, and
 * draws it as SVG: pan by dragging the background, zoom with the wheel or the buttons, drag a table
 * to move it, click a table or a relationship to inspect it. Tables are read through the same lazy
 * metadata calls as the explorer, a few at a time, and a large schema starts with a chosen
 * neighbourhood instead of everything.
 */
export function ErDiagram({ id }: { id: string }) {
    const manager = useDbManager();
    const tab = useAdmin((state) => state.tabs[id]);
    const profileId = tab?.profileId ?? '';
    const { listMeta } = manager;

    const [allTables, setAllTables] = useState<string[] | null>(null);
    const [shown, setShown] = useState<string[] | null>(null);
    const [inputs, setInputs] = useState<Record<string, ErInput>>({});
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [positions, setPositions] = useState<Map<string, NodeBox>>(new Map());
    const [view, setView] = useState<Viewport>({ x: 20, y: 20, zoom: 1 });
    const [selected, setSelected] = useState<{ table?: string; relationship?: string } | null>(
        null,
    );
    const [infer, setInfer] = useState(false);
    const [showMany, setShowMany] = useState(true);
    const [size, setSize] = useState({ width: 800, height: 500 });
    const container = useRef<HTMLDivElement>(null);
    const drag = useRef<
        | { kind: 'pan'; start: Point; origin: Viewport }
        | { kind: 'node'; id: string; start: Point; origin: NodeBox }
        | null
    >(null);

    const scope = useMemo(
        () => ({
            ...(tab?.database ? { database: tab.database } : {}),
            ...(tab?.schema ? { schema: tab.schema } : {}),
        }),
        [tab?.database, tab?.schema],
    );

    /* ---------- Loading ---------- */

    useEffect(() => {
        if (!profileId) return;
        let cancelled = false;
        void (listMeta(profileId, 'tables', scope) as Promise<DbTableInfo[]>)
            .then((items) => {
                if (cancelled) return;
                const names = items
                    .filter((t) => t.kind === 'table')
                    .map((t) => t.name)
                    .sort();
                setAllTables(names);
                const focus = tab?.name;
                setShown(
                    (tab?.state.shown as string[] | undefined) ??
                        (names.length <= AUTO_LIMIT
                            ? names
                            : focus && names.includes(focus)
                              ? [focus]
                              : names.slice(0, 30)),
                );
            })
            .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
        return () => {
            cancelled = true;
        };
        // The table list is read once per tab.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profileId, scope]);

    const loadTables = useCallback(
        async (names: string[]) => {
            const missing = names.filter((name) => !inputs[name]);
            if (missing.length === 0) return;
            setProgress({ done: 0, total: missing.length });
            let done = 0;
            const queue = [...missing];
            const loaded: Record<string, ErInput> = {};
            const worker = async () => {
                for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
                    try {
                        const tableScope = { ...scope, name };
                        const [columns, indexes, constraints] = await Promise.all([
                            listMeta(profileId, 'columns', tableScope) as Promise<DbColumnInfo[]>,
                            listMeta(profileId, 'indexes', tableScope).catch(() => []) as Promise<
                                DbIndexInfo[]
                            >,
                            listMeta(profileId, 'constraints', tableScope).catch(
                                () => [],
                            ) as Promise<DbConstraintInfo[]>,
                        ]);
                        loaded[name] = {
                            name,
                            schema: tab?.schema,
                            database: tab?.database,
                            columns,
                            indexes,
                            constraints,
                        };
                    } catch {
                        // One unreadable table (a permission, a table dropped meanwhile) is left out.
                    }
                    setProgress({ done: ++done, total: missing.length });
                }
            };
            try {
                await Promise.all(
                    Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker),
                );
                setInputs((current) => ({ ...current, ...loaded }));
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setProgress(null);
            }
        },
        [inputs, scope, listMeta, profileId, tab?.schema, tab?.database],
    );

    useEffect(() => {
        if (shown) void loadTables(shown);
    }, [shown, loadTables]);

    /* ---------- Model and layout ---------- */

    const model: ErModel = useMemo(() => {
        const list = (shown ?? []).map((name) => inputs[name]).filter((x): x is ErInput => !!x);
        const full = buildErModel(list, { inferMissing: infer });
        const visible = new Set(full.tables.map((t) => t.id));
        return {
            tables: full.tables,
            relationships: full.relationships.filter(
                (r) =>
                    (showMany || r.cardinality !== 'many-to-many') &&
                    visible.has(r.from.table) &&
                    visible.has(r.to.table),
            ),
        };
    }, [shown, inputs, infer, showMany]);

    const tableById = useMemo(() => new Map(model.tables.map((t) => [t.id, t])), [model]);

    // Tables that arrive later are laid out; the ones the user has already moved keep their place.
    useEffect(() => {
        if (model.tables.length === 0) return;
        setPositions((current) => {
            const fresh = model.tables.filter((t) => !current.has(t.id));
            if (fresh.length === 0) return current;
            const layout = autoLayout(model);
            const next = new Map(current);
            // New tables take their computed place, to the right of what is already there.
            const offset = current.size
                ? boundsOf(current.values()).x + boundsOf(current.values()).width + 80
                : 0;
            const base = current.size ? Math.min(...fresh.map((t) => layout.get(t.id)?.x ?? 0)) : 0;
            for (const table of fresh) {
                const box = layout.get(table.id);
                if (box) next.set(table.id, { ...box, x: box.x - base + offset });
            }
            return next;
        });
    }, [model]);

    const fit = useCallback(() => {
        const bounds = boundsOf(positions.values());
        if (bounds.width === 0) return;
        const zoom = clamp(
            Math.min((size.width - 40) / bounds.width, (size.height - 40) / bounds.height),
            0.1,
            1.5,
        );
        setView({
            zoom,
            x: 20 - bounds.x * zoom + (size.width - 40 - bounds.width * zoom) / 2,
            y: 20 - bounds.y * zoom,
        });
    }, [positions, size]);

    // Fit once, when the first tables have a place.
    const fitted = useRef(false);
    useEffect(() => {
        if (!fitted.current && positions.size > 0 && size.width > 0) {
            fitted.current = true;
            fit();
        }
    }, [positions, size, fit]);

    useEffect(() => {
        const element = container.current;
        if (!element) return;
        const observer = new ResizeObserver(() =>
            setSize({ width: element.clientWidth, height: element.clientHeight }),
        );
        observer.observe(element);
        setSize({ width: element.clientWidth, height: element.clientHeight });
        return () => observer.disconnect();
    }, []);

    const relayout = () => {
        setPositions(autoLayout(model));
        fitted.current = false;
    };

    const zoomAt = (factor: number, center: Point = { x: size.width / 2, y: size.height / 2 }) =>
        setView((current) => {
            const zoom = clamp(current.zoom * factor, 0.1, 2.5);
            const ratio = zoom / current.zoom;
            return {
                zoom,
                x: center.x - (center.x - current.x) * ratio,
                y: center.y - (center.y - current.y) * ratio,
            };
        });

    /** Centres a table in the view. */
    const navigateTo = (tableId: string) => {
        const box = positions.get(tableId);
        if (!box) return;
        setSelected({ table: tableId });
        setView((current) => ({
            ...current,
            x: size.width / 2 - (box.x + box.width / 2) * current.zoom,
            y: size.height / 2 - (box.y + box.height / 2) * current.zoom,
        }));
    };

    /* ---------- Pointer handling ---------- */

    const local = (event: React.PointerEvent): Point => {
        const rect = container.current!.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: React.PointerEvent) => {
        if (event.button !== 0) return;
        const target = (event.target as Element).closest('[data-table]');
        const point = local(event);
        if (target) {
            const tableId = target.getAttribute('data-table')!;
            const box = positions.get(tableId);
            if (box) drag.current = { kind: 'node', id: tableId, start: point, origin: box };
            setSelected({ table: tableId });
        } else {
            drag.current = { kind: 'pan', start: point, origin: view };
            if (!(event.target as Element).closest('[data-relationship]')) setSelected(null);
        }
        (event.currentTarget as Element).setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const state = drag.current;
        if (!state) return;
        const point = local(event);
        const dx = point.x - state.start.x;
        const dy = point.y - state.start.y;
        if (state.kind === 'pan')
            setView({ ...state.origin, x: state.origin.x + dx, y: state.origin.y + dy });
        else
            setPositions((current) => {
                const next = new Map(current);
                next.set(state.id, {
                    ...state.origin,
                    x: state.origin.x + dx / view.zoom,
                    y: state.origin.y + dy / view.zoom,
                });
                return next;
            });
    };

    const onPointerUp = (event: React.PointerEvent) => {
        drag.current = null;
        (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
    };

    const onWheel = (event: React.WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 1) return;
        const rect = container.current!.getBoundingClientRect();
        zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        });
    };

    /* ---------- Opening things ---------- */

    const open = (kind: 'table' | 'design', name: string) =>
        tab &&
        openAdminTab({
            kind,
            title: kind === 'design' ? `${name} (structure)` : name,
            profileId,
            database: tab.database,
            schema: tab.schema,
            name,
        });

    const addTables = (names: string[]) =>
        setShown((current) => {
            const next = [...new Set([...(current ?? []), ...names])].slice(0, HARD_LIMIT);
            patchAdmin(id, (t) => ({ state: { ...t.state, shown: next } }));
            return next;
        });

    const addNeighbours = (tableId: string) => {
        // Tables this one points at are in the model only if loaded; read the constraints to find the rest.
        const input = inputs[tableId];
        const referenced = (input?.constraints ?? [])
            .filter((c) => c.kind === 'FOREIGN KEY' && c.references)
            .map((c) => c.references!.table.replace(/[`"]/g, '').split('.').pop()!);
        const referencing = Object.values(inputs)
            .filter((i) =>
                i.constraints.some(
                    (c) => c.references?.table.replace(/[`"]/g, '').split('.').pop() === tableId,
                ),
            )
            .map((i) => i.name);
        addTables([...referenced, ...referencing].filter((name) => allTables?.includes(name)));
    };

    const selectedTable = selected?.table ? tableById.get(selected.table) : undefined;
    const selectedRelationship = selected?.relationship
        ? model.relationships.find((r) => r.id === selected.relationship)
        : undefined;

    // Only tables near the view are drawn once there are many.
    const visible = useMemo(() => {
        const left = -view.x / view.zoom - 50;
        const top = -view.y / view.zoom - 50;
        const right = left + size.width / view.zoom + 100;
        const bottom = top + size.height / view.zoom + 100;
        return new Set(
            model.tables
                .filter((t) => {
                    const box = positions.get(t.id);
                    return (
                        !!box &&
                        box.x < right &&
                        box.x + box.width > left &&
                        box.y < bottom &&
                        box.y + box.height > top
                    );
                })
                .map((t) => t.id),
        );
    }, [model, positions, view, size]);

    if (!tab) return null;
    if (error)
        return (
            <div className="p-4">
                <Alert color="red">{error}</Alert>
            </div>
        );

    const notShown = (allTables ?? []).filter((name) => !(shown ?? []).includes(name));

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="er-diagram">
            <div className="box-border flex h-9 flex-none items-center gap-1 overflow-x-auto border-b border-line bg-chrome px-2 whitespace-nowrap">
                <Tooltip label="Zoom out">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Zoom out"
                        onClick={() => zoomAt(1 / 1.2)}
                    >
                        <IconMinus size={15} />
                    </ActionIcon>
                </Tooltip>
                <Text size="xs" className="w-10 text-center tabular-nums">
                    {Math.round(view.zoom * 100)}%
                </Text>
                <Tooltip label="Zoom in">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Zoom in"
                        onClick={() => zoomAt(1.2)}
                    >
                        <IconPlus size={15} />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Fit all tables in the view">
                    <ActionIcon size="sm" variant="subtle" aria-label="Fit to view" onClick={fit}>
                        <IconFocusCentered size={15} />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Arrange the tables automatically">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Auto layout"
                        onClick={relayout}
                    >
                        <IconLayoutDistributeHorizontal size={15} />
                    </ActionIcon>
                </Tooltip>
                <Tooltip label="Read the tables again">
                    <ActionIcon
                        size="sm"
                        variant="subtle"
                        aria-label="Reload"
                        onClick={() => {
                            setInputs({});
                            setPositions(new Map());
                            fitted.current = false;
                        }}
                    >
                        <IconRefresh size={15} />
                    </ActionIcon>
                </Tooltip>
                <span className="mx-1 h-4 w-px bg-line" />
                {allTables && notShown.length > 0 && (
                    <Select
                        size="xs"
                        aria-label="Add a table"
                        placeholder={`Add a table (${notShown.length} more)`}
                        value={null}
                        data={notShown.map((name) => ({ value: name, label: name }))}
                        onChange={(value) => value && addTables([value])}
                        className="w-52"
                    />
                )}
                {allTables && notShown.length > 0 && (
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => addTables(notShown.slice(0, HARD_LIMIT))}
                    >
                        Add all{notShown.length > HARD_LIMIT ? ` (first ${HARD_LIMIT})` : ''}
                    </Button>
                )}
                <Select
                    size="xs"
                    aria-label="Go to a table"
                    placeholder="Go to a table"
                    value={null}
                    data={model.tables.map((t) => ({ value: t.id, label: t.name }))}
                    onChange={(value) => value && navigateTo(value)}
                    className="w-44"
                />
                <Checkbox
                    label="Many-to-many"
                    checked={showMany}
                    onChange={(e) => setShowMany(e.currentTarget.checked)}
                />
                <Checkbox
                    label="Guess unconstrained"
                    checked={infer}
                    onChange={(e) => setInfer(e.currentTarget.checked)}
                />
                <span className="ml-auto text-xs text-dimmed">
                    {progress
                        ? `Reading tables ${progress.done}/${progress.total}…`
                        : `${model.tables.length} tables · ${model.relationships.length} relationships`}
                </span>
            </div>

            <div className="flex min-h-0 flex-1">
                <div
                    ref={container}
                    role="img"
                    aria-label={`Relationship diagram of ${model.tables.length} tables`}
                    className="relative min-w-0 flex-1 cursor-grab touch-none overflow-hidden bg-hover/30 active:cursor-grabbing"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onWheel={onWheel}
                >
                    <svg width={size.width} height={size.height} className="block select-none">
                        <defs>
                            <marker
                                id={`${id}-many`}
                                viewBox="0 0 12 12"
                                refX="11"
                                refY="6"
                                markerWidth="12"
                                markerHeight="12"
                                orient="auto-start-reverse"
                            >
                                <path
                                    d="M0,0 L11,6 L0,12 M11,6 L0,6"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.2"
                                />
                            </marker>
                            <marker
                                id={`${id}-one`}
                                viewBox="0 0 12 12"
                                refX="11"
                                refY="6"
                                markerWidth="12"
                                markerHeight="12"
                                orient="auto-start-reverse"
                            >
                                <path
                                    d="M9,0 L9,12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                            </marker>
                        </defs>
                        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
                            {model.relationships.map((relationship) => (
                                <Edge
                                    key={relationship.id}
                                    relationship={relationship}
                                    positions={positions}
                                    markerId={id}
                                    active={
                                        selected?.relationship === relationship.id ||
                                        selected?.table === relationship.from.table ||
                                        selected?.table === relationship.to.table
                                    }
                                    onSelect={() => setSelected({ relationship: relationship.id })}
                                />
                            ))}
                            {model.tables.map((table) => {
                                const box = positions.get(table.id);
                                if (!box || !visible.has(table.id)) return null;
                                return (
                                    <Node
                                        key={table.id}
                                        table={table}
                                        box={box}
                                        selected={selected?.table === table.id}
                                    />
                                );
                            })}
                        </g>
                    </svg>
                    {model.tables.length === 0 && !progress && (
                        <Text
                            size="sm"
                            className="absolute inset-0 grid place-items-center text-dimmed"
                        >
                            {allTables?.length === 0
                                ? 'This schema has no tables.'
                                : 'Choose a table to add.'}
                        </Text>
                    )}
                </div>

                {(selectedTable || selectedRelationship) && (
                    <aside
                        aria-label="Details"
                        className="w-72 flex-none overflow-auto border-l border-line p-3 text-xs"
                    >
                        {selectedTable && (
                            <div>
                                <h3 className="mt-0 mb-2 text-sm font-semibold">
                                    {selectedTable.name}
                                </h3>
                                <div className="mb-3 flex flex-wrap gap-1">
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        onClick={() => open('table', selectedTable.name)}
                                    >
                                        Open data
                                    </Button>
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        onClick={() => open('design', selectedTable.name)}
                                    >
                                        Open structure
                                    </Button>
                                    <Button
                                        size="compact-xs"
                                        variant="subtle"
                                        onClick={() => addNeighbours(selectedTable.id)}
                                    >
                                        Add related tables
                                    </Button>
                                </div>
                                <RelationList
                                    model={model}
                                    table={selectedTable}
                                    onNavigate={navigateTo}
                                    onInspect={(r) => setSelected({ relationship: r })}
                                />
                                <h4 className="mt-3 mb-1 text-xs font-semibold text-dimmed uppercase">
                                    Columns
                                </h4>
                                {selectedTable.columns.map((column) => (
                                    <div key={column.name} className="flex gap-1 py-0.5">
                                        <span className="w-4 text-center">
                                            {column.primaryKey
                                                ? '🔑'
                                                : column.foreignKey
                                                  ? '↗'
                                                  : ''}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">
                                            {column.name}
                                        </span>
                                        <span className="text-dimmed">
                                            {column.type}
                                            {column.nullable ? '' : ' · not null'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {selectedRelationship && (
                            <div>
                                <h3 className="mt-0 mb-2 text-sm font-semibold">
                                    {selectedRelationship.name}
                                </h3>
                                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                                    <dt className="text-dimmed">Kind</dt>
                                    <dd className="m-0">
                                        {selectedRelationship.cardinality}
                                        {selectedRelationship.inferred
                                            ? ' (guessed from names)'
                                            : ''}
                                    </dd>
                                    <dt className="text-dimmed">Parent</dt>
                                    <dd className="m-0">
                                        <button
                                            className="border-0 bg-transparent p-0 text-primary-text underline"
                                            onClick={() =>
                                                navigateTo(selectedRelationship.from.table)
                                            }
                                        >
                                            {selectedRelationship.from.table}
                                        </button>{' '}
                                        ({selectedRelationship.from.columns.join(', ')})
                                    </dd>
                                    <dt className="text-dimmed">Child</dt>
                                    <dd className="m-0">
                                        <button
                                            className="border-0 bg-transparent p-0 text-primary-text underline"
                                            onClick={() =>
                                                navigateTo(selectedRelationship.to.table)
                                            }
                                        >
                                            {selectedRelationship.to.table}
                                        </button>{' '}
                                        ({selectedRelationship.to.columns.join(', ')})
                                    </dd>
                                    {selectedRelationship.viaTable && (
                                        <>
                                            <dt className="text-dimmed">Through</dt>
                                            <dd className="m-0">{selectedRelationship.viaTable}</dd>
                                        </>
                                    )}
                                    {selectedRelationship.onDelete && (
                                        <>
                                            <dt className="text-dimmed">On delete</dt>
                                            <dd className="m-0">{selectedRelationship.onDelete}</dd>
                                        </>
                                    )}
                                    {selectedRelationship.onUpdate && (
                                        <>
                                            <dt className="text-dimmed">On update</dt>
                                            <dd className="m-0">{selectedRelationship.onUpdate}</dd>
                                        </>
                                    )}
                                    {selectedRelationship.required !== undefined && (
                                        <>
                                            <dt className="text-dimmed">Required</dt>
                                            <dd className="m-0">
                                                {selectedRelationship.required
                                                    ? 'Every child has a parent'
                                                    : 'A child may have no parent'}
                                            </dd>
                                        </>
                                    )}
                                </dl>
                            </div>
                        )}
                    </aside>
                )}
            </div>
        </div>
    );
}

function RelationList({
    model,
    table,
    onNavigate,
    onInspect,
}: {
    model: ErModel;
    table: ErTable;
    onNavigate: (id: string) => void;
    onInspect: (relationshipId: string) => void;
}) {
    const { references, referencedBy, manyToMany } = relationshipsOf(model, table.id);
    const item = (r: ErRelationship, other: string, label: string) => (
        <div key={r.id} className="flex items-center gap-1 py-0.5">
            <span className="text-dimmed">{label}</span>
            <button
                className="border-0 bg-transparent p-0 text-primary-text underline"
                onClick={() => onNavigate(other)}
            >
                {other}
            </button>
            <button
                className="ml-auto border-0 bg-transparent p-0 text-dimmed underline"
                onClick={() => onInspect(r.id)}
            >
                details
            </button>
        </div>
    );
    if (references.length + referencedBy.length + manyToMany.length === 0)
        return (
            <Text size="xs" className="text-dimmed">
                No relationships among the tables shown.
            </Text>
        );
    return (
        <div>
            {references.map((r) => item(r, r.from.table, 'refers to'))}
            {referencedBy.map((r) => item(r, r.to.table, 'referenced by'))}
            {manyToMany.map((r) =>
                item(r, r.from.table === table.id ? r.to.table : r.from.table, 'many-to-many with'),
            )}
        </div>
    );
}

function Node({ table, box, selected }: { table: ErTable; box: NodeBox; selected: boolean }) {
    const size = nodeSize(table);
    const visible = table.columns.slice(0, MAX_VISIBLE_COLUMNS);
    return (
        <g data-table={table.id} transform={`translate(${box.x} ${box.y})`} className="cursor-move">
            <rect
                width={size.width}
                height={size.height}
                rx={6}
                className={cx('fill-surface', selected ? 'stroke-primary' : 'stroke-line-strong')}
                strokeWidth={selected ? 2 : 1}
            />
            <path
                d={`M0,${HEADER_HEIGHT} V6 a6,6 0 0 1 6,-6 H${size.width - 6} a6,6 0 0 1 6,6 V${HEADER_HEIGHT} Z`}
                className="fill-sky-100 dark:fill-sky-900/50"
            />
            <text x={10} y={20} className="fill-current text-[13px] font-semibold">
                {table.name.length > 26 ? `${table.name.slice(0, 25)}…` : table.name}
            </text>
            {visible.map((column, index) => (
                <g
                    key={column.name}
                    transform={`translate(0 ${HEADER_HEIGHT + index * ROW_HEIGHT})`}
                >
                    <text
                        x={8}
                        y={14}
                        className={cx(
                            'text-[11px]',
                            column.primaryKey
                                ? 'fill-yellow-600 dark:fill-yellow-400'
                                : column.foreignKey
                                  ? 'fill-rose-600 dark:fill-rose-400'
                                  : 'fill-slate-400',
                        )}
                    >
                        {column.primaryKey ? '●' : column.foreignKey ? '◆' : '·'}
                    </text>
                    <text
                        x={22}
                        y={14}
                        className={cx(
                            'fill-current text-[11.5px]',
                            column.primaryKey && 'font-semibold',
                        )}
                    >
                        {column.name.length > 18 ? `${column.name.slice(0, 17)}…` : column.name}
                    </text>
                    <text
                        x={size.width - 8}
                        y={14}
                        textAnchor="end"
                        className="fill-slate-500 text-[10px]"
                    >
                        {column.type.length > 14 ? `${column.type.slice(0, 13)}…` : column.type}
                    </text>
                </g>
            ))}
            {table.columns.length > MAX_VISIBLE_COLUMNS && (
                <text
                    x={10}
                    y={HEADER_HEIGHT + MAX_VISIBLE_COLUMNS * ROW_HEIGHT + 14}
                    className="fill-slate-500 text-[10.5px]"
                >
                    + {table.columns.length - MAX_VISIBLE_COLUMNS} more columns
                </text>
            )}
        </g>
    );
}

function Edge({
    relationship,
    positions,
    markerId,
    active,
    onSelect,
}: {
    relationship: ErRelationship;
    positions: Map<string, NodeBox>;
    markerId: string;
    active: boolean;
    onSelect: () => void;
}) {
    const from = positions.get(relationship.from.table);
    const to = positions.get(relationship.to.table);
    if (!from || !to) return null;
    const self = relationship.from.table === relationship.to.table;
    let path: string;
    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    if (self) {
        x1 = from.x + from.width;
        y1 = from.y + 40;
        x2 = from.x + from.width;
        y2 = from.y + 70;
        path = `M${x1},${y1} C${x1 + 50},${y1} ${x2 + 50},${y2} ${x2},${y2}`;
    } else {
        ({ x1, y1, x2, y2 } = edgeEndpoints(from, to));
        const bend = Math.max(30, Math.abs(x2 - x1) / 2) * (x2 >= x1 ? 1 : -1);
        path = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
    }
    const many = relationship.cardinality !== 'one-to-one';
    const dashed = relationship.inferred || relationship.cardinality === 'many-to-many';
    return (
        <g
            data-relationship={relationship.id}
            className={cx('cursor-pointer', active ? 'text-primary' : 'text-slate-400')}
            onClick={onSelect}
        >
            <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
            <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth={active ? 2 : 1.2}
                strokeDasharray={dashed ? '5 4' : undefined}
                markerEnd={
                    relationship.cardinality === 'many-to-many'
                        ? undefined
                        : `url(#${markerId}-${many ? 'many' : 'one'})`
                }
                markerStart={
                    relationship.cardinality === 'many-to-many'
                        ? `url(#${markerId}-many)`
                        : `url(#${markerId}-one)`
                }
            />
        </g>
    );
}
