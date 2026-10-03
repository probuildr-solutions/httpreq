/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconArrowDown, IconArrowUp, IconKey } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../kit';

export interface GridColumn {
    name: string;
    type: string;
    primaryKey?: boolean;
}

export interface GridCellView {
    text: string;
    isNull: boolean;
    /** A staged change, not yet written. */
    edited?: boolean;
    /** The host cut the text short; the cell is read-only. */
    clipped?: boolean;
    numeric?: boolean;
}

export interface GridSort {
    column: string;
    direction: 'asc' | 'desc';
}

interface Props {
    columns: GridColumn[];
    rowCount: number;
    getCell: (row: number, column: number) => GridCellView;
    /** `new` for a row that does not exist on the server yet, `deleted` for one marked for deletion. */
    rowFlag?: (row: number) => 'new' | 'deleted' | undefined;
    /** The first row's number shown in the gutter (a page after the first continues the count). */
    firstRowNumber?: number;
    active: { row: number; column: number } | null;
    selectedRows: ReadonlySet<number>;
    sort?: GridSort[];
    /** The cell that is being edited, drawn in place of its text. */
    editor?: { row: number; column: number; node: ReactNode } | null;
    onCellClick: (row: number, column: number, event: React.MouseEvent) => void;
    onCellDoubleClick?: (row: number, column: number) => void;
    onRowNumberClick?: (row: number, event: React.MouseEvent) => void;
    onHeaderClick?: (column: number, event: React.MouseEvent) => void;
    onContextMenu?: (row: number, column: number, x: number, y: number) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    ariaLabel: string;
}

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 30;
const GUTTER = 52;
const OVERSCAN = 12;
const MIN_COLUMN = 80;
const MAX_COLUMN = 360;
const CHAR = 7.2;

/**
 * A grid for one page of rows, virtualised by row: only the rows in view are in the document, so a
 * page of thousands of rows costs a screenful of elements. It draws and reports; what a click or a
 * key does (select, edit, sort, copy) is the caller's, which keeps this reusable for the table
 * editor, document lists and any other page of rows.
 */
