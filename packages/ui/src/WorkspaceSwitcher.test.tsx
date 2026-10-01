/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceMeta } from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { useWorkbenchStore } from './store';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * The rename dialog.
 *
 * Editing the name used to take the whole application down: the change handler read the input's
 * value inside a `setState` updater, which React runs on a later render — by which time the
 * synthetic event's `currentTarget` is null. The crash unmounted everything, so the workspace
 * appeared to vanish as the user typed. These tests hold that path, and the empty-name paths
 * around it, in place.
 */

const actionsFor = () => ({
    create: vi.fn(async () => 'new'),
    duplicate: vi.fn(async () => 'copy'),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    switchTo: vi.fn(async () => true),
});

const mount = () => {
    const workspace = createWorkspace('Alpha');
    act(() => {
        useWorkbenchStore.getState().load(workspace, {}, []);
        useWorkbenchStore.getState().setWorkspaces([workspaceMeta(workspace)]);
    });
    const actions = actionsFor();
    render(
        <>
            <WorkspaceSwitcher actions={actions} releaseConnections={async () => undefined} />
        </>,
    );
    return { workspace, actions };
};

const openDialog = async () => {
    fireEvent.click(screen.getByRole('button', { name: /Workspace: Alpha/ }));
    fireEvent.click(await screen.findByText('Rename…'));
    return (await screen.findByLabelText('Name')) as HTMLInputElement;
};

describe('renaming a workspace', () => {
    it('opens on the current name and commits a new one with Enter', async () => {
        const { workspace, actions } = mount();
        const input = await openDialog();
        expect(input.value).toBe('Alpha');

        fireEvent.change(input, { target: { value: 'Staging EU' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() =>
            expect(actions.rename).toHaveBeenCalledWith(workspace.id, 'Staging EU'),
        );
        await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
    });

    it('survives the field being cleared, and refuses to rename to nothing', async () => {
        const { actions } = mount();
        const input = await openDialog();

        fireEvent.change(input, { target: { value: '' } });
        fireEvent.change(input, { target: { value: '   ' } });

        // Still mounted: clearing the name must not take the switcher — or the app — down with it.
        expect(screen.getByLabelText('Name')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();

        fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' });
        expect(actions.rename).not.toHaveBeenCalled();
        // The dialog stays open with the problem named, rather than closing as if it had worked.
        expect(await screen.findByText('Enter a name for the workspace.')).toBeInTheDocument();
    });

    it('puts the current name back when the field is left empty', async () => {
        mount();
        const input = await openDialog();

        fireEvent.change(input, { target: { value: '  ' } });
        fireEvent.blur(input);

        await waitFor(() =>
            expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alpha'),
        );
    });

    it('trims the committed name and skips a rename that changes nothing', async () => {
        const { workspace, actions } = mount();
        const input = await openDialog();

        fireEvent.change(input, { target: { value: '  Beta  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
        await waitFor(() => expect(actions.rename).toHaveBeenCalledWith(workspace.id, 'Beta'));

        const again = await openDialog();
        fireEvent.change(again, { target: { value: 'Alpha' } });
        fireEvent.keyDown(again, { key: 'Enter' });
        await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
        expect(actions.rename).toHaveBeenCalledTimes(1);
    });

    it('leaves the name alone when the dialog is dismissed with Escape', async () => {
        const { actions } = mount();
        const input = await openDialog();

        fireEvent.change(input, { target: { value: 'Discarded' } });
        fireEvent.keyDown(input, { key: 'Escape' });

        await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
        expect(actions.rename).not.toHaveBeenCalled();
        expect(useWorkbenchStore.getState().workspace.name).toBe('Alpha');
    });
});
