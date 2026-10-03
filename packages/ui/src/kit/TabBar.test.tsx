/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabBar, type TabListItem } from './index';

const items: TabListItem[] = [
    { id: 'a', title: 'Query 1', subtitle: 'Local › shop', dirty: true },
    { id: 'b', title: 'Query 2', subtitle: 'Prod › billing' },
    { id: 'c', title: 'orders (structure)', subtitle: 'Local › shop' },
];

function renderBar(props: { activeId?: string; onSelect?: (id: string) => void } = {}) {
    const onSelect = props.onSelect ?? vi.fn();
    render(
        <TabBar
            label="Open queries"
            noun="queries"
            items={items}
            activeId={props.activeId ?? 'a'}
            onSelect={onSelect}
            trailing={<button aria-label="New query">+</button>}
        >
            {items.map((item) => (
                <button
                    key={item.id}
                    role="tab"
                    aria-selected={item.id === (props.activeId ?? 'a')}
                    tabIndex={item.id === (props.activeId ?? 'a') ? 0 : -1}
                >
                    {item.title}
                </button>
            ))}
        </TabBar>,
    );
    return { onSelect };
}

/** jsdom has no layout, so a scroller is given the sizes a real one would report. */
const layout = (scrollWidth: number, clientWidth: number, scrollLeft = 0) => {
    const list = screen.getByRole('tablist', { name: 'Open queries' });
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: scrollWidth });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: clientWidth });
    list.scrollLeft = scrollLeft;
    list.scrollBy = vi.fn() as unknown as typeof list.scrollBy;
    act(() => {
        list.dispatchEvent(new Event('scroll'));
    });
    return list;
};

afterEach(cleanup);

describe('the scroll buttons', () => {
    it('are compact, fixed beside the tabs and disabled while nothing overflows', async () => {
        renderBar();
        layout(300, 300);
        const left = screen.getByRole('button', { name: 'Scroll queries left' });
        const right = screen.getByRole('button', { name: 'Scroll queries right' });
        await waitFor(() => {
            expect(left.hasAttribute('disabled')).toBe(true);
            expect(right.hasAttribute('disabled')).toBe(true);
        });
        // They are siblings of the scrolling list, not inside it, so they never overlap a tab.
        const list = screen.getByRole('tablist', { name: 'Open queries' });
        expect(list.contains(left)).toBe(false);
        expect(list.contains(right)).toBe(false);
        expect(left.className).toMatch(/\bw-\[22px\]/);
    });

    it('enable only in the direction there is more, and scroll the list', async () => {
        renderBar();
        const list = layout(1000, 300, 0);
        const left = screen.getByRole('button', { name: 'Scroll queries left' });
        const right = screen.getByRole('button', { name: 'Scroll queries right' });
        await waitFor(() => expect(right.hasAttribute('disabled')).toBe(false));
        expect(left.hasAttribute('disabled')).toBe(true);

        fireEvent.click(right);
        expect(list.scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 210 }));

        layout(1000, 300, 700);
        await waitFor(() => expect(right.hasAttribute('disabled')).toBe(true));
        expect(left.hasAttribute('disabled')).toBe(false);
        fireEvent.click(left);
        expect(list.scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: -210 }));
    });

    it('keeps the trailing buttons outside the scrolling area', () => {
        renderBar();
        const list = screen.getByRole('tablist', { name: 'Open queries' });
        expect(list.contains(screen.getByRole('button', { name: 'New query' }))).toBe(false);
    });
});

describe('the all-tabs dropdown', () => {
    const open = () =>
        fireEvent.click(screen.getByRole('button', { name: 'Show all open queries' }));

    it('lists every tab with its context and unsaved state', () => {
        renderBar();
        open();
        const list = screen.getByRole('listbox', { name: 'Open queries' });
        const options = within(list).getAllByRole('option');
        expect(options).toHaveLength(3);
        expect(options[0]!.textContent).toContain('Query 1');
        expect(options[0]!.textContent).toContain('Local › shop');
        expect(within(options[0]!).getByLabelText('Unsaved changes')).toBeTruthy();
        expect(within(options[1]!).queryByLabelText('Unsaved changes')).toBeNull();
        expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    });

    it('activates the chosen tab immediately and closes', async () => {
        const { onSelect } = renderBar();
        open();
        fireEvent.click(screen.getByRole('option', { name: /Query 2/ }));
        expect(onSelect).toHaveBeenCalledWith('b');
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    });

    it('filters by a search on title or context', () => {
        renderBar();
        open();
        const search = screen.getByRole('combobox', { name: 'Search open queries' });
        fireEvent.change(search, { target: { value: 'billing' } });
        expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
            expect.stringContaining('Query 2'),
        ]);
        fireEvent.change(search, { target: { value: 'zzz' } });
        expect(screen.queryAllByRole('option')).toHaveLength(0);
        expect(screen.getByText('Nothing matches.')).toBeTruthy();
    });

    it('is driven from the keyboard: arrows move, Enter picks, Escape closes', async () => {
        const { onSelect } = renderBar();
        open();
        const search = screen.getByRole('combobox', { name: 'Search open queries' });
        // The active tab starts highlighted.
        expect(search.getAttribute('aria-activedescendant')).toMatch(/-0$/);
        fireEvent.keyDown(search, { key: 'ArrowDown' });
        fireEvent.keyDown(search, { key: 'ArrowDown' });
        expect(search.getAttribute('aria-activedescendant')).toMatch(/-2$/);
        fireEvent.keyDown(search, { key: 'ArrowDown' });
        expect(search.getAttribute('aria-activedescendant')).toMatch(/-0$/);
        fireEvent.keyDown(search, { key: 'ArrowUp' });
        fireEvent.keyDown(search, { key: 'Enter' });
        expect(onSelect).toHaveBeenCalledWith('c');
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

        open();
        fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search open queries' }), {
            key: 'Escape',
        });
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    });

    it('scrolls inside itself when there are many tabs', () => {
        renderBar();
        open();
        const list = screen.getByRole('listbox', { name: 'Open queries' });
        expect(list.className).toMatch(/overflow-y-auto/);
    });
});

describe('keyboard movement between tabs', () => {
    it('moves focus with the arrow keys and wraps', () => {
        renderBar();
        const tabs = screen.getAllByRole('tab');
        tabs[0]!.focus();
        fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(tabs[1]);
        fireEvent.keyDown(tabs[1]!, { key: 'End' });
        expect(document.activeElement).toBe(tabs[2]);
        fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
        expect(document.activeElement).toBe(tabs[0]);
        fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(tabs[2]);
        fireEvent.keyDown(tabs[2]!, { key: 'Home' });
        expect(document.activeElement).toBe(tabs[0]);
    });
});
