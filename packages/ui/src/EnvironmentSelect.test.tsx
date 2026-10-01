/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createWorkspace } from '@httpreq/workspace';
import { useWorkbenchStore } from './store';
import { EnvironmentSelect } from './EnvironmentSelect';

const state = () => useWorkbenchStore.getState();

describe('the active-environment picker', () => {
    let staging = '';

    beforeEach(() => {
        act(() => {
            state().load(createWorkspace('Alpha'), {}, []);
            staging = state().createEnvironment();
            state().updateEnvironment(staging, { name: 'Staging' });
            state().setActiveEnvironment(null);
            state().setSidebarView('collections');
        });
        render(
            <>
                <EnvironmentSelect />
            </>,
        );
    });

    it('names the active environment and switches it from its menu', async () => {
        const trigger = screen.getByRole('button', { name: /^Environment: No environment/ });
        fireEvent.click(trigger);
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Staging' }));

        expect(state().workspace.activeEnvironmentId).toBe(staging);
        expect(screen.getByRole('button', { name: /^Environment: Staging/ })).toBeInTheDocument();
    });

    it('opens the environments view to manage them', async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Environment:/ }));
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Manage environments' }));
        expect(state().sidebarView).toBe('environments');
    });
});
