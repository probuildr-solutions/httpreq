/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { closeTargets, moveTab, nextActive, pinnedFirst } from './tabCommands';

const strip = (spec: string) =>
    spec.split(' ').map((item) => ({ id: item.replace('*', ''), pinned: item.endsWith('*') }));

describe('close commands', () => {
    const tabs = strip('a* b c d* e');

    it('closes tabs to the left, to the right and the others, keeping pinned tabs', () => {
        expect(closeTargets(tabs, 'c', 'left')).toEqual(['b']);
        expect(closeTargets(tabs, 'c', 'right')).toEqual(['e']);
        expect(closeTargets(tabs, 'c', 'others')).toEqual(['b', 'e']);
        expect(closeTargets(tabs, 'c', 'all')).toEqual(['b', 'c', 'e']);
    });

    it('closes pinned tabs only when asked to include them', () => {
        expect(closeTargets(tabs, 'c', 'left', true)).toEqual(['a', 'b']);
        expect(closeTargets(tabs, 'c', 'others', true)).toEqual(['a', 'b', 'd', 'e']);
        expect(closeTargets(tabs, 'c', 'all', true)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('always closes the one tab that was pointed at', () => {
        expect(closeTargets(tabs, 'a', 'self')).toEqual(['a']);
    });

    it('does nothing for a tab that is not open, or when nothing is on that side', () => {
        expect(closeTargets(tabs, 'zz', 'left')).toEqual([]);
        expect(closeTargets(strip('a b'), 'a', 'left')).toEqual([]);
        expect(closeTargets(strip('a b'), 'b', 'right')).toEqual([]);
    });
});

describe('order', () => {
    it('keeps pinned tabs first', () => {
        expect(pinnedFirst(['a', 'b', 'c', 'd'], new Set(['c', 'd']))).toEqual([
            'c',
            'd',
            'a',
            'b',
        ]);
    });

    it('moves a tab within its own group only', () => {
        const pinned = new Set(['a', 'b']);
        const order = ['a', 'b', 'c', 'd'];
        expect(moveTab(order, 'd', 'c', pinned)).toEqual(['a', 'b', 'd', 'c']);
        expect(moveTab(order, 'c', 'd', pinned)).toEqual(['a', 'b', 'd', 'c']);
        expect(moveTab(order, 'a', 'b', pinned)).toEqual(['b', 'a', 'c', 'd']);
        // across the pinned boundary: refused
        expect(moveTab(order, 'c', 'a', pinned)).toEqual(order);
        expect(moveTab(order, 'a', 'a', pinned)).toEqual(order);
    });

    it('selects the neighbour of a closed active tab', () => {
        const order = ['a', 'b', 'c', 'd'];
        expect(nextActive(order, new Set(['b']), 'b')).toBe('c');
        expect(nextActive(order, new Set(['c', 'd']), 'c')).toBe('b');
        expect(nextActive(order, new Set(order), 'b')).toBeNull();
        expect(nextActive(order, new Set(['a']), 'c')).toBe('c');
    });
});
