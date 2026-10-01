/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/// <reference types="@testing-library/jest-dom/vitest" />
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCodegen } from '@httpreq/codegen';
import { createEmptyRequest, createGrpcConfig, type HttpRequest } from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { defaultPreferences, usePreferences } from '../preferences';
import { useWorkbenchStore } from '../store';
import { CodeGenerationButton } from './CodeGenerationButton';
import { CodeGenerationPanel } from './CodeGenerationPanel';
import { pickGenerator } from './useCodeGeneration';

// Monaco needs a real layout engine; the panel's job is what it hands the editor.
vi.mock('../editor/CodeEditor', () => ({
    CodeEditor: ({
        value,
        language,
        ariaLabel,
    }: {
        value: string;
        language: string;
        ariaLabel: string;
    }) => (
        <pre aria-label={ariaLabel} data-language={language}>
            {value}
        </pre>
    ),
}));

const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../clipboard', () => ({ copyText }));
const downloadText = vi.hoisted(() => vi.fn());
vi.mock('../exchange', () => ({ downloadText }));

const postJson = (): HttpRequest => ({
    ...createEmptyRequest(),
    method: 'POST',
    url: 'https://api.example.com/users',
    headers: [{ id: 'h', key: 'Content-Type', value: 'application/json', enabled: true }],
    body: { ...createEmptyRequest().body, mode: 'json', json: '{"name":"Ada"}' },
});

beforeEach(() => {
    useWorkbenchStore.getState().load(createWorkspace('Test'), {}, []);
    usePreferences.setState(defaultPreferences());
    copyText.mockClear();
    downloadText.mockClear();
});

/** The generated code, as the stubbed editor received it. */
const code = () => document.querySelector('pre[data-language]')?.textContent ?? '';

describe('CodeGenerationPanel', () => {
    it('shows code for the chosen language, starting with cURL', async () => {
        render(<CodeGenerationPanel request={postJson()} />);
        await waitFor(() => expect(code()).toContain('curl --request POST'));
        expect(screen.getByLabelText('cURL code')).toHaveAttribute('data-language', 'shell');
        expect(
            screen.getByRole('combobox', { name: 'Code generation language' }),
        ).toHaveTextContent('cURL');
    });

    it('regenerates when another language is chosen, and remembers it', async () => {
        render(<CodeGenerationPanel request={postJson()} />);
        fireEvent.click(screen.getByRole('combobox', { name: 'Code generation language' }));
        fireEvent.click(await screen.findByRole('option', { name: 'Python – requests' }));

        await waitFor(() => expect(code()).toContain('import requests'));
        expect(usePreferences.getState().codeLanguage).toBe('python-requests');
        expect(screen.getByLabelText('Python – requests code')).toHaveAttribute(
            'data-language',
            'python',
        );
    });

    it('lists every HTTP target, including the languages the feature promises', async () => {
        render(<CodeGenerationPanel request={postJson()} />);
        fireEvent.click(screen.getByRole('combobox', { name: 'Code generation language' }));
        const labels = (await screen.findAllByRole('option')).map((option) => option.textContent);
        for (const wanted of [
            'cURL',
            'Java – java.net.http',
            'JavaScript – fetch',
            'TypeScript – fetch',
            'Python – requests',
            'C# – HttpClient',
            'Go – net/http',
        ]) {
            expect(labels).toContain(wanted);
        }
    });

    it('copies the code that is shown', async () => {
        render(<CodeGenerationPanel request={postJson()} />);
        await waitFor(() => expect(code()).toContain('curl'));
        fireEvent.click(screen.getByRole('button', { name: /copy/i }));
        expect(copyText).toHaveBeenCalledWith(code());
    });

    it('saves the code as a file named for its language', async () => {
        usePreferences.setState({ codeLanguage: 'go-nethttp' });
        render(<CodeGenerationPanel request={postJson()} />);
        await waitFor(() => expect(code()).toContain('package main'));
        fireEvent.click(screen.getByRole('button', { name: 'Save code as a file' }));
        expect(downloadText).toHaveBeenCalledWith('request.go', `${code()}\n`, 'text/plain');
    });

    it('keeps credentials out until asked, and says so', async () => {
        const request = {
            ...postJson(),
            auth: { type: 'bearer', token: 'tok-secret-123', prefix: 'Bearer' },
        } as HttpRequest;
        render(<CodeGenerationPanel request={request} />);
        await waitFor(() => expect(code()).toContain('<SECRET>'));
        expect(code()).not.toContain('tok-secret-123');
        expect(screen.getByText(/replaced by <SECRET>/)).toBeInTheDocument();

        const toggle = screen.getByRole('button', { name: 'Include credentials' });
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(toggle);
        await waitFor(() => expect(code()).toContain('Bearer tok-secret-123'));
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText(/Contains your real credentials/)).toBeInTheDocument();
    });

    it('explains why code cannot be generated instead of showing a broken snippet', async () => {
        render(<CodeGenerationPanel request={{ ...postJson(), url: '' }} />);
        expect(await screen.findByRole('status')).toHaveTextContent(/Enter a URL/);
        expect(screen.getByRole('button', { name: /copy/i })).toBeDisabled();
    });

    it('offers the gRPC targets for a gRPC request', async () => {
        const request: HttpRequest = {
            ...postJson(),
            protocol: 'grpc',
            url: 'grpcs://api.example.com:443',
            grpc: { ...createGrpcConfig(), protoFiles: [], service: '', method: '' },
        };
        render(<CodeGenerationPanel request={request} />);
        fireEvent.click(screen.getByRole('combobox', { name: 'Code generation language' }));
        const labels = (await screen.findAllByRole('option')).map((option) => option.textContent);
        expect(labels).toEqual(expect.arrayContaining(['grpcurl', 'Node.js – @grpc/grpc-js']));
        expect(labels).not.toContain('cURL');
    });
});