export function DataGrid({
    columns,
    rowCount,
    getCell,
    rowFlag,
    firstRowNumber = 1,
    active,
    selectedRows,
    sort = [],
    editor,
    onCellClick,
    onCellDoubleClick,
    onRowNumberClick,
    onHeaderClick,
    onContextMenu,
    onKeyDown,
    ariaLabel,
}: Props) {
    const scroller = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(400);

    useEffect(() => {
        const element = scroller.current;
        if (!element) return;
        setHeight(element.clientHeight);
        const observer = new ResizeObserver(() => setHeight(element.clientHeight));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // Widths come from the names and the first rows, so they settle once per column set.
    const sample = Math.min(rowCount, 40);
    const widths = useMemo(
        () =>
            columns.map((column, index) => {
                let longest = column.name.length + 3;
                for (let row = 0; row < sample; row++)
                    longest = Math.max(longest, Math.min(getCell(row, index).text.length, 48));
                return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.round(longest * CHAR) + 20));
            }),
        // The sample is read once per set of columns and rows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [columns, sample],
    );
    const totalWidth = GUTTER + widths.reduce((sum, width) => sum + width, 0);

    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(rowCount - 1, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

    // Keep the active cell in view when the keyboard moves it. The sticky header covers the top
    // HEADER_HEIGHT pixels of the scroller, so a row is visible between that and the bottom edge.
    useEffect(() => {
        const element = scroller.current;
        if (!element || !active) return;
        const top = HEADER_HEIGHT + active.row * ROW_HEIGHT;
        if (top < element.scrollTop + HEADER_HEIGHT) element.scrollTop = top - HEADER_HEIGHT;
        else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
            element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }, [active]);

    const sortOf = (name: string) => sort.findIndex((item) => item.column === name);

    const rows: ReactNode[] = [];
    for (let row = first; row <= last; row++) {
        const flag = rowFlag?.(row);
        const selected = selectedRows.has(row);
        rows.push(
            <div
                key={row}
                role="row"
                aria-rowindex={row + 2}
                aria-selected={selected}
                data-row={row}
                className={cx(
                    'absolute left-0 flex border-b border-line/60',
                    selected && 'bg-primary-soft',
                    !selected && row % 2 === 1 && 'bg-hover/40',
                    flag === 'deleted' && 'line-through opacity-50',
                    flag === 'new' && 'bg-success-soft',
                )}
                style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT, width: totalWidth }}
            >
                <div
                    role="rowheader"
                    className="sticky left-0 z-[1] flex flex-none cursor-pointer items-center justify-end border-r border-line bg-chrome px-2 text-[11px] text-dimmed select-none"
                    style={{ width: GUTTER }}
                    onClick={(event) => onRowNumberClick?.(row, event)}
                >
                    {flag === 'new' ? '+' : firstRowNumber + row}
                </div>
                {columns.map((column, index) => {
                    const cell = getCell(row, index);
                    const isActive = active?.row === row && active.column === index;
                    const editing = editor?.row === row && editor.column === index;
                    return (
                        <div
                            key={column.name}
                            role="gridcell"
                            aria-selected={isActive}
                            data-column={index}
                            className={cx(
                                'flex flex-none items-center overflow-hidden border-r border-line/60 px-2 text-xs whitespace-nowrap',
                                cell.numeric && 'justify-end tabular-nums',
                                cell.isNull && 'text-dimmed italic',
                                cell.edited && 'bg-warning-soft font-medium',
                                isActive && 'outline outline-2 -outline-offset-2 outline-primary',
                            )}
                            style={{ width: widths[index] }}
                            onClick={(event) => onCellClick(row, index, event)}
                            onDoubleClick={() => onCellDoubleClick?.(row, index)}
                            onContextMenu={(event) => {
                                if (!onContextMenu) return;
                                event.preventDefault();
                                onContextMenu(row, index, event.clientX, event.clientY);
                            }}
                            title={cell.text.length > 40 ? cell.text.slice(0, 500) : undefined}
                        >
                            {editing ? (
                                editor?.node
                            ) : (
                                <span className="truncate">
                                    {cell.text}
                                    {cell.clipped && <span className="text-dimmed"> …</span>}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>,
        );
    }

    return (
        <div
            ref={scroller}
            role="grid"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-rowcount={rowCount + 1}
            aria-colcount={columns.length}
            className="relative h-full min-h-0 overflow-auto outline-none"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onKeyDown={onKeyDown}
        >
            <div
                role="row"
                aria-rowindex={1}
                className="sticky top-0 z-[2] flex border-b border-line bg-chrome"
                style={{ height: HEADER_HEIGHT, width: totalWidth }}
            >
                <div
                    className="sticky left-0 z-[3] flex-none border-r border-line bg-chrome"
                    style={{ width: GUTTER }}
                />
                {columns.map((column, index) => {
                    const order = sortOf(column.name);
                    return (
                        <div
                            key={column.name}
                            role="columnheader"
                            aria-sort={
                                order < 0
                                    ? 'none'
                                    : sort[order]!.direction === 'asc'
                                      ? 'ascending'
                                      : 'descending'
                            }
                            className="flex flex-none cursor-pointer items-center gap-1 overflow-hidden border-r border-line px-2 text-xs font-medium select-none hover:bg-hover"
                            style={{ width: widths[index] }}
                            onClick={(event) => onHeaderClick?.(index, event)}
                            title={`${column.name} · ${column.type}`}
                        >
                            {column.primaryKey && (
                                <IconKey
                                    size={12}
                                    className="flex-none text-yellow-600 dark:text-yellow-400"
                                />
                            )}
                            <span className="truncate">{column.name}</span>
                            <span className="truncate text-[10px] font-normal text-dimmed">
                                {column.type}
                            </span>
                            {order >= 0 &&
                                (sort[order]!.direction === 'asc' ? (
                                    <IconArrowUp size={12} className="flex-none" />
                                ) : (
                                    <IconArrowDown size={12} className="flex-none" />
                                ))}
                            {order >= 0 && sort.length > 1 && (
                                <span className="text-[10px] text-dimmed">{order + 1}</span>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="relative" style={{ height: rowCount * ROW_HEIGHT, width: totalWidth }}>
                {rows}
            </div>
        </div>
    );
}
