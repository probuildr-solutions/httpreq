/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconArrowDown, IconArrowUp, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import type { CSSProperties, ReactNode } from 'react';
import { ActionIcon, Button, Text, Tooltip, cx } from '../kit';
import { insertAfter, minTrack, moveRow, removeAt, replaceAt } from './gridOps';

export interface GridColumn<T> {
    id: string;
    header: ReactNode;
    /** A CSS grid track: `minmax(120px, 1fr)`, `84px`, `auto`. */
    width: string;
    /** Centre the cell's content (checkboxes). */
    center?: boolean;
    /** Leaves the column out without removing its definition (an engine that lacks the feature). */
    hidden?: boolean;
    cell: (row: T, context: GridCellContext<T>) => ReactNode;
}

export interface GridCellContext<T> {
    index: number;
    rows: readonly T[];
    /** Changes fields of this row. */
    update: (patch: Partial<T>) => void;
    /** Replaces the whole list (when a cell changes other rows too: a single primary key). */
    replaceAll: (rows: T[]) => void;
}

export interface EditableGridProps<T extends { id: string }> {
    /** The accessible name of the table. */
    label: string;
    rows: readonly T[];
    columns: readonly GridColumn<T>[];
    onChange: (rows: T[]) => void;
    /** Builds a row for the Add button; omit to hide it. */
    createRow?: () => T;
    addLabel?: string;
    /** Builds the copy for Duplicate; omit to hide the action. */
    copyRow?: (row: T) => T;
    reorderable?: boolean;
    /**
     * Replace what the standard actions do, for rows that are not a flat list (a tree of fields).
     * Giving `onCopyRow` shows Duplicate; `onMoveRow` shows the move buttons.
     */
    onRemoveRow?: (row: T, index: number) => void;
    onCopyRow?: (row: T, index: number) => void;
    onMoveRow?: (row: T, index: number, delta: -1 | 1) => void;
    /** Whether the row can move that way (default: within the whole list). */
    canMove?: (row: T, index: number, delta: -1 | 1) => boolean;
    /** Whether a row may be removed (default: all). */
    canRemove?: (row: T) => boolean;
    /** What the row is called, for the action labels: `Column 2`, the name when it has one. */
    rowLabel?: (row: T, index: number) => string;
    emptyText?: string;
    /** More per-row actions, before the standard ones. */
    rowActions?: (row: T, index: number) => ReactNode;
    className?: string;
}

const CELL = 'h-[var(--grid-row-height)] min-w-0 border-b border-line';
const RULE = 'border-l first:border-l-0';
const HEADER =
    'flex items-center overflow-hidden bg-chrome px-2 text-[11px] font-semibold tracking-[0.02em] whitespace-nowrap text-dimmed';
/** Cells hold unstyled fields, which fill the cell and take its height. */
const BODY = 'flex items-center overflow-hidden *:min-w-0 *:flex-1';

/**
 * A table of editable rows, in the visual language of the request headers table: one grid whose
 * rows use `display: contents`, so every column lines up down the whole table, with a header,
 * hairline rules and compact rows. It is generic: a column is a header, a width and a function
 * that renders its cell, so table columns, procedure parameters and collection fields all use it.
 *
 * The grid knows how to add, remove, duplicate and reorder rows (the actions appear on hover or
 * focus, and are always reachable by keyboard). It owns nothing else: the caller keeps the rows.
 */