describe('pickGenerator', () => {
    const grpc = defaultCodegen.forProtocol('grpc');

    it('prefers the exact target, then one in the same language, then the first', () => {
        expect(pickGenerator(grpc, 'grpcurl')?.id).toBe('grpcurl');
        // `fetch` is JavaScript, and so is the gRPC Node.js client.
        expect(pickGenerator(grpc, 'javascript-fetch')?.id).toBe('node-grpc');
        expect(pickGenerator(grpc, 'python-requests')?.id).toBe(grpc[0]?.id);
        expect(pickGenerator([], 'curl')).toBeUndefined();
    });
});

describe('CodeGenerationButton', () => {
    function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
        const [open, setOpen] = useState(initiallyOpen);
        return (
            <>
                <button type="button">outside</button>
                <CodeGenerationButton request={postJson()} open={open} onOpenChange={setOpen} />
            </>
        );
    }

    it('opens a popover from the button and closes it again', async () => {
        render(<Harness />);
        expect(screen.queryByRole('dialog', { name: 'Code generation' })).not.toBeInTheDocument();
        const button = screen.getByRole('button', { name: 'Generate code' });
        expect(button).toHaveAttribute('aria-expanded', 'false');

        fireEvent.click(button);
        expect(await screen.findByRole('dialog', { name: 'Code generation' })).toBeInTheDocument();
        expect(button).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => expect(code()).toContain('curl'));

        fireEvent.click(button);
        expect(screen.queryByRole('dialog', { name: 'Code generation' })).not.toBeInTheDocument();
    });

    it('closes on Escape, returning focus to the button, and on a click outside', async () => {
        render(<Harness initiallyOpen />);
        const dialog = await screen.findByRole('dialog', { name: 'Code generation' });

        fireEvent.keyDown(dialog, { key: 'Escape' });
        await waitFor(() =>
            expect(
                screen.queryByRole('dialog', { name: 'Code generation' }),
            ).not.toBeInTheDocument(),
        );
        expect(screen.getByRole('button', { name: 'Generate code' })).toHaveFocus();

        fireEvent.click(screen.getByRole('button', { name: 'Generate code' }));
        await screen.findByRole('dialog', { name: 'Code generation' });
        fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
        await waitFor(() =>
            expect(
                screen.queryByRole('dialog', { name: 'Code generation' }),
            ).not.toBeInTheDocument(),
        );
    });

    it('stays open while a language is chosen from its list', async () => {
        render(<Harness initiallyOpen />);
        fireEvent.click(await screen.findByRole('combobox', { name: 'Code generation language' }));
        const option = await screen.findByRole('option', { name: 'Go – net/http' });
        fireEvent.pointerDown(option);
        fireEvent.click(option);
        expect(screen.getByRole('dialog', { name: 'Code generation' })).toBeInTheDocument();
        await waitFor(() => expect(code()).toContain('package main'));
    });
});
