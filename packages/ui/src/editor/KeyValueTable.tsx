/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconChevronRight,
    IconCopy,
    IconLock,
    IconLockOpen,
    IconPencilPlus,
    IconShieldLock,
    IconTrash,
} from '@tabler/icons-react';
import { memo, useState, type ReactNode } from 'react';
import { createId, type KeyValueItem } from '@httpreq/shared';
import { VariableInput } from './VariableInput';
import { fromBulkText, toBulkText } from './bulk';
import {
    ActionIcon,
    Autocomplete,
    Button,
    Checkbox,
    Group,
    Text,
    Textarea,
    Tooltip,
    UnstyledButton,
    cx,
} from '../kit';

/**
 * A row the user cannot edit, shown in the same grid as the editable rows so the columns line up:
 * e.g. a header the authorization or the HTTP client adds when the request is sent.
 */
export interface LockedRow {
    id: string;
    key: string;
    value: string;
    /** Shown in the description column: where the row comes from. */
    description: string;
    /** Set when an editable row takes this one's place; the row is shown struck through. */
    overriddenBy?: string;
    /** Offered when an editable row may replace this one: adds that row. */
    onOverride?: () => void;
}

export interface KeyValueTableProps<T extends KeyValueItem> {
    items: T[];
    onChange: (items: T[]) => void;
    /** Builds a new row (e.g. to add fields specific to multipart rows). */
    createRow?: (patch: Partial<KeyValueItem>) => T;
    label: string;
    keyPlaceholder?: string;
    valuePlaceholder?: string;
    /** Suggestions for the key column (e.g. common header names). */
    keySuggestions?: readonly string[];
    /** Shows a per-row toggle that masks the value. */
    allowSecret?: boolean;
    showDescription?: boolean;
    allowBulkEdit?: boolean;
    /** Adds a Type column between Key and Value (e.g. Text / File for multipart fields). */
    renderType?: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
    /** Replaces the value cell for a row (e.g. a file picker). */
    renderValue?: (item: T, update: (patch: Partial<T>) => void) => ReactNode | undefined;
    /** Extra per-row controls before the row actions (e.g. text/file switch). */
    renderRowExtras?: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
    /** Message shown in a row, e.g. that the header is replaced by authorization. */
    rowNote?: (item: T) => string | undefined;
    /** Read-only rows listed above the editable ones, under a heading that shows or hides them. */
    lockedRows?: readonly LockedRow[];
    /** Heading of the locked rows, e.g. "Auto-generated headers". */
    lockedLabel?: string;
    lockedHint?: string;
    lockedVisible?: boolean;
    onLockedVisibleChange?: (visible: boolean) => void;
}

/*
 * One grid for every key/value editor (params, headers, form fields, environment variables), so
 * they share column widths, row height and rules. Rows use `display: contents`, which makes each
 * cell a grid item: every column lines up down the whole table, locked rows included. In a narrow
 * request pane the description column gives its space to key and value.
 */
const TABLE = [
    'grid grid-cols-[var(--kv-columns)] overflow-hidden rounded-sm border border-line',
    '[--kv-row-height:29px] [--kv-columns:30px_minmax(120px,1fr)_minmax(140px,1.4fr)_auto]',
    'data-[description]:[--kv-columns:30px_minmax(110px,1fr)_minmax(130px,1.3fr)_minmax(90px,1fr)_auto]',
    'data-[typed]:[--kv-columns:30px_minmax(110px,1fr)_84px_minmax(140px,1.4fr)_auto]',
    'data-[typed]:data-[description]:[--kv-columns:30px_minmax(100px,1fr)_84px_minmax(130px,1.3fr)_minmax(90px,1fr)_auto]',
    '@max-[620px]/request-editor:data-[description]:[--kv-columns:30px_minmax(90px,1fr)_minmax(110px,1.4fr)_auto]',
    '@max-[620px]/request-editor:data-[typed]:data-[description]:[--kv-columns:30px_minmax(90px,1fr)_84px_minmax(110px,1.4fr)_auto]',
].join(' ');

