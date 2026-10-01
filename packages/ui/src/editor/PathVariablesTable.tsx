/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { KeyValueItem } from '@httpreq/shared';
import { VariableInput } from './VariableInput';
import { Text, cx } from '../kit';

/** The description column is the first to go when the request pane is narrow. */
const NARROW_HIDDEN = '@max-[620px]/request-editor:hidden';

interface Props {
    items: KeyValueItem[];
    onChange: (items: KeyValueItem[]) => void;
}

/**
 * Values for the `:name` segments of the URL. The rows follow the URL (they are created and
 * removed as it is typed), so only the value and description are editable here.
 */
export function PathVariablesTable({ items, onChange }: Props) {
    if (items.length === 0) return null;
    const update = (id: string, patch: Partial<KeyValueItem>) =>
        onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    return (
        <section className="mt-4" aria-label="Path variables">
            <Text size="xs" className="mb-1.5 font-semibold text-dimmed">
                Path variables
            </Text>
            <div
                role="table"
                className="grid grid-cols-[minmax(110px,1fr)_minmax(140px,1.6fr)_minmax(90px,1fr)] overflow-hidden rounded-sm border border-line @max-[620px]/request-editor:grid-cols-[minmax(90px,1fr)_minmax(110px,1.6fr)]"
            >
                {['Key', 'Value', 'Description'].map((name) => (
                    <span
                        key={name}
                        role="columnheader"
                        className={cx(
                            'flex h-[29px] min-w-0 items-center border-b border-l border-line bg-chrome px-2 text-[11px] font-semibold text-dimmed first:border-l-0',
                            name === 'Description' && NARROW_HIDDEN,
                        )}
                    >
                        {name}
                    </span>
                ))}
                {items.map((item) => (
                    <div key={item.id} role="row" className="group/row contents">
                        <span
                            role="cell"
                            className="flex h-[29px] min-w-0 items-center overflow-hidden border-b border-line px-2 font-mono text-[12.5px] text-dimmed group-last/row:border-b-0"
                            title={item.key}
                        >
                            <span className="min-w-0 truncate">{item.key}</span>
                        </span>
                        <span
                            role="cell"
                            className="flex h-[29px] min-w-0 items-center overflow-hidden border-b border-l border-line *:min-w-0 *:flex-1 group-last/row:border-b-0"
                        >
                            <VariableInput
                                variant="cell"
                                aria-label={`Value of ${item.key}`}
                                placeholder="Value"
                                value={item.value}
                                onChange={(value) => update(item.id, { value })}
                            />
                        </span>
                        <span
                            role="cell"
                            className={cx(
                                'flex h-[29px] min-w-0 items-center overflow-hidden border-b border-l border-line *:min-w-0 *:flex-1 group-last/row:border-b-0',
                                NARROW_HIDDEN,
                            )}
                        >
                            <VariableInput
                                variant="cell"
                                mono={false}
                                completion={false}
                                aria-label={`Description of ${item.key}`}
                                placeholder="Description"
                                value={item.description ?? ''}
                                onChange={(description) => update(item.id, { description })}
                            />
                        </span>
                    </div>
                ))}
            </div>
        </section>
    );
}
