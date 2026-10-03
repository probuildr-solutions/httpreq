/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DbCell, DbResultInfo, DbResultPage } from '@httpreq/shared';
import { Text, cx } from '../../kit';
import { formatCell } from './cells';
import type { DbApi } from './dbApi';

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 28;
const OVERSCAN = 20;
const MIN_COLUMN = 90;
const MAX_COLUMN = 420;
/** Pages kept in the window; the host holds the rest on disk. */
const MAX_PAGES = 12;

const isNumeric = (type: string) =>
    /int|decimal|numeric|float|double|real|serial|number/i.test(type);

interface Props {
    api: DbApi;
    runId: string;
    result: DbResultInfo;
    /** Asks the host for rows up to this many; the host reads ahead of the window, not beyond. */
    onDemand: (rows: number) => void;
}

/**
 * A result set as a grid, virtualised by row: only the rows in view exist in the page. Rows are
 * fetched from the host a page at a time as the user scrolls, so a result of millions of rows costs
 * a few pages of memory here, and the host is asked to read from the server only as far as needed.
 * Cells the host cut short can be loaded whole with a double click.
 */
export function ResultGrid({ api, runId, result, onDemand }: Props) {
    const scroller = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(300);
    const [pages, setPages] = useState<Map<number, DbResultPage>>(new Map());
    const [full, setFull] = useState<Map<string, DbCell>>(new Map());
    const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
    const pageSize = useRef(1000);
    const pending = useRef(new Set<number>());
    const key = `${runId}:${result.index}`;

    // A different statement or result set starts from nothing.
    useEffect(() => {
        setPages(new Map());
        setFull(new Map());
        setSelected(null);
        pending.current.clear();
        scroller.current?.scrollTo({ top: 0, left: 0 });
        setScrollTop(0);
    }, [key]);

    useEffect(() => {
        const element = scroller.current;
        if (!element) return;
        setHeight(element.clientHeight);
        const observer = new ResizeObserver(() => setHeight(element.clientHeight));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const rowCount = result.rowCount;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(
        Math.max(0, rowCount - 1),
        Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN,
    );

    // Ask the host to read as far as the window reaches.
    useEffect(() => {
        if (!result.complete) onDemand(last + 1 + pageSize.current);
    }, [last, result.complete, onDemand]);

    const load = useCallback(
        (page: number) => {
            if (pending.current.has(page)) return;
            pending.current.add(page);
            api.page(runId, result.index, page)
                .then((value) => {
                    if (!value) return;
                    pageSize.current = value.pageSize;
                    setPages((current) => {
                        const next = new Map(current);
                        next.set(page, value);
                        // Keep the pages nearest the one just loaded.
                        if (next.size > MAX_PAGES) {
                            const furthest = [...next.keys()].sort(
                                (a, b) => Math.abs(b - page) - Math.abs(a - page),
                            )[0]!;
                            next.delete(furthest);
                        }
                        return next;
                    });
                })
                .catch(() => undefined)
                .finally(() => pending.current.delete(page));
        },
        [api, runId, result.index],
    );

    // Load the pages the window touches. A page that was loaded while the result was still
    // growing is loaded again when more rows have arrived.
    useEffect(() => {
        if (rowCount === 0) return;
        const size = pageSize.current;
        for (let page = Math.floor(first / size); page <= Math.floor(last / size); page++) {
            const have = pages.get(page);
            const wanted = Math.min(size, rowCount - page * size);
            if (!have || have.rows.length < wanted) load(page);
        }
    }, [first, last, rowCount, pages, load]);

    // Widths come from the column names and the first rows, so they settle once and stay put.
    const firstPage = pages.get(0);
    const widths = useMemo(
        () =>
            result.columns.map((column, index) => {
                let chars = column.name.length + column.type.length * 0.6 + 3;
                for (const row of firstPage?.rows.slice(0, 100) ?? []) {
                    chars = Math.max(chars, Math.min(60, formatCell(row[index]).length + 2));
                }
                return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.round(chars * 7.6)));
            }),
        [result.columns, firstPage],
    );
    const totalWidth = 56 + widths.reduce((sum, w) => sum + w, 0);

    const cellOf = (
        row: number,
        column: number,
    ): { value: DbCell | undefined; clipped: boolean } => {
        const size = pageSize.current;
        const page = pages.get(Math.floor(row / size));
        const index = row - Math.floor(row / size) * size;
        const wholeKey = `${row}:${column}`;
        if (full.has(wholeKey)) return { value: full.get(wholeKey), clipped: false };
        if (!page) return { value: undefined, clipped: false };
        return {
            value: page.rows[index]?.[column],
            clipped: page.clipped.some((c) => c.row === row && c.column === column),
        };
    };

    const loadWhole = (row: number, column: number) => {
        api.cell(runId, result.index, row, column)
            .then((value) => setFull((current) => new Map(current).set(`${row}:${column}`, value)))
            .catch(() => undefined);
    };

    const copySelection = (event: React.ClipboardEvent) => {
        if (!selected) return;
        event.preventDefault();
        event.clipboardData.setData(
            'text/plain',
            formatCell(cellOf(selected.row, selected.column).value),
        );
    };

    const move = (event: React.KeyboardEvent) => {
        if (!selected || rowCount === 0) return;
        const delta: Record<string, [number, number]> = {
            ArrowDown: [1, 0],
            ArrowUp: [-1, 0],
            ArrowRight: [0, 1],
            ArrowLeft: [0, -1],
            PageDown: [Math.floor(height / ROW_HEIGHT), 0],
            PageUp: [-Math.floor(height / ROW_HEIGHT), 0],
        };
        const step = delta[event.key];
        if (!step) return;
        event.preventDefault();
        const row = Math.min(rowCount - 1, Math.max(0, selected.row + step[0]));
        const column = Math.min(result.columns.length - 1, Math.max(0, selected.column + step[1]));
        setSelected({ row, column });
        const element = scroller.current;
        if (element) {
            const top = row * ROW_HEIGHT;
            if (top < element.scrollTop) element.scrollTop = top;
            else if (top + ROW_HEIGHT > element.scrollTop + height - HEADER_HEIGHT)
                element.scrollTop = top + ROW_HEIGHT - height + HEADER_HEIGHT;
        }
    };

    if (result.columns.length === 0) {
        return (
            <div className="p-3">
                <Text size="sm">
                    {result.affectedRows !== undefined
                        ? `${result.affectedRows} row${result.affectedRows === 1 ? '' : 's'} affected.`
                        : 'The statement ran and returned no rows.'}
                    {result.info ? ` ${result.info}` : ''}
                </Text>
            </div>
        );
    }

    const rows: number[] = [];
    for (let row = first; row <= last && rowCount > 0; row++) rows.push(row);

    return (
        <div
            ref={scroller}
            role="grid"
            tabIndex={0}
            aria-label="Query result"
            aria-rowcount={rowCount}
            aria-colcount={result.columns.length}
            className="relative h-full min-h-0 overflow-auto font-mono text-xs outline-none"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onKeyDown={move}
            onCopy={copySelection}
        >
            <div style={{ width: totalWidth, height: HEADER_HEIGHT + rowCount * ROW_HEIGHT }}>
                <div
                    role="row"
                    className="sticky top-0 z-10 flex border-b border-line bg-chrome"
                    style={{ height: HEADER_HEIGHT }}
                >
                    <div className="w-14 flex-none border-r border-line" />
                    {result.columns.map((column, index) => (
                        <div
                            key={index}
                            role="columnheader"
                            className="flex flex-none items-center gap-1 truncate border-r border-line px-2 font-sans font-medium"
                            style={{ width: widths[index] }}
                            title={`${column.name} · ${column.type}`}
                        >
                            <span className="truncate">{column.name}</span>
                            <span className="truncate text-[10px] font-normal text-dimmed">
                                {column.type}
                            </span>
                        </div>
                    ))}
                </div>
                <div style={{ position: 'relative' }}>
                    {rows.map((row) => (
                        <div
                            key={row}
                            role="row"
                            aria-rowindex={row + 1}
                            className="absolute left-0 flex border-b border-line/60 hover:bg-hover"
                            style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT, width: totalWidth }}
                        >
                            <div className="w-14 flex-none truncate border-r border-line px-2 text-right text-dimmed">
                                {row + 1}
                            </div>
                            {result.columns.map((column, index) => {
                                const { value, clipped } = cellOf(row, index);
                                const isSelected =
                                    selected?.row === row && selected.column === index;
                                return (
                                    <div
                                        key={index}
                                        role="gridcell"
                                        aria-selected={isSelected}
                                        className={cx(
                                            'flex-none truncate border-r border-line/60 px-2 leading-6',
                                            isNumeric(column.type) && 'text-right',
                                            value === null && 'italic text-dimmed',
                                            value === undefined && 'text-dimmed',
                                            isSelected &&
                                                'bg-primary-soft outline outline-1 -outline-offset-1 outline-primary',
                                        )}
                                        style={{ width: widths[index] }}
                                        title={
                                            clipped
                                                ? 'Cut short; double click to load all of it'
                                                : undefined
                                        }
                                        onClick={() => setSelected({ row, column: index })}
                                        onDoubleClick={() => clipped && loadWhole(row, index)}
                                    >
                                        {value === undefined ? '…' : formatCell(value)}
                                        {clipped && <span className="text-dimmed"> …</span>}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