/** Header and body cells share the row height; a rule separates every pair of data columns. */
const CELL_BASE = 'h-[var(--kv-row-height)] min-w-0 border-b border-line';
const RULE = 'border-l first:border-l-0';
const HEADER_TEXT =
    'flex items-center bg-chrome text-[11px] font-semibold tracking-[0.02em] text-dimmed';
const HEADER_CELL = cx(CELL_BASE, HEADER_TEXT, 'px-2', RULE);
const HEADER_ACTIONS = cx(CELL_BASE, HEADER_TEXT, 'justify-end pr-1');
const BODY_END = 'group-last/row:border-b-0';
const BODY_CELL = cx(CELL_BASE, RULE, BODY_END);
const CHECK_CELL = 'flex items-center justify-center p-0';
const INPUT_CELL = 'flex items-center *:flex-1';
/** The description column is the first to go when the pane is narrow. */
const DESCRIPTION = '@max-[620px]/request-editor:hidden';
const ACTIONS_CELL = cx(CELL_BASE, BODY_END, 'flex min-w-16 items-center justify-end gap-0.5 px-1');

/** Row actions stay reachable by keyboard but only draw attention on hover or focus. */
const ROW_ACTION =
    '[@media(hover:hover)]:opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-pressed:opacity-100';

/** Locked cells use the editable cells' metrics, so text starts at the same x and baseline. */
const LOCKED_TEXT = 'min-w-0 flex-1 cursor-default truncate px-2 text-dimmed';

/** Dimmed while a row is disabled; a not-yet-real trailing row is only slightly dimmed. */
const ROW_DIM = 'group-data-[disabled]/row:opacity-55 group-data-[ghost]/row:opacity-80';
/** Locked rows sit on a faint tint so they read as not editable. */
const LOCKED_CELL = 'bg-gray-0 dark:bg-white/[0.02]';
const LOCKED_MONO = 'font-mono text-[12.5px]';

const defaultCreate = (patch: Partial<KeyValueItem>) =>
    ({ id: createId(), key: '', value: '', enabled: true, ...patch }) as KeyValueItem;

/**
 * Structured `✓ | Key | Value | Description` editor. A trailing empty row turns into a real row
 * as soon as something is typed into it (keeping focus), so empty placeholder rows are never
 * stored or counted.
 */
