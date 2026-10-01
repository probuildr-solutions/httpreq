/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/// <reference types="@testing-library/jest-dom/vitest" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createVariableResolver } from '@httpreq/api-client';
import { createKeyValue, type KeyValueItem } from '@httpreq/shared';
import { VariableContext } from '../variableContext';
import {
    HEADER_NAMES,
    headerValueSuggestions,
    queryValueSuggestions,
} from './intelligence/requestHints';
import { KeyValueTable } from './KeyValueTable';
import { PathVariablesTable } from './PathVariablesTable';
import { VariableInput } from './VariableInput';

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

const resolver = createVariableResolver({
    id: 'e',
    name: 'Development',
    variables: [
        { id: '1', key: 'user_id', value: '42', enabled: true, secret: false },
        { id: '2', key: 'token', value: 'abc', enabled: true, secret: true },
    ],
});

const inScope = (children: ReactNode) =>
    render(
        <VariableContext.Provider value={{ resolver, environmentName: 'Development' }}>
            {children}
        </VariableContext.Provider>,
    );

describe('value suggestions in a field', () => {
    function Field({ suggestions }: { suggestions?: readonly string[] }) {
        const [value, setValue] = useState('');
        return (
            <VariableInput
                aria-label="Value"
                value={value}
                onChange={setValue}
                suggestions={suggestions}
            />
        );
    }

    it('offers the hints when the field is focused, and filters them as the user types', async () => {
        inScope(<Field suggestions={['application/json', 'application/xml', 'text/plain']} />);
        const input = screen.getByLabelText('Value');
        fireEvent.focus(input);
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
            'application/json',
            'application/xml',
            'text/plain',
        ]);

        fireEvent.change(input, { target: { value: 'xml' } });
        // The list follows the field on the next frame.
        await waitFor(() =>
            expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
                'application/xml',
            ]),
        );
    });

    it('replaces the whole value with the hint that is chosen', () => {
        inScope(<Field suggestions={['application/json', 'text/plain']} />);
        const input = screen.getByLabelText('Value');
        fireEvent.focus(input);
        fireEvent.mouseDown(screen.getByRole('option', { name: 'text/plain' }));
        expect(input).toHaveValue('text/plain');
        expect(screen.queryByRole('option')).not.toBeInTheDocument();
    });

    it('accepts the highlighted hint with the keyboard', () => {
        inScope(<Field suggestions={['one', 'two']} />);
        const input = screen.getByLabelText('Value');
        fireEvent.focus(input);
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(input).toHaveValue('two');
    });

    it('still offers variables after {{, not the hints', async () => {
        inScope(<Field suggestions={['one', 'two']} />);
        const input = screen.getByLabelText('Value') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '{{us' } });
        input.setSelectionRange(4, 4);
        await waitFor(() =>
            expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
                expect.stringContaining('user_id'),
            ]),
        );
    });

    it('shows nothing for a field without hints', () => {
        inScope(<Field />);
        fireEvent.focus(screen.getByLabelText('Value'));
        expect(screen.queryByRole('option')).not.toBeInTheDocument();
    });
});

describe('key/value tables with request hints', () => {
    it('suggests the usual values of the header that was named', () => {
        const items: KeyValueItem[] = [createKeyValue({ key: 'Content-Type', value: '' })];
        const onChange = vi.fn();
        inScope(
            <KeyValueTable
                label="Headers"
                items={items}
                onChange={onChange}
                keySuggestions={HEADER_NAMES}
                valueSuggestions={headerValueSuggestions}
            />,
        );
        fireEvent.focus(screen.getAllByLabelText('Value')[0]!);
        expect(screen.getByRole('option', { name: 'application/json' })).toBeInTheDocument();
        fireEvent.mouseDown(screen.getByRole('option', { name: 'application/json' }));
        expect(onChange).toHaveBeenCalledWith([
            expect.objectContaining({ value: 'application/json' }),
        ]);
    });

    it('offers query parameter names in the key cell without losing variable support', () => {
        inScope(
            <KeyValueTable
                label="Query parameters"
                items={[]}
                onChange={vi.fn()}
                keyHints={['page', 'limit']}
                valueSuggestions={queryValueSuggestions}
            />,
        );
        fireEvent.focus(screen.getAllByLabelText('Key')[0]!);
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
            'page',
            'limit',
        ]);
    });
});

describe('path variables', () => {
    it('suggests the environment variable named like the path variable', () => {
        const onChange = vi.fn();
        inScope(
            <PathVariablesTable
                items={[createKeyValue({ key: 'userId', value: '' })]}
                onChange={onChange}
            />,
        );
        fireEvent.focus(screen.getByLabelText('Value of userId'));
        fireEvent.mouseDown(screen.getByRole('option', { name: '{{user_id}}' }));
        expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ value: '{{user_id}}' })]);
    });

    it('offers nothing when no variable matches', () => {
        inScope(
            <PathVariablesTable
                items={[createKeyValue({ key: 'orderRef', value: '' })]}
                onChange={vi.fn()}
            />,
        );
        fireEvent.focus(screen.getByLabelText('Value of orderRef'));
        expect(screen.queryByRole('option')).not.toBeInTheDocument();
    });
});