export function EditableGrid<T extends { id: string }>({
    label,
    rows,
    columns,
    onChange,
    createRow,
    addLabel = 'Add row',
    copyRow,
    reorderable,
    onRemoveRow,
    onCopyRow,
    onMoveRow,
    canMove,
    canRemove,
    rowLabel = (_row, index) => `Row ${index + 1}`,
    emptyText,
    rowActions,
    className,
}: EditableGridProps<T>) {
    const visible = columns.filter((column) => !column.hidden);
    const copies = !!copyRow || !!onCopyRow;
    const moves = reorderable || !!onMoveRow;
    const actionCount = 1 + (copies ? 1 : 0) + (moves ? 2 : 0) + (rowActions ? 1 : 0);
    const template = `${visible.map((column) => column.width).join(' ')} ${actionCount * 24 + 8}px`;
    const style = {
        gridTemplateColumns: template,
        // Narrower than this the grid scrolls sideways; wider, its flexible columns share the room.
        minWidth:
            visible.reduce((sum, column) => sum + minTrack(column.width), 0) + actionCount * 24 + 8,
        '--grid-row-height': '29px',
    } as CSSProperties;

    return (
        <div className={cx('min-w-0', className)}>
            <div className="min-w-0 overflow-x-auto">
                <div
                    role="table"
                    aria-label={label}
                    className="grid w-full overflow-hidden rounded-sm border border-line"
                    style={style}
                >
                    <div role="row" className="contents">
                        {visible.map((column) => (
                            <span
                                key={column.id}
                                role="columnheader"
                                className={cx(
                                    CELL,
                                    HEADER,
                                    RULE,
                                    column.center && 'justify-center',
                                )}
                            >
                                {column.header}
                            </span>
                        ))}
                        <span role="columnheader" className={cx(CELL, HEADER, RULE)} />
                    </div>
                    {rows.map((row, index) => {
                        const name = rowLabel(row, index);
                        const context: GridCellContext<T> = {
                            index,
                            rows,
                            update: (patch) => onChange(replaceAt(rows, index, patch)),
                            replaceAll: (next) => onChange(next),
                        };
                        return (
                            <div
                                key={row.id}
                                role="row"
                                aria-label={name}
                                className="group/row contents"
                            >
                                {visible.map((column) => (
                                    <span
                                        key={column.id}
                                        role="cell"
                                        className={cx(
                                            CELL,
                                            RULE,
                                            'group-last/row:border-b-0',
                                            BODY,
                                            column.center && 'justify-center *:flex-none',
                                        )}
                                    >
                                        {column.cell(row, context)}
                                    </span>
                                ))}
                                <span
                                    role="cell"
                                    className={cx(
                                        CELL,
                                        RULE,
                                        'group-last/row:border-b-0',
                                        'flex items-center justify-end gap-0.5 px-1',
                                    )}
                                >
                                    {rowActions?.(row, index)}
                                    {moves && (
                                        <>
                                            <RowAction
                                                label={`Move ${name} up`}
                                                disabled={
                                                    canMove ? !canMove(row, index, -1) : index === 0
                                                }
                                                onClick={() =>
                                                    onMoveRow
                                                        ? onMoveRow(row, index, -1)
                                                        : onChange(moveRow(rows, index, index - 1))
                                                }
                                            >
                                                <IconArrowUp size={13} />
                                            </RowAction>
                                            <RowAction
                                                label={`Move ${name} down`}
                                                disabled={
                                                    canMove
                                                        ? !canMove(row, index, 1)
                                                        : index === rows.length - 1
                                                }
                                                onClick={() =>
                                                    onMoveRow
                                                        ? onMoveRow(row, index, 1)
                                                        : onChange(moveRow(rows, index, index + 1))
                                                }
                                            >
                                                <IconArrowDown size={13} />
                                            </RowAction>
                                        </>
                                    )}
                                    {copies && (
                                        <RowAction
                                            label={`Duplicate ${name}`}
                                            onClick={() =>
                                                onCopyRow
                                                    ? onCopyRow(row, index)
                                                    : copyRow &&
                                                      onChange(
                                                          insertAfter(rows, index, copyRow(row)),
                                                      )
                                            }
                                        >
                                            <IconCopy size={13} />
                                        </RowAction>
                                    )}
                                    <RowAction
                                        label={`Remove ${name}`}
                                        danger
                                        disabled={canRemove ? !canRemove(row) : false}
                                        onClick={() =>
                                            onRemoveRow
                                                ? onRemoveRow(row, index)
                                                : onChange(removeAt(rows, index))
                                        }
                                    >
                                        <IconTrash size={13} />
                                    </RowAction>
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>
            {rows.length === 0 && emptyText && (
                <Text size="xs" className="py-2 text-dimmed">
                    {emptyText}
                </Text>
            )}
            {createRow && (
                <Button
                    size="compact-sm"
                    variant="light"
                    className="mt-2"
                    leftSection={<IconPlus size={13} />}
                    onClick={() => onChange([...rows, createRow()])}
                >
                    {addLabel}
                </Button>
            )}
        </div>
    );
}

function RowAction({
    label,
    onClick,
    disabled,
    danger,
    children,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    return (
        <Tooltip label={label}>
            <ActionIcon
                size={22}
                variant="subtle"
                color={danger ? 'red' : undefined}
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
                // Secondary actions stay out of the way until the row is hovered or focused.
                className="group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:hover)]:opacity-0"
            >
                {children}
            </ActionIcon>
        </Tooltip>
    );
}
