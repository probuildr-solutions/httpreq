/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/// <reference types="@testing-library/jest-dom/vitest" />
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestTabs, type TabItem } from './RequestTabs';

const requests: TabItem[] = ['One', 'Two', 'Three'].map((name, index) => ({
    id: `r${index}`,
    kind: 'request',
    name,
    method: 'GET' as const,
    url: '',
}));

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollTo ??= () => undefined;
});

const setup = (unsaved: string[] = []) => {
    const handlers = {
        onActivate: vi.fn(),
        onClose: vi.fn(),
        onCloseMany: vi.fn(),
        onNew: vi.fn(),
        onMove: vi.fn(),
    };
    render(
        <>
            <RequestTabs
                requests={requests}
                activeId="r1"
                unsavedIds={new Set(unsaved)}
                {...handlers}
            />
        </>,
    );
    const tablist = screen.getByRole('tablist', { name: 'Open requests' });
    return { handlers, tablist, tabs: within(tablist).getAllByRole('tab') };
};

describe('RequestTabs', () => {
    it('exposes the tabs pattern with a single tab stop on the active tab', () => {
        const { tabs } = setup();
        expect(tabs).toHaveLength(3);
        expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
            'false',
            'true',
            'false',
        ]);
        expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
        expect(tabs[1]!).toHaveAttribute('aria-controls', 'request-panel');
        expect(screen.getByRole('button', { name: 'Close Two' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scroll to previous tabs' })).toBeDisabled();
    });

    it('moves focus with arrows, Home and End without activating', () => {
        const { tabs, handlers } = setup();
        tabs[1]!.focus();
        fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
        expect(tabs[2]!).toHaveFocus();
        fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
        expect(tabs[0]!).toHaveFocus();
        fireEvent.keyDown(tabs[0]!, { key: 'End' });
        expect(tabs[2]!).toHaveFocus();
        fireEvent.keyDown(tabs[2]!, { key: 'Home' });
        expect(tabs[0]!).toHaveFocus();
        expect(handlers.onActivate).not.toHaveBeenCalled();
        fireEvent.click(tabs[0]!);
        expect(handlers.onActivate).toHaveBeenCalledWith('r0');
    });

    it('closes the focused tab with Delete and by middle click', () => {
        const { tabs, handlers } = setup();
        tabs[2]!.focus();
        fireEvent.keyDown(tabs[2]!, { key: 'Delete' });
        expect(handlers.onClose).toHaveBeenCalledWith('r2');
        fireEvent(
            tabs[0]!.parentElement!,
            new MouseEvent('auxclick', { bubbles: true, button: 1 }),
        );
        expect(handlers.onClose).toHaveBeenCalledWith('r0');
    });

    it('announces unsaved changes in the accessible name', () => {
        const { tabs } = setup(['r0']);
        expect(tabs[0]!).toHaveAccessibleName(/One \(unsaved changes\)/);
    });

    describe('context menu', () => {
        const openMenuOn = async (tab: HTMLElement) => {
            fireEvent.contextMenu(tab.parentElement!);
            return within(await screen.findByLabelText('Tab actions'));
        };

        it('closes only the clicked tab', async () => {
            const { tabs, handlers } = setup();
            const menu = await openMenuOn(tabs[1]!);
            fireEvent.click(menu.getByRole('menuitem', { name: 'Close Tab' }));
            expect(handlers.onCloseMany).toHaveBeenCalledWith(['r1']);
        });

        it('closes the tabs to the right, to the left, and the others in strip order', async () => {
            const { tabs, handlers } = setup();
            let menu = await openMenuOn(tabs[1]!);
            fireEvent.click(menu.getByRole('menuitem', { name: 'Close Tabs to the Right' }));
            expect(handlers.onCloseMany).toHaveBeenLastCalledWith(['r2']);

            menu = await openMenuOn(tabs[2]!);
            fireEvent.click(menu.getByRole('menuitem', { name: 'Close Tabs to the Left' }));
            expect(handlers.onCloseMany).toHaveBeenLastCalledWith(['r0', 'r1']);

            menu = await openMenuOn(tabs[1]!);
            fireEvent.click(menu.getByRole('menuitem', { name: 'Close Other Tabs' }));
            expect(handlers.onCloseMany).toHaveBeenLastCalledWith(['r0', 'r2']);

            menu = await openMenuOn(tabs[1]!);
            fireEvent.click(menu.getByRole('menuitem', { name: 'Close All Tabs' }));
            expect(handlers.onCloseMany).toHaveBeenLastCalledWith(['r0', 'r1', 'r2']);
        });

        it('disables the directions that have no tabs, and Close Other Tabs for a lone tab', async () => {
            const { tabs } = setup();
            let menu = await openMenuOn(tabs[0]!);
            expect(menu.getByRole('menuitem', { name: 'Close Tabs to the Left' })).toHaveAttribute(
                'data-disabled',
            );
            expect(
                menu.getByRole('menuitem', { name: 'Close Tabs to the Right' }),
            ).not.toHaveAttribute('data-disabled');

            menu = await openMenuOn(tabs[2]!);
            expect(menu.getByRole('menuitem', { name: 'Close Tabs to the Right' })).toHaveAttribute(
                'data-disabled',
            );
            expect(menu.getByRole('menuitem', { name: 'Close Other Tabs' })).not.toHaveAttribute(
                'data-disabled',
            );
        });

        it('opens from the keyboard on the focused tab', async () => {
            const { tabs, handlers } = setup();
            tabs[2]!.focus();
            fireEvent.keyDown(tabs[2]!, { key: 'F10', shiftKey: true });
            const menu = await openedMenu();
            fireEvent.click(menu.getByRole('menuitem', { name: 'Close Tabs to the Left' }));
            expect(handlers.onCloseMany).toHaveBeenCalledWith(['r0', 'r1']);
        });
    });
});

const openedMenu = async () => within(await screen.findByLabelText('Tab actions'));

describe('connection tabs', () => {
    it('show their status as an icon and a label, apart from the close button', () => {
        render(
            <>
                <RequestTabs
                    requests={[
                        { id: 's', kind: 'ssh', name: 'Lab', status: 'connected' },
                        {
                            id: 'w',
                            kind: 'websocket',
                            name: 'Feed',
                            url: 'wss://x',
                            status: 'connecting',
                        },
                        {
                            id: 'e',
                            kind: 'websocket',
                            name: 'Broken',
                            url: 'wss://y',
                            status: 'error',
                        },
                    ]}
                    activeId="s"
                    unsavedIds={new Set()}
                    onActivate={vi.fn()}
                    onClose={vi.fn()}
                    onNew={vi.fn()}
                    onMove={vi.fn()}
                />
            </>,
        );
        const [ssh, socket, broken] = screen.getAllByRole('tab');
        expect(ssh).toHaveTextContent('LabConnected');
        expect(socket).toHaveTextContent('FeedConnecting…');
        expect(broken).toHaveTextContent('BrokenError');
        // The close control is its own button, outside the tab's label.
        const close = screen.getByRole('button', { name: 'Close Lab' });
        expect(ssh!.contains(close)).toBe(false);
    });
});
