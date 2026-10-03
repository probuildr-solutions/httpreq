/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { filterTabItems } from './tabBarUtils';

const items = [
    { id: '1', title: 'Query 1', subtitle: 'Local › shop' },
    { id: '2', title: 'Query 2', subtitle: 'Prod › billing' },
    { id: '3', title: 'orders (structure)', subtitle: 'Local › shop' },
];

describe('filterTabItems', () => {
    it('keeps everything for an empty search', () => {
        expect(filterTabItems(items, '  ')).toEqual(items);
    });

    it('matches title and context, every word, ignoring case', () => {
        expect(filterTabItems(items, 'query').map((i) => i.id)).toEqual(['1', '2']);
        expect(filterTabItems(items, 'LOCAL shop').map((i) => i.id)).toEqual(['1', '3']);
        expect(filterTabItems(items, 'query billing').map((i) => i.id)).toEqual(['2']);
        expect(filterTabItems(items, 'nothing')).toEqual([]);
    });
});
