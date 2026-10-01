/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconListCheck, IconTrash, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { ActionIcon, Button, Checkbox, Text, Tooltip, type ButtonProps } from '../kit';
import type { Selection } from './useSelection';

/** The panel-header button that enters and leaves selection mode. */
export function SelectModeButton({ selection, noun }: { selection: Selection; noun: string }) {
    if (selection.total === 0 && !selection.selecting) return null;
    const label = selection.selecting ? 'Cancel selection' : `Select ${noun}`;
    return (
        <Tooltip label={label}>
            <ActionIcon
                variant={selection.selecting ? 'light' : 'subtle'}
                size="sm"
                aria-label={label}
                aria-pressed={selection.selecting}
                onClick={selection.selecting ? selection.stop : selection.start}
            >
                {selection.selecting ? <IconX size={15} /> : <IconListCheck size={15} />}
            </ActionIcon>
        </Tooltip>
    );
}

/**
 * The toolbar under a panel header in selection mode: Select all, the number selected, and the
 * panel's bulk actions. Every sidebar list uses it, so selection looks and works the same everywhere.
 */
export function SelectionBar({
    selection,
    label,
    children,
}: {
    selection: Selection;
    /** Names the list for assistive technology, e.g. “Environment selection”. */
    label: string;
    children: ReactNode;
}) {
    if (!selection.selecting || selection.total === 0) return null;
    return (
        <div
            className="flex min-h-[34px] items-center gap-2 border-b border-line py-1 pr-2 pl-3"
            role="toolbar"
            aria-label={label}
        >
            <Checkbox
                size="xs"
                label="Select all"
                className="whitespace-nowrap"
                checked={selection.allSelected}
                indeterminate={selection.count > 0 && !selection.allSelected}
                onChange={selection.toggleAll}
            />
            <Text size="xs" className="min-w-0 flex-1 truncate text-dimmed" aria-live="polite">
                {selection.count} selected
            </Text>
            {children}
        </div>
    );
}

/** A bulk action in the selection bar; disabled until something is selected. */
export function BulkButton({
    selection,
    label,
    title,
    icon,
    onClick,
    ...props
}: {
    selection: Selection;
    label: string;
    title: string;
    icon: ReactNode;
    onClick: () => void;
} & ButtonProps) {
    return (
        <Button
            size="compact-xs"
            variant="light"
            leftSection={icon}
            disabled={selection.count === 0}
            aria-label={title}
            title={title}
            onClick={onClick}
            {...props}
        >
            {label}
        </Button>
    );
}

/** The Delete action every selectable list offers. */
export function BulkDeleteButton({
    selection,
    noun,
    onDelete,
}: {
    selection: Selection;
    noun: string;
    onDelete: () => void;
}) {
    return (
        <BulkButton
            selection={selection}
            color="red"
            label="Delete"
            title={`Delete selected ${noun}`}
            icon={<IconTrash size={13} />}
            onClick={onDelete}
        />
    );
}

/** The checkbox that replaces a row's usual leading control in selection mode. */
export function RowCheckbox({
    checked,
    label,
    onChange,
}: {
    checked: boolean;
    label: string;
    onChange: () => void;
}) {
    return (
        <Checkbox
            size="xs"
            checked={checked}
            onChange={onChange}
            aria-label={label}
            className="flex-none"
            // The row itself toggles on click; the box must not toggle it a second time.
            onClick={(event) => event.stopPropagation()}
        />
    );
}
