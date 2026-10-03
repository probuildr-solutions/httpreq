/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconChevronDown } from '@tabler/icons-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { findType, searchTypes, type DataTypeInfo } from '@httpreq/db-admin';
import { Popover, cx } from '../../../kit';

export interface TypeSelectProps {
    /** The engine's types: `dialect.typeCatalog`. */
    catalog: readonly DataTypeInfo[];
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
    /** Accepts a type that is not in the catalog (an enum or composite defined by the user). */
    allowCustom?: boolean;
    placeholder?: string;
    /** Sits in a grid cell: no frame of its own. */
    inCell?: boolean;
    disabled?: boolean;
}

interface Row {
    type: DataTypeInfo;
    index: number;
}

/**
 * A searchable drop-down of an engine's data types, grouped by category (numeric, string, date
 * and time…). Typing narrows the list; the arrow keys, Enter and Escape drive it. It reads the
 * catalog it is given and knows no engine, so MySQL, PostgreSQL and any later engine share it.
 * A type the catalog lacks (an enum the user created, `integer[]`) is kept when `allowCustom`.
 */
export function TypeSelect({
    catalog,
    value,
    onChange,
    ariaLabel,
    allowCustom = true,
    placeholder = 'Type',
    inCell,
    disabled,
}: TypeSelectProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState<string | null>(null);
    const [highlight, setHighlight] = useState(0);
    const listId = useId();
    const input = useRef<HTMLInputElement>(null);

    // While the list is open the input shows what is being searched; otherwise the chosen type.
    const text = query ?? value;
    const matches = useMemo(() => searchTypes(catalog, query ?? ''), [catalog, query]);

    const groups = useMemo(() => {
        const result: { category: string; rows: Row[] }[] = [];
        matches.forEach((type, index) => {
            const last = result[result.length - 1];
            if (last && last.category === type.category) last.rows.push({ type, index });
            else result.push({ category: type.category, rows: [{ type, index }] });
        });
        return result;
    }, [matches]);

    const close = () => {
        setOpen(false);
        setQuery(null);
    };
    const pick = (name: string) => {
        onChange(name);
        close();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
                setOpen(true);
                return;
            }
            if (matches.length === 0) return;
            setHighlight(
                (index) =>
                    (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
                    matches.length,
            );
        } else if (event.key === 'Enter') {
            if (!open) return;
            event.preventDefault();
            const typed = query?.trim() ?? '';
            // `integer[]` is not a catalog entry, but it is what was meant.
            if (allowCustom && /\[\d*\]$/.test(typed)) return pick(typed);
            const chosen = matches[Math.min(highlight, matches.length - 1)];
            if (chosen) pick(chosen.name);
            else if (allowCustom && typed) pick(typed);
        } else if (event.key === 'Escape' && open) {
            event.stopPropagation();
            close();
        }
    };

    return (
        <Popover
            opened={open}
            onClose={close}
            position="bottom-start"
            width={280}
            closeOnClickOutside
        >
            <Popover.Target>
                <div
                    className={cx(
                        'flex h-full w-full min-w-0 items-center',
                        !inCell &&
                            'h-[var(--control-h)] rounded-sm border border-line bg-field px-2',
                        disabled && 'opacity-60',
                    )}
                >
                    <input
                        ref={input}
                        role="combobox"
                        aria-label={ariaLabel}
                        aria-expanded={open}
                        aria-controls={open ? listId : undefined}
                        aria-autocomplete="list"
                        aria-activedescendant={
                            open && matches.length ? `${listId}-${highlight}` : undefined
                        }
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={placeholder}
                        disabled={disabled}
                        value={text}
                        onFocus={() => {
                            setOpen(true);
                            setHighlight(
                                Math.max(
                                    0,
                                    catalog.findIndex((type) => type.name === value.toLowerCase()),
                                ),
                            );
                        }}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setOpen(true);
                            setHighlight(0);
                        }}
                        onBlur={() => {
                            // Text typed in and left is kept: a known name or alias becomes the
                            // catalog's name, anything else stays as typed (a custom type).
                            const typed = query?.trim();
                            if (typed && allowCustom)
                                onChange(
                                    /\[\d*\]$/.test(typed)
                                        ? typed
                                        : (findType(catalog, typed)?.name ?? typed),
                                );
                            close();
                        }}
                        onKeyDown={onKeyDown}
                        className="min-w-0 flex-1 border-0 bg-transparent px-2 text-xs outline-none placeholder:text-placeholder"
                    />
                    <IconChevronDown size={12} aria-hidden className="mr-1 flex-none text-dimmed" />
                </div>
            </Popover.Target>
            <Popover.Dropdown className="max-h-72 overflow-y-auto p-1">
                <div id={listId} role="listbox" aria-label={`${ariaLabel} options`}>
                    {matches.length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-dimmed">
                            {allowCustom && query?.trim()
                                ? `Press Enter to use "${query.trim()}".`
                                : 'No type matches.'}
                        </div>
                    )}
                    {groups.map((group) => (
                        <div key={group.category} role="presentation">
                            <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-dimmed uppercase">
                                {group.category}
                            </div>
                            {group.rows.map(({ type, index }) => (
                                <div
                                    key={type.name}
                                    id={`${listId}-${index}`}
                                    role="option"
                                    aria-selected={type.name === value.toLowerCase()}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onMouseEnter={() => setHighlight(index)}
                                    onClick={() => pick(type.name)}
                                    className={cx(
                                        'flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1 text-xs',
                                        index === highlight && 'bg-hover',
                                        type.name === value.toLowerCase() &&
                                            'bg-primary-soft text-primary-text',
                                    )}
                                >
                                    <span className="min-w-0 flex-1 truncate">{type.name}</span>
                                    {type.hint && (
                                        <span className="flex-none text-[11px] text-dimmed">
                                            {type.hint}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </Popover.Dropdown>
        </Popover>
    );
}
