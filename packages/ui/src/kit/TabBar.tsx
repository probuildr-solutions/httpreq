/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    IconChevronDown,
    IconChevronLeft,
    IconChevronRight,
    IconSearch,
} from '@tabler/icons-react';
import {
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { ActionIcon, UnstyledButton } from './buttons';
import { filterTabItems, useTabOverflow, type TabListItem } from './tabBarUtils';
import { cx } from './cx';
import { Popover, Tooltip } from './overlays';

export interface TabBarProps {
    /** The accessible name of the tab list. */
    label: string;
    /** Every open tab, for the dropdown. Tabs render themselves as `children`. */
    items: TabListItem[];
    activeId: string | null;
    onSelect: (id: string) => void;
    /** The tab elements, each with `role="tab"`. They live in the scrolling area. */
    children: ReactNode;
    /** Fixed controls after the overflow buttons: a new-tab button, the task centre. */
    trailing?: ReactNode;
    /** Hides the dropdown (a strip of two result tabs does not need one). */
    withList?: boolean;
    className?: string;
    /** Tab-list noun for the buttons: "tabs", "queries", "results". */
    noun?: string;
}

/**
 * One tab strip for every kind of tab (queries, result sets, table editors, files). The tabs
 * scroll horizontally in the middle; the chevrons, the all-tabs list and the trailing buttons stay
 * fixed beside them, so they never overlap a tab. The chevrons disable at the ends, the active tab
 * is scrolled into view, a vertical wheel scrolls sideways, and the arrow keys, Home and End move
 * between tabs. The list of all open tabs has a search and is operated from the keyboard.
 */
export function TabBar({
    label,
    items,
    activeId,
    onSelect,
    children,
    trailing,
    withList = true,
    className,
    noun = 'tabs',
}: TabBarProps) {
    const { listRef, canLeft, canRight, scrollPage } = useTabOverflow();

    // Keep the active tab whole in view whenever it changes.
    useLayoutEffect(() => {
        const list = listRef.current;
        const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        if (!list || !tab) return;
        const left =
            tab.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
        const right = left + tab.offsetWidth;
        if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - 8);
        else if (right > list.scrollLeft + list.clientWidth)
            list.scrollLeft = right - list.clientWidth + 8;
    }, [activeId, items.length, listRef]);

    // A vertical wheel scrolls the strip sideways; trackpads already send horizontal deltas.
    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const onWheel = (event: WheelEvent) => {
            if (list.scrollWidth <= list.clientWidth) return;
            if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
            event.preventDefault();
            list.scrollLeft +=
                event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
        };
        list.addEventListener('wheel', onWheel, { passive: false });
        return () => list.removeEventListener('wheel', onWheel);
    }, [listRef]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
        const current = tabs.indexOf(document.activeElement as HTMLElement);
        if (current < 0) return;
        event.preventDefault();
        const next =
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus();
        tabs[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };

    return (
        <div
            className={cx(
                'flex h-[var(--hr-strip-height)] min-w-0 flex-none items-stretch border-b border-line bg-chrome',
                className,
            )}
        >
            <TabBarButton
                label={`Scroll ${noun} left`}
                disabled={!canLeft}
                onClick={() => scrollPage(-1)}
            >
                <IconChevronLeft size={14} />
            </TabBarButton>
            <div
                ref={listRef}
                role="tablist"
                aria-label={label}
                onKeyDown={onKeyDown}
                className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain"
            >
                {children}
            </div>
            <TabBarButton
                label={`Scroll ${noun} right`}
                disabled={!canRight}
                onClick={() => scrollPage(1)}
            >
                <IconChevronRight size={14} />
            </TabBarButton>
            {withList && (
                <TabListButton items={items} activeId={activeId} onSelect={onSelect} noun={noun} />
            )}
            {trailing}
        </div>
    );
}

function TabBarButton({
    label,
    disabled,
    onClick,
    children,
}: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="grid w-[22px] flex-none place-items-center border-0 bg-transparent p-0 text-dimmed transition-colors hover:bg-chrome-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
        >
            {children}
        </button>
    );
}