function KeyValueTableInner<T extends KeyValueItem>({
    items,
    onChange,
    createRow = defaultCreate as unknown as (patch: Partial<KeyValueItem>) => T,
    label,
    keyPlaceholder = 'Key',
    valuePlaceholder = 'Value',
    keySuggestions,
    allowSecret = false,
    showDescription = true,
    allowBulkEdit = true,
    renderType,
    renderValue,
    renderRowExtras,
    rowNote,
    lockedRows,
    lockedLabel = 'Locked',
    lockedHint,
    lockedVisible = true,
    onLockedVisibleChange,
}: KeyValueTableProps<T>) {
    const [ghostId, setGhostId] = useState(createId);
    const [bulk, setBulk] = useState<string | null>(null);

    const update = (id: string, patch: Partial<T>) => {
        if (id === ghostId) {
            onChange([...items, { ...createRow({ id: ghostId }), ...patch }]);
            setGhostId(createId());
            return;
        }
        onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };
    const remove = (id: string) => onChange(items.filter((item) => item.id !== id));
    const duplicate = (id: string) => {
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return;
        const next = [...items];
        next.splice(index + 1, 0, { ...structuredClone(items[index]!), id: createId() });
        onChange(next);
    };

    const enabledCount = items.filter((item) => item.enabled && item.key.trim()).length;
    const allEnabled = items.length > 0 && items.every((item) => item.enabled);

    if (bulk !== null) {
        return (
            <div className="min-w-0 overflow-x-auto">
                <Group justify="space-between" className="mb-1.5">
                    <Text size="xs" className="text-dimmed">
                        One <code>key: value</code> per line. Prefix a line with <code>//</code> to
                        disable it.
                    </Text>
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => {
                            onChange(fromBulkText(bulk, items, createRow));
                            setBulk(null);
                        }}
                    >
                        Key-value edit
                    </Button>
                </Group>
                <Textarea
                    aria-label={`${label} (bulk edit)`}
                    value={bulk}
                    onChange={(event) => setBulk(event.currentTarget.value)}
                    onBlur={() => onChange(fromBulkText(bulk, items, createRow))}
                    autosize
                    minRows={6}
                    autoFocus
                    className="hr-mono"
                />
            </div>
        );
    }

    const rows = [...items, { ...createRow({ id: ghostId }) }];
    const lockedCount = lockedRows?.filter((row) => !row.overriddenBy).length ?? 0;

    return (
        <div className="min-w-0 overflow-x-auto">
            <div
                className={TABLE}
                role="table"
                aria-label={label}
                data-description={showDescription || undefined}
                data-typed={renderType ? true : undefined}
            >
                <div className="contents" role="row">
                    <span role="columnheader" className={cx(HEADER_CELL, CHECK_CELL)}>
                        <Checkbox
                            size="xs"
                            aria-label={`Enable all ${label.toLowerCase()}`}
                            checked={allEnabled}
                            indeterminate={!allEnabled && items.some((item) => item.enabled)}
                            disabled={!items.length}
                            onChange={(event) =>
                                onChange(
                                    items.map((item) => ({
                                        ...item,
                                        enabled: event.currentTarget.checked,
                                    })),
                                )
                            }
                        />
                    </span>
                    <span role="columnheader" className={HEADER_CELL}>
                        Key
                    </span>
                    {renderType && (
                        <span role="columnheader" className={HEADER_CELL}>
                            Type
                        </span>
                    )}
                    <span role="columnheader" className={HEADER_CELL}>
                        Value
                    </span>
                    {showDescription && (
                        <span role="columnheader" className={cx(HEADER_CELL, DESCRIPTION)}>
                            Description
                        </span>
                    )}
                    <span role="columnheader" className={HEADER_ACTIONS}>
                        {allowBulkEdit && (
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                color="gray"
                                onClick={() => setBulk(toBulkText(items))}
                            >
                                Bulk edit
                            </Button>
                        )}
                    </span>
                </div>
                {lockedRows && lockedRows.length > 0 && (
                    <div role="row" className="contents">
                        <span
                            role="cell"
                            className="col-span-full flex h-[var(--kv-row-height)] min-w-0 items-center gap-2.5 border-b border-line bg-chrome px-2"
                        >
                            <UnstyledButton
                                aria-expanded={lockedVisible}
                                onClick={() => onLockedVisibleChange?.(!lockedVisible)}
                                className="inline-flex flex-none items-center gap-1 text-[11.5px] font-semibold text-fg"
                            >
                                <IconChevronRight
                                    size={13}
                                    className="text-dimmed transition-transform duration-100 data-[open]:rotate-90"
                                    data-open={lockedVisible || undefined}
                                    aria-hidden
                                />
                                {lockedLabel}
                                <span className="inline-grid h-[17px] min-w-[17px] place-items-center rounded-[9px] bg-hover px-[5px] text-[10.5px] text-dimmed">
                                    {lockedCount}
                                </span>
                            </UnstyledButton>
                            {lockedHint && (
                                <Text
                                    component="span"
                                    size="xs"
                                    className="min-w-0 truncate text-dimmed"
                                >
                                    {lockedHint}
                                </Text>
                            )}
                        </span>
                    </div>
                )}
                {lockedVisible &&
                    lockedRows?.map((row) => (
                        <div
                            key={row.id}
                            role="row"
                            className="group/row contents"
                            data-overridden={row.overriddenBy ? true : undefined}
                        >
                            <span role="cell" className={cx(BODY_CELL, CHECK_CELL, LOCKED_CELL)}>
                                <Tooltip label="Added automatically; not editable" openDelay={300}>
                                    <IconShieldLock
                                        size={13}
                                        className="text-dimmed"
                                        aria-label="Read-only"
                                    />
                                </Tooltip>
                            </span>
                            <span role="cell" className={cx(BODY_CELL, INPUT_CELL, LOCKED_CELL)}>
                                <span
                                    className={cx(
                                        LOCKED_TEXT,
                                        LOCKED_MONO,
                                        'group-data-[overridden]/row:line-through group-data-[overridden]/row:opacity-70',
                                    )}
                                    title={row.key}
                                >
                                    {row.key}
                                </span>
                            </span>
                            {renderType && (
                                <span
                                    role="cell"
                                    className={cx(BODY_CELL, INPUT_CELL, LOCKED_CELL)}
                                />
                            )}
                            <span role="cell" className={cx(BODY_CELL, INPUT_CELL, LOCKED_CELL)}>
                                <span
                                    className={cx(
                                        LOCKED_TEXT,
                                        LOCKED_MONO,
                                        'group-data-[overridden]/row:line-through group-data-[overridden]/row:opacity-70',
                                    )}
                                    title={row.value}
                                >
                                    {row.value}
                                </span>
                            </span>
                            {showDescription && (
                                <span
                                    role="cell"
                                    className={cx(BODY_CELL, INPUT_CELL, LOCKED_CELL, DESCRIPTION)}
                                >
                                    <span
                                        className={cx(LOCKED_TEXT, 'text-xs')}
                                        title={row.description}
                                    >
                                        {row.overriddenBy
                                            ? `Replaced by your “${row.overriddenBy}” header`
                                            : row.description}
                                    </span>
                                </span>
                            )}
                            <span role="cell" className={cx(ACTIONS_CELL, LOCKED_CELL)}>
                                {row.onOverride && !row.overriddenBy && (
                                    <Tooltip label="Override: add an editable copy">
                                        <ActionIcon
                                            variant="subtle"
                                            color="gray"
                                            size="sm"
                                            aria-label={`Override ${row.key}`}
                                            onClick={row.onOverride}
                                            className={ROW_ACTION}
                                        >
                                            <IconPencilPlus size={14} />
                                        </ActionIcon>
                                    </Tooltip>
                                )}
                            </span>
                        </div>
                    ))}
                {rows.map((item) => {
                    const ghost = item.id === ghostId;
                    const patch = (value: Partial<T>) => update(item.id, value);
                    const note = ghost ? undefined : rowNote?.(item);
                    const customValue = renderValue?.(item, patch);
                    return (
                        <div
                            key={item.id}
                            role="row"
                            className="group/row contents"
                            data-disabled={(!ghost && !item.enabled) || undefined}
                            data-ghost={ghost || undefined}
                        >
                            <span role="cell" className={cx(BODY_CELL, CHECK_CELL)}>
                                {!ghost && (
                                    <Checkbox
                                        size="xs"
                                        aria-label={`Enable ${item.key || 'row'}`}
                                        checked={item.enabled}
                                        onChange={(event) =>
                                            patch({
                                                enabled: event.currentTarget.checked,
                                            } as Partial<T>)
                                        }
                                    />
                                )}
                            </span>
                            <span role="cell" className={cx(BODY_CELL, INPUT_CELL, ROW_DIM)}>
                                {keySuggestions ? (
                                    <Autocomplete
                                        aria-label="Key"
                                        placeholder={
                                            ghost
                                                ? `Add ${keyPlaceholder.toLowerCase()}`
                                                : keyPlaceholder
                                        }
                                        value={item.key}
                                        data={keySuggestions as string[]}
                                        onChange={(key) => patch({ key } as Partial<T>)}
                                        variant="unstyled"
                                        size="xs"
                                        inputClassName="font-mono text-[12.5px]"
                                        limit={8}
                                    />
                                ) : (
                                    <VariableInput
                                        variant="cell"
                                        aria-label="Key"
                                        placeholder={
                                            ghost
                                                ? `Add ${keyPlaceholder.toLowerCase()}`
                                                : keyPlaceholder
                                        }
                                        value={item.key}
                                        onChange={(key) => patch({ key } as Partial<T>)}
                                    />
                                )}
                            </span>
                            {renderType && (
                                <span role="cell" className={cx(BODY_CELL, INPUT_CELL, ROW_DIM)}>
                                    {renderType(item, patch)}
                                </span>
                            )}
                            <span role="cell" className={cx(BODY_CELL, INPUT_CELL, ROW_DIM)}>
                                {customValue ?? (
                                    <VariableInput
                                        variant="cell"
                                        aria-label="Value"
                                        placeholder={valuePlaceholder}
                                        value={item.value}
                                        masked={!!item.secret}
                                        onChange={(value) => patch({ value } as Partial<T>)}
                                    />
                                )}
                            </span>
                            {showDescription && (
                                <span
                                    role="cell"
                                    className={cx(BODY_CELL, INPUT_CELL, ROW_DIM, DESCRIPTION)}
                                >
                                    <VariableInput
                                        variant="cell"
                                        mono={false}
                                        completion={false}
                                        aria-label="Description"
                                        placeholder="Description"
                                        value={item.description ?? ''}
                                        onChange={(description) =>
                                            patch({ description } as Partial<T>)
                                        }
                                    />
                                </span>
                            )}
                            <span role="cell" className={ACTIONS_CELL}>
                                {!ghost && (
                                    <>
                                        {note && (
                                            <Tooltip label={note} w={260}>
                                                <span
                                                    className="mr-0.5 inline-grid size-4 place-items-center rounded-full bg-warning-soft text-[11px] font-bold text-warning-text"
                                                    tabIndex={0}
                                                    aria-label={note}
                                                >
                                                    !
                                                </span>
                                            </Tooltip>
                                        )}
                                        {renderRowExtras?.(item, patch)}
                                        {allowSecret && (
                                            <Tooltip
                                                label={
                                                    item.secret
                                                        ? 'Secret: masked and not saved to disk'
                                                        : 'Mark as secret'
                                                }
                                            >
                                                <ActionIcon
                                                    variant="subtle"
                                                    color={item.secret ? 'violet' : 'gray'}
                                                    size="sm"
                                                    aria-label={
                                                        item.secret
                                                            ? 'Unmark secret'
                                                            : 'Mark as secret'
                                                    }
                                                    aria-pressed={!!item.secret}
                                                    onClick={() =>
                                                        patch({
                                                            secret: !item.secret,
                                                        } as Partial<T>)
                                                    }
                                                    className={ROW_ACTION}
                                                >
                                                    {item.secret ? (
                                                        <IconLock size={14} />
                                                    ) : (
                                                        <IconLockOpen size={14} />
                                                    )}
                                                </ActionIcon>
                                            </Tooltip>
                                        )}
                                        <Tooltip label="Duplicate">
                                            <ActionIcon
                                                variant="subtle"
                                                color="gray"
                                                size="sm"
                                                aria-label="Duplicate row"
                                                onClick={() => duplicate(item.id)}
                                                className={ROW_ACTION}
                                            >
                                                <IconCopy size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                        <Tooltip label="Remove">
                                            <ActionIcon
                                                variant="subtle"
                                                color="gray"
                                                size="sm"
                                                aria-label="Remove row"
                                                onClick={() => remove(item.id)}
                                                className={ROW_ACTION}
                                            >
                                                <IconTrash size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                    </>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>
            <Text size="xs" aria-live="polite" className="text-dimmed mt-1.5">
                {enabledCount} enabled
            </Text>
        </div>
    );
}

export const KeyValueTable = memo(KeyValueTableInner) as typeof KeyValueTableInner;
