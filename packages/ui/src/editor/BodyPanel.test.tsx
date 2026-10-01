/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/// <reference types="@testing-library/jest-dom/vitest" />
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createVariableResolver } from '@httpreq/api-client';
import { createEmptyRequest, type HttpRequest } from '@httpreq/shared';
import { VariableContext } from '../variableContext';
import { BodyPanel } from './BodyPanel';

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

const multipart = (): HttpRequest => {
    const request = createEmptyRequest();
    return {
        ...request,
        method: 'POST',
        body: {
            ...request.body,
            mode: 'multipart',
            multipart: [
                {
                    id: 'a',
                    key: 'description',
                    value: 'Sample document',
                    enabled: true,
                    kind: 'text',
                    file: null,
                },
                { id: 'b', key: 'attachment', value: '', enabled: true, kind: 'file', file: null },
            ],
        },
    };
};

const renderPanel = (request: HttpRequest, onChange = vi.fn()) =>
    render(
        <>
            <VariableContext.Provider
                value={{ resolver: createVariableResolver(null), environmentName: null }}
            >
                <BodyPanel request={request} onChange={onChange} />
            </VariableContext.Provider>
        </>,
    );

describe('multipart form-data body', () => {
    it('lays the fields out as Key | Type | Value', () => {
        renderPanel(multipart());
        const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
        expect(headers.slice(1, 4)).toEqual(['Key', 'Type', 'Value']);
    });

    it('shows a text input for Text fields and a file button for File fields', () => {
        renderPanel(multipart());
        expect(screen.getAllByLabelText('Value')[0]).toHaveValue('Sample document');
        // The file row has a picker instead of a value input.
        expect(screen.getByRole('button', { name: /select file/i })).toBeInTheDocument();
        expect(screen.getAllByLabelText('Value')).toHaveLength(2); // the text row and the empty ghost row
    });

    it('does not offer bulk edit, which cannot represent files', () => {
        renderPanel(multipart());
        expect(screen.queryByRole('button', { name: /bulk edit/i })).not.toBeInTheDocument();
    });

    it('switching a field to File is written back to the request', () => {
        const onChange = vi.fn();
        renderPanel(multipart(), onChange);
        fireEvent.click(screen.getByRole('combobox', { name: 'Type of description' }));
        fireEvent.click(screen.getByRole('option', { name: 'File' }));
        expect(onChange).toHaveBeenCalledWith({
            body: expect.objectContaining({
                multipart: expect.arrayContaining([
                    expect.objectContaining({ id: 'a', kind: 'file' }),
                ]),
            }),
        });
    });
});

describe('raw body', () => {
    const jsonRequest = (): HttpRequest => {
        const request = createEmptyRequest();
        return {
            ...request,
            method: 'POST',
            body: { ...request.body, mode: 'json', json: '{"a":1}' },
        };
    };

    it('replaces the separate JSON and Text types with Raw and a format dropdown', () => {
        renderPanel(jsonRequest());
        expect(screen.getByText('Raw')).toBeInTheDocument();
        expect(screen.queryByText('JSON', { selector: 'label' })).not.toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Raw body format' })).toHaveTextContent('JSON');
    });

    it('offers JSON, Text, XML, HTML and JavaScript', () => {
        renderPanel(jsonRequest());
        fireEvent.click(screen.getByRole('combobox', { name: 'Raw body format' }));
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
            'JSON',
            'Text',
            'XML',
            'HTML',
            'JavaScript',
        ]);
    });

    it('switching format carries the content and sets the content type', () => {
        const onChange = vi.fn();
        renderPanel(jsonRequest(), onChange);
        fireEvent.click(screen.getByRole('combobox', { name: 'Raw body format' }));
        fireEvent.click(screen.getByRole('option', { name: 'XML' }));
        expect(onChange.mock.calls.at(-1)![0].body).toMatchObject({
            mode: 'text',
            textContentType: 'application/xml',
            text: '{"a":1}',
        });
    });
});