/** The dropdown of every open tab: a search, one row per tab, and the keyboard to move through them. */
function TabListButton({
    items,
    activeId,
    onSelect,
    noun,
}: {
    items: TabListItem[];
    activeId: string | null;
    onSelect: (id: string) => void;
    noun: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [highlight, setHighlight] = useState(0);
    const listId = useId();
    const input = useRef<HTMLInputElement>(null);
    const rows = useMemo(() => filterTabItems(items, query), [items, query]);

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setHighlight(
            Math.max(
                0,
                items.findIndex((item) => item.id === activeId),
            ),
        );
        const timer = setTimeout(() => input.current?.focus(), 0);
        return () => clearTimeout(timer);
        // Opening resets the search; later changes to the tabs must not.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // The highlighted row stays in view as the arrow keys move it.
    useEffect(() => {
        if (!open) return;
        document.getElementById(`${listId}-${highlight}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [highlight, open, listId]);

    const pick = (id: string) => {
        onSelect(id);
        setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (rows.length === 0) return;
            setHighlight(
                (index) =>
                    (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length,
            );
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            setHighlight(event.key === 'Home' ? 0 : Math.max(0, rows.length - 1));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const row = rows[Math.min(highlight, rows.length - 1)];
            if (row) pick(row.id);
        }
    };

    return (
        <Popover
            opened={open}
            onClose={() => setOpen(false)}
            position="bottom-end"
            width={320}
            closeOnClickOutside
        >
            <Tooltip label={`Show all open ${noun}`}>
                <Popover.Target>
                    <ActionIcon
                        size={22}
                        variant="subtle"
                        aria-label={`Show all open ${noun}`}
                        aria-expanded={open}
                        onClick={() => setOpen((current) => !current)}
                        className="my-auto mr-0.5 flex-none"
                    >
                        <IconChevronDown size={14} />
                    </ActionIcon>
                </Popover.Target>
            </Tooltip>
            <Popover.Dropdown className="flex max-h-[min(420px,70vh)] flex-col p-0">
                <div className="flex flex-none items-center gap-1.5 border-b border-line px-2.5 py-1.5">
                    <IconSearch size={13} className="flex-none text-dimmed" aria-hidden />
                    <input
                        ref={input}
                        role="combobox"
                        aria-expanded
                        aria-controls={listId}
                        aria-activedescendant={rows.length ? `${listId}-${highlight}` : undefined}
                        aria-label={`Search open ${noun}`}
                        placeholder={`Search ${items.length} open ${noun}`}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setHighlight(0);
                        }}
                        onKeyDown={onKeyDown}
                        className="h-6 min-w-0 flex-1 border-0 bg-transparent text-xs outline-none placeholder:text-placeholder"
                    />
                </div>
                <div
                    id={listId}
                    role="listbox"
                    aria-label={`Open ${noun}`}
                    className="min-h-0 flex-1 overflow-y-auto p-1"
                >
                    {rows.length === 0 && (
                        <div className="px-2.5 py-2 text-xs text-dimmed">Nothing matches.</div>
                    )}
                    {rows.map((item, index) => (
                        <UnstyledButton
                            key={item.id}
                            id={`${listId}-${index}`}
                            role="option"
                            aria-selected={item.id === activeId}
                            tabIndex={-1}
                            onMouseEnter={() => setHighlight(index)}
                            onClick={() => pick(item.id)}
                            className={cx(
                                'flex w-full items-center gap-2 rounded-xs px-2.5 py-1.5 text-sm',
                                index === highlight && 'bg-hover',
                                item.id === activeId && 'bg-primary-soft text-primary-text',
                            )}
                        >
                            {item.icon && <span className="flex flex-none">{item.icon}</span>}
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate">{item.title}</span>
                                {item.subtitle && (
                                    <span className="truncate text-[11px] text-dimmed">
                                        {item.subtitle}
                                    </span>
                                )}
                            </span>
                            {item.dirty && (
                                <span
                                    aria-label="Unsaved changes"
                                    className="size-1.5 flex-none rounded-full bg-primary"
                                />
                            )}
                        </UnstyledButton>
                    ))}
                </div>
            </Popover.Dropdown>
        </Popover>
    );
}
