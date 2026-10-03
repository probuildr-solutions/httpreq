/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** What the all-tabs list shows for each tab. */
export interface TabListItem {
    id: string;
    title: string;
    /** A second line: the connection and database a query tab works on. */
    subtitle?: string;
    dirty?: boolean;
    icon?: ReactNode;
}

const prefersReducedMotion = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How far the list can still scroll each way, kept current as tabs and the window change size. */
export function useTabOverflow() {
    const listRef = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ canLeft: false, canRight: false });

    const measure = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const canLeft = list.scrollLeft > 1;
        const canRight = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
        setEdges((current) =>
            current.canLeft === canLeft && current.canRight === canRight
                ? current
                : { canLeft, canRight },
        );
    }, []);

    useEffect(() => {
        const list = listRef.current;
        if (!list) return;
        measure();
        let frame = 0;
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                measure();
            });
        };
        const observer =
            typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
        observer?.observe(list);
        const mutations =
            typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
        // Tabs come and go, and their labels change width.
        mutations?.observe(list, { childList: true, subtree: true, characterData: true });
        list.addEventListener('scroll', schedule, { passive: true });
        return () => {
            cancelAnimationFrame(frame);
            observer?.disconnect();
            mutations?.disconnect();
            list.removeEventListener('scroll', schedule);
        };
    }, [measure]);

    const scrollPage = useCallback((direction: 1 | -1) => {
        const list = listRef.current;
        if (!list) return;
        list.scrollBy({
            left: direction * Math.max(80, list.clientWidth * 0.7),
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
    }, []);

    return { listRef, ...edges, scrollPage, measure };
}

/** Narrows `items` to those whose title or context contains every word of `query`. */
export const filterTabItems = (items: TabListItem[], query: string): TabListItem[] => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return items;
    return items.filter((item) => {
        const haystack = `${item.title} ${item.subtitle ?? ''}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
    });
};
