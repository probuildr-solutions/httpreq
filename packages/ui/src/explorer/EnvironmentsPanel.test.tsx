/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createWorkspace } from '@httpreq/workspace';
import { settleConfirm, useConfirmStore } from '../confirm';
import { useWorkbenchStore } from '../store';
import { EnvironmentEditor } from '../environment/EnvironmentEditor';
import { EnvironmentsPanel } from './EnvironmentsPanel';

const state = () => useWorkbenchStore.getState();

/** The sidebar list, and the editor of whichever environment tab is active (as the shell does). */
function Harness() {
    const activeTab = useWorkbenchStore((current) => current.activeEnvironmentTabId);
    return (
        <>
            <EnvironmentsPanel />
            {activeTab && <EnvironmentEditor key={activeTab} environmentId={activeTab} />}
        </>
    );
}

describe('editing environments', () => {
    beforeEach(() => {
        act(() => state().load(createWorkspace('Alpha'), {}, []));
        render(
            <>
                <Harness />
            </>,
        );
    });

    it('opens a new environment in its own tab, with no dialog, starting at its name', () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'New environment' })[0]!);

        const [environment] = state().workspace.environments;
        expect(state().openEnvironmentTabIds).toEqual([environment!.id]);
        expect(state().activeEnvironmentTabId).toBe(environment!.id);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        const name = screen.getByLabelText('Environment name');
        expect(name).toHaveFocus();
        fireEvent.change(name, { target: { value: 'Staging' } });
        fireEvent.change(screen.getByPlaceholderText('Add variable'), {
            target: { value: 'base_url' },
        });

        const saved = state().workspace.environments[0]!;
        expect(saved.name).toBe('Staging');
        expect(saved.variables.map((variable) => variable.key)).toEqual(['base_url']);
    });

    it('keeps one tab per environment, so several can be open at once', () => {
        act(() => {
            state().updateEnvironment(state().createEnvironment(), { name: 'Development' });
            state().updateEnvironment(state().createEnvironment(), { name: 'Production' });
        });
        const [development, production] = state().workspace.environments;

        fireEvent.click(screen.getByRole('button', { name: /^Development\s*\d/ }));
        fireEvent.click(screen.getByRole('button', { name: /^Production\s*\d/ }));
        fireEvent.click(screen.getByRole('button', { name: /^Development\s*\d/ }));

        expect(state().openEnvironmentTabIds).toEqual([development!.id, production!.id]);
        expect(state().activeEnvironmentTabId).toBe(development!.id);
        expect(screen.getByLabelText('Environment name')).toHaveValue('Development');
    });

    it('selects several environments and deletes them together after confirming', async () => {
        act(() => {
            for (const name of ['Development', 'Staging', 'Production']) {
                state().updateEnvironment(state().createEnvironment(), { name });
            }
        });
        const [, staging, production] = state().workspace.environments;
        act(() => state().setActiveEnvironment(staging!.id));

        fireEvent.click(screen.getByRole('button', { name: 'Select environments' }));
        expect(screen.getByText('0 selected')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Delete selected/ })).toBeDisabled();

        fireEvent.click(screen.getByLabelText('Select all'));
        expect(screen.getByText('3 selected')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Production' }));
        expect(screen.getByText('2 selected')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Delete selected/ }));
        expect(useConfirmStore.getState().request?.title).toBe('Delete 2 environments');
        // Nothing is deleted until the user confirms.
        expect(state().workspace.environments).toHaveLength(3);
        await act(async () => settleConfirm('confirm'));

        expect(state().workspace.environments.map((environment) => environment.id)).toEqual([
            production!.id,
        ]);
        expect(state().workspace.activeEnvironmentId).toBeNull();
        // Selection mode ends once the deletion is done.
        expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    });
});
