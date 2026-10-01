/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
} from 'react';
import { Tabs, cx } from './kit';

interface Props extends ComponentPropsWithoutRef<'div'> {
    /** The selected tab's value; it is scrolled into view whenever it changes. */
    active: string | null;
    /** Class for the outer frame (borders, padding); `className` styles the list itself. */
    frameClassName?: string;
}

/** Room left beside a tab revealed at an edge, so the fade never covers its label. */
const EDGE_PADDING = 28;

const prefersReducedMotion = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The fade over whichever edge has more tabs behind it. */
const FADE = {
    end: '[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)]',
    start: '[mask-image:linear-gradient(to_left,#000_calc(100%-40px),transparent)]',
    both: '[mask-image:linear-gradient(to_right,transparent,#000_40px,#000_calc(100%-40px),transparent)]',
} as const;

const SCROLL_BUTTON =
    'absolute top-0 bottom-0.5 grid w-[22px] place-items-center border-0 bg-transparent p-0 text-dimmed hover:text-fg';

/**
 * A tab list that never wraps or squeezes its tabs: when the pane is too narrow it scrolls
 * horizontally instead.
 *
 * Every pointer gets a way through. A vertical mouse wheel scrolls it sideways, trackpads and
 * touch scroll natively, and chevrons appear at an edge that has more tabs behind it. Keyboard
 * users move with the arrow keys, which focus (and so reveal) each tab. The overflow is measured
 * with a ResizeObserver, so dragging the request/response splitter, resizing the sidebar or the
 * window, or switching the response between right and bottom all update it.
 *
 * The frame carries the rule under the tabs, so it stays put while the list scrolls and fades;
 * the active tab's border paints over this inset shadow.
 */
export function ScrollableTabsList({
    active,
    frameClassName,
    className,
    children,
    ...props
}: Props) {
    const listRef = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: false, end: false });

    const measure = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const start = list.scrollLeft > 1;
        const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
        setEdges((current) =>
            current.start === start && current.end === end ? current : { start, end },
        );
    }, []);

    /** Scrolls the list just enough to show the selected tab whole. */
    const revealActive = useCallback(() => {
        const list = listRef.current;
        const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        if (!list || !tab) return;
        const left =
            tab.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
        const right = left + tab.offsetWidth;
        if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - EDGE_PADDING);
        else if (right > list.scrollLeft + list.clientWidth) {
            list.scrollLeft = right - list.clientWidth + EDGE_PADDING;
        }
    }, []);

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        let frame = 0;
        let resized = false;
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                // A narrower pane must not leave the selected tab behind the edge; a scroll by
                // the user is left alone.
                if (resized) revealActive();
                resized = false;
                measure();
            });
        };
        const onResize = () => {
            resized = true;
            schedule();
        };
        measure();
        const observer =
            typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
        observer?.observe(list);
        // The tabs themselves change width too (a count badge appearing, a font loading late).
        for (const child of list.children) observer?.observe(child);
        list.addEventListener('scroll', schedule, { passive: true });

        // A vertical wheel scrolls the strip sideways; trackpads already send horizontal deltas.
        const onWheel = (event: WheelEvent) => {
            if (list.scrollWidth <= list.clientWidth) return;
            if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
            event.preventDefault();
            const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
            list.scrollLeft += event.deltaY * unit;
        };
        list.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            cancelAnimationFrame(frame);
            observer?.disconnect();
            list.removeEventListener('scroll', schedule);
            list.removeEventListener('wheel', onWheel);
        };
    }, [measure, revealActive]);

    // Keep the selected tab fully visible when the selection changes.
    useLayoutEffect(() => revealActive(), [active, revealActive]);

    const scrollPage = (direction: 1 | -1) => {
        const list = listRef.current;
        if (!list) return;
        list.scrollBy({
            left: direction * Math.max(80, list.clientWidth * 0.7),
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
    };

    const fade =
        edges.start && edges.end ? FADE.both : edges.end ? FADE.end : edges.start ? FADE.start : '';

    return (
        <div
            className={cx(
                'relative flex min-w-0 flex-none px-1.5 shadow-[inset_0_-2px_0_var(--color-line)]',
                frameClassName,
            )}
        >
            <Tabs.List
                ref={listRef}
                className={cx(
                    'no-scrollbar min-w-0 flex-auto flex-nowrap overflow-x-auto overflow-y-hidden overscroll-x-contain',
                    fade,
                    className,
                )}
                {...props}
            >
                {children}
            </Tabs.List>
            {/* Pointer-only affordances: keyboard users already reach every tab with the arrow keys. */}
            {edges.start && (
                <button
                    type="button"
                    className={cx(SCROLL_BUTTON, 'left-0')}
                    tabIndex={-1}
                    aria-hidden
                    onClick={() => scrollPage(-1)}
                >
                    <IconChevronLeft size={14} />
                </button>
            )}
            {edges.end && (
                <button
                    type="button"
                    className={cx(SCROLL_BUTTON, 'right-0')}
                    tabIndex={-1}
                    aria-hidden
                    onClick={() => scrollPage(1)}
                >
                    <IconChevronRight size={14} />
                </button>
            )}
        </div>
    );
}
