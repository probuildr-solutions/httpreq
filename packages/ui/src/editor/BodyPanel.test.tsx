/// <reference types="@testing-library/jest-dom/vitest" />
import { MantineProvider } from '@mantine/core';
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
    <MantineProvider>
      <VariableContext.Provider
        value={{ resolver: createVariableResolver(null), environmentName: null }}
      >
        <BodyPanel request={request} onChange={onChange} />
      </VariableContext.Provider>
    </MantineProvider>,
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
    fireEvent.click(screen.getByRole('textbox', { name: 'Type of description' }));
    fireEvent.click(screen.getByRole('option', { name: 'File' }));
    expect(onChange).toHaveBeenCalledWith({
      body: expect.objectContaining({
        multipart: expect.arrayContaining([expect.objectContaining({ id: 'a', kind: 'file' })]),
      }),
    });
  });
});
