/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/// <reference types="@testing-library/jest-dom/vitest" />
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVariableResolver } from '@httpreq/api-client';
import { createEnvironment } from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { activeEnvironment, useWorkbenchStore } from '../store';
import { VariableContext } from '../variableContext';
import { VariableDetails } from './VariableInput';

const store = () => useWorkbenchStore.getState();

/** Renders the card against the store's live active environment, as the app does. */
const mount = (
    name: string,
    handlers: { onEditStart?: () => void; onEditEnd?: () => void } = {},
) => {
    const environment = activeEnvironment(store().workspace);
    return render(
        <>
            <VariableContext.Provider
                value={{
                    resolver: createVariableResolver(environment),
                    environmentName: environment?.name ?? null,
                }}
            >
                <VariableDetails name={name} editable {...handlers} />
            </VariableContext.Provider>
        </>,
    );
};

const variables = () => activeEnvironment(store().workspace)!.variables;

beforeEach(() => {
    const environment = createEnvironment('Dev');
    environment.variables = [
        { id: 'a', key: 'base_url', value: 'https://old.example', enabled: true, secret: false },
        { id: 'b', key: 'token', value: 's3cret', enabled: true, secret: true },
        { id: 'c', key: 'host', value: 'first', enabled: true, secret: false },
        { id: 'd', key: 'host', value: 'second', enabled: true, secret: false },
    ];
    const workspace = createWorkspace('Test');
    store().load(
        { ...workspace, environments: [environment], activeEnvironmentId: environment.id },
        {},
        [],
    );
});

describe('editing a variable from its card', () => {
    it('shows the current value and replaces it in the active environment', () => {
        const onEditStart = vi.fn();
        const onEditEnd = vi.fn();
        mount('base_url', { onEditStart, onEditEnd });
        expect(screen.getByText('Current value')).toBeInTheDocument();
        expect(screen.getByText('https://old.example')).toBeInTheDocument();

        const field = screen.getByLabelText('Replace with');
        expect(field).toHaveValue('https://old.example');
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

        fireEvent.change(field, { target: { value: 'https://new.example' } });
        expect(onEditStart).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(variables().find((item) => item.key === 'base_url')?.value).toBe(
            'https://new.example',
        );
        expect(onEditEnd).toHaveBeenCalledWith(true);
    });

    it('never pre-fills a secret, and keeps it secret when replaced', () => {
        mount('token');
        const field = screen.getByLabelText('Replace with');
        expect(field).toHaveValue('');
        expect(field).toHaveAttribute('type', 'password');
        fireEvent.change(field, { target: { value: 'rotated' } });
        fireEvent.submit(field.closest('form')!);
        expect(variables().find((item) => item.key === 'token')).toMatchObject({
            value: 'rotated',
            secret: true,
        });
    });

    it('updates the row a reference actually resolves to', () => {
        mount('host');
        expect(screen.getByLabelText('Replace with')).toHaveValue('second');
        fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'third' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(
            variables()
                .filter((item) => item.key === 'host')
                .map((item) => item.value),
        ).toEqual(['first', 'third']);
    });

    it('adds a variable the environment does not define yet', () => {
        mount('api_key');
        fireEvent.change(screen.getByLabelText('Add to “Dev”'), { target: { value: 'k-1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
        expect(variables().find((item) => item.key === 'api_key')?.value).toBe('k-1');
    });

    it('cancels with Escape, leaving the environment unchanged', () => {
        const onEditEnd = vi.fn();
        mount('base_url', { onEditEnd });
        const field = screen.getByLabelText('Replace with');
        fireEvent.change(field, { target: { value: 'nope' } });
        fireEvent.keyDown(field, { key: 'Escape' });
        expect(onEditEnd).toHaveBeenCalledWith(false);
        expect(variables().find((item) => item.key === 'base_url')?.value).toBe(
            'https://old.example',
        );
    });

    it('offers no field for generated variables', () => {
        mount('$guid');
        expect(screen.queryByLabelText('Replace with')).not.toBeInTheDocument();
    });
});
