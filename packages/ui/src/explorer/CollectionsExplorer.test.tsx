/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createWorkspace } from '@httpreq/workspace';
import { settleConfirm, useConfirmStore } from '../confirm';
import { useWorkbenchStore } from '../store';
import { CollectionsExplorer } from './CollectionsExplorer';

const state = () => useWorkbenchStore.getState();

const mount = () => {
    act(() => state().load(createWorkspace('Alpha'), {}, []));
    let collection = '';
    let folder = '';
    let nested = '';
    act(() => {
        collection = state().createCollection();
        folder = state().createFolder(collection);
        nested = state().createFolder(folder);
        state().renameNode(collection, 'Api');
        state().renameNode(folder, 'Users');
        state().renameNode(nested, 'Admins');
        state().setRenaming(null);
    });
    render(
        <>
            <CollectionsExplorer onOpenSettings={() => undefined} />
        </>,
    );
    return { collection, folder, nested };
};

const folderName = (id: string) => state().workspace.folders.find((item) => item.id === id)?.name;

describe('renaming in the collections explorer', () => {
    beforeEach(() => {
        act(() => state().setRenaming(null));
    });

    it.each(['folder', 'nested'] as const)('renames a %s from its actions menu', async (which) => {
        const ids = mount();
        const id = ids[which];
        const name = folderName(id)!;
        // A real click focuses the button; the menu hands focus back to it when it closes.
        const trigger = screen.getByRole('button', { name: `Actions for ${name}` });
        trigger.focus();
        fireEvent.click(trigger);
        fireEvent.click(await screen.findByText('Rename'));
        const input = (await screen.findByLabelText(`Rename ${name}`)) as HTMLInputElement;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(input).toBeInTheDocument();
        expect(input).toHaveFocus();
        fireEvent.change(input, { target: { value: 'Renamed' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(folderName(id)).toBe('Renamed'));
    });
});

describe('selecting in the collections explorer', () => {
    it('checks everything inside a folder with it, and clears the folder when a child is cleared', () => {
        const { collection, folder } = mount();
        act(() => state().toggleExpanded(collection, true));
        act(() => state().toggleExpanded(folder, true));
        fireEvent.click(screen.getByRole('button', { name: 'Select collections and requests' }));

        fireEvent.click(screen.getByRole('checkbox', { name: 'Users' }));
        expect(screen.getByRole('checkbox', { name: 'Admins' })).toBeChecked();

        fireEvent.click(screen.getByRole('checkbox', { name: 'Admins' }));
        expect(screen.getByRole('checkbox', { name: 'Users' })).not.toBeChecked();
    });

    it('deletes a checked folder once, together with its sub-folder', async () => {
        const { collection, folder, nested } = mount();
        act(() => state().toggleExpanded(collection, true));
        act(() => state().toggleExpanded(folder, true));

        fireEvent.click(screen.getByRole('button', { name: 'Select collections and requests' }));
        expect(screen.getByText('0 selected')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Users' }));
        expect(screen.getByText('2 selected')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }));
        // The sub-folder goes with its parent, so the confirmation counts one item.
        expect(useConfirmStore.getState().request?.title).toBe('Delete 1 item');
        await act(async () => settleConfirm('confirm'));

        expect(state().workspace.folders.map((item) => item.id)).not.toContain(folder);
        expect(state().workspace.folders.map((item) => item.id)).not.toContain(nested);
        expect(state().workspace.collections.map((item) => item.id)).toEqual([collection]);
    });
});
