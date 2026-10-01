/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { Fragment, useMemo } from 'react';
import { confirmAction } from '../confirm';
import { Button, Text, UnstyledButton, cx, notifications } from '../kit';
import { methodText } from '../methods';
import { useWorkbenchStore } from '../store';
import { PanelHeader } from './PanelHeader';
import { BulkDeleteButton, RowCheckbox, SelectionBar, SelectModeButton } from './Selection';
import { useSelection } from './useSelection';
import { EXPLORER, METHOD_LABEL, ROW_NAME, SECTION_HEADING, SIMPLE_ROW, TREE } from './styles';

const dayLabel = (date: Date) => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

export function HistoryPanel({
    onClear,
    onRemove,
    onOpened,
}: {
    onClear: () => void;
    onRemove: (entryIds: string[]) => Promise<void>;
    onOpened?: () => void;
}) {
    const history = useWorkbenchStore((state) => state.history);
    const requests = useWorkbenchStore((state) => state.workspace.requests);
    const openRequest = useWorkbenchStore((state) => state.openRequest);
    const names = useMemo(
        () => new Map(requests.map((request) => [request.id, request.name])),
        [requests],
    );
    const selection = useSelection(useMemo(() => history.map((entry) => entry.id), [history]));

    const removeSelected = async () => {
        const ids = selection.ids;
        if (ids.length === 0) return;
        const result = await confirmAction({
            title:
                ids.length === 1 ? 'Delete history entry' : `Delete ${ids.length} history entries`,
            message: `Remove ${ids.length === 1 ? 'this entry' : `these ${ids.length} entries`} from the request history? The requests themselves are not affected.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (result !== 'confirm') return;
        try {
            await onRemove(ids);
            selection.stop();
        } catch {
            notifications.show({ color: 'red', message: 'The history could not be updated.' });
        }
    };

    let lastDay = '';
    return (
        <div className={EXPLORER}>
            <PanelHeader title="History">
                <SelectModeButton selection={selection} noun="history entries" />
                {history.length > 0 && !selection.selecting && (
                    <Button size="compact-xs" variant="subtle" color="gray" onClick={onClear}>
                        Clear
                    </Button>
                )}
            </PanelHeader>
            <SelectionBar selection={selection} label="History selection">
                <BulkDeleteButton
                    selection={selection}
                    noun="history entries"
                    onDelete={() => void removeSelected()}
                />
            </SelectionBar>
            <div className={TREE} role="list" aria-label="Request history">
                {history.length === 0 && (
                    <Text size="xs" className="px-3 py-1 text-dimmed">
                        Sent requests appear here.
                    </Text>
                )}
                {history.map((entry) => {
                    const date = new Date(entry.timestamp);
                    const day = dayLabel(date);
                    const heading = day !== lastDay;
                    lastDay = day;
                    // Names are looked up by id, so renamed requests show their current name.
                    const current = names.get(entry.requestId);
                    const checked = selection.isSelected(entry.id);
                    const label = current ?? entry.name;
                    return (
                        <Fragment key={entry.id}>
                            {heading && <div className={SECTION_HEADING}>{day}</div>}
                            <UnstyledButton
                                // A checkbox cannot sit inside a button, so in selection mode the row is a plain
                                // element whose click toggles that checkbox.
                                component={selection.selecting ? 'div' : 'button'}
                                role="listitem"
                                className={cx(
                                    SIMPLE_ROW,
                                    'flex h-[26px] w-full items-center gap-1.5 px-1.5',
                                    'hover:not-disabled:bg-chrome-hover disabled:cursor-default',
                                )}
                                data-checked={checked || undefined}
                                data-selectable={selection.selecting || undefined}
                                disabled={!current && !selection.selecting}
                                onClick={() => {
                                    if (selection.selecting) {
                                        selection.toggle(entry.id);
                                        return;
                                    }
                                    openRequest(entry.requestId);
                                    onOpened?.();
                                }}
                                title={
                                    current
                                        ? `${entry.method} ${entry.url}`
                                        : 'This request was deleted'
                                }
                            >
                                {selection.selecting && (
                                    <RowCheckbox
                                        checked={checked}
                                        label={`${entry.method} ${label}`}
                                        onChange={() => selection.toggle(entry.id)}
                                    />
                                )}
                                <span className={cx(METHOD_LABEL, methodText[entry.method])}>
                                    {entry.method === 'DELETE'
                                        ? 'DEL'
                                        : entry.method === 'OPTIONS'
                                          ? 'OPT'
                                          : entry.method}
                                </span>
                                <span className={ROW_NAME} data-deleted={!current || undefined}>
                                    {label}
                                </span>
                                <Text
                                    component="span"
                                    size="xs"
                                    className={
                                        entry.status !== null && entry.status < 400
                                            ? 'text-success-text'
                                            : 'text-danger-text'
                                    }
                                >
                                    {entry.status ?? 'ERR'}
                                </Text>
                                <Text component="span" size="xs" className="text-dimmed">
                                    {date.toLocaleTimeString(undefined, {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    })}
                                </Text>
                            </UnstyledButton>
                        </Fragment>
                    );
                })}
            </div>
        </div>
    );
}
