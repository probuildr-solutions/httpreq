/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsSection } from './ConnectionsSection';
import { DbManagerContext, type DbManagerApi } from './useDbManager';
import { useProfiles, type ConnectionProfile } from './profiles';
import { resetLive, useLive } from './queryStore';

const profile = (id: string, name: string, host: string): ConnectionProfile => ({
    id: id.padEnd(16, '0'),
    name,
    settings: { engine: 'mysql', host, port: 3306, tls: { mode: 'prefer' } },
    group: '',
    favorite: false,
    lastUsed: null,
});

const manager = {
    available: true,
    engines: [],
    toggle: vi.fn(),
    connect: vi.fn(),
} as unknown as DbManagerApi;

beforeEach(() => {
    useProfiles.setState({
        profiles: [
            profile('a', 'Alpha server', 'a.example.com'),
            profile('b', 'Beta server', 'b.example.com'),
        ],
    });
    resetLive();
});
afterEach(cleanup);

const renderSection = () =>
    render(
        <DbManagerContext.Provider value={manager}>
            <ConnectionsSection />
        </DbManagerContext.Provider>,
    );

const treeNames = () => screen.queryAllByRole('treeitem').map((item) => item.textContent ?? '');

describe('connections header and search', () => {
    it('keeps the header outside the scrolling tree, at a fixed height', () => {
        renderSection();
        const header = screen.getByText('Connections').parentElement!;
        const tree = screen.getByRole('tree');
        expect(header.className).toMatch(/\bh-8\b/);
        expect(header.contains(tree)).toBe(false);
        expect(tree.closest('[class*="overflow-auto"]')).not.toBeNull();
    });

    it('opens a search field in the header without changing the header or the tree', () => {
        renderSection();
        const header = screen.getByText('Connections').parentElement!;
        const classBefore = header.className;
        fireEvent.click(screen.getByRole('button', { name: 'Search connections' }));
        const box = screen.getByRole('searchbox', { name: 'Search connections' });
        expect(document.activeElement).toBe(box);
        // the same strip, same height, with the field in it
        expect(box.closest('div')!.className).toBe(classBefore);
        expect(treeNames()).toHaveLength(2);
    });

    it('filters connections as you type, clears with X and restores the whole list', () => {
        renderSection();
        fireEvent.click(screen.getByRole('button', { name: 'Search connections' }));
        const box = screen.getByRole('searchbox') as HTMLInputElement;
        fireEvent.change(box, { target: { value: 'alp' } });
        expect(treeNames().join()).toContain('Alpha server');
        expect(treeNames().join()).not.toContain('Beta server');

        fireEvent.change(box, { target: { value: 'zzz' } });
        expect(screen.getByText(/Nothing matches/)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
        expect(box.value).toBe('');
        expect(treeNames()).toHaveLength(2);
        expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    });

    it('closing the search (button or Escape) restores the title and the full tree, and keeps what was expanded', () => {
        const id = 'a'.padEnd(16, '0');
        const key = ['c', id].join('\u001f');
        useLive.setState({ expanded: new Set([key]) });
        renderSection();
        fireEvent.click(screen.getByRole('button', { name: 'Search connections' }));
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'beta' } });
        expect(treeNames()).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
        expect(screen.getByText('Connections')).toBeTruthy();
        expect(treeNames()).toHaveLength(2);
        expect(useLive.getState().expanded.has(key)).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Search connections' }));
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'x' } });
        fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
        expect(screen.queryByRole('searchbox')).toBeNull();
        expect(treeNames()).toHaveLength(2);
    });

    it('offers no search when there are no connections', () => {
        useProfiles.setState({ profiles: [] });
        renderSection();
        expect(screen.queryByRole('button', { name: 'Search connections' })).toBeNull();
        expect(screen.getByRole('button', { name: 'New connection' })).toBeTruthy();
    });
});
