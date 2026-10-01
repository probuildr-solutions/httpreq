/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/// <reference types="@testing-library/jest-dom/vitest" />
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createVariableResolver } from '@httpreq/api-client';
import {
    createCollection,
    createFolder,
    createKeyValue,
    type AuthConfig,
    type KeyValueItem,
} from '@httpreq/shared';
import type { ContainerNode } from '@httpreq/workspace';
import { AuthorizationPanel } from '../auth/AuthorizationPanel';
import { VariableContext } from '../variableContext';
import { Breadcrumb } from './Breadcrumb';
import { KeyValueTable } from './KeyValueTable';
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
        {
            id: 'v',
            key: 'base_url',
            value: 'https://api.example.com',
            enabled: true,
            secret: false,
        },
    ],
});

const wrap = (children: ReactNode) =>
    render(
        <>
            <VariableContext.Provider value={{ resolver, environmentName: 'Development' }}>
                {children}
            </VariableContext.Provider>
        </>,
    );

describe('KeyValueTable', () => {
    it('turns the trailing empty row into a real row when typed into', () => {
        const onChange = vi.fn();
        wrap(<KeyValueTable label="Headers" items={[]} onChange={onChange} />);
        fireEvent.change(screen.getAllByLabelText('Key')[0]!, { target: { value: 'Accept' } });
        expect(onChange).toHaveBeenCalledWith([
            expect.objectContaining({ key: 'Accept', value: '', enabled: true }),
        ]);
    });

    it('counts only enabled rows with a key', () => {
        const items: KeyValueItem[] = [
            createKeyValue({ key: 'a', value: '1' }),
            createKeyValue({ key: 'b', value: '2', enabled: false }),
            createKeyValue({ key: '', value: 'orphan' }),
        ];
        wrap(<KeyValueTable label="Params" items={items} onChange={vi.fn()} />);
        expect(screen.getByText('1 enabled')).toBeInTheDocument();
    });

    it('duplicates and removes rows', () => {
        const onChange = vi.fn();
        const items = [createKeyValue({ key: 'a', value: '1' })];
        wrap(<KeyValueTable label="Params" items={items} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate row' }));
        expect(onChange.mock.calls[0]![0]).toHaveLength(2);
        expect(onChange.mock.calls[0]![0][1]).toMatchObject({ key: 'a', value: '1' });
        fireEvent.click(screen.getByRole('button', { name: 'Remove row' }));
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    it('masks secret values until revealed', () => {
        const items = [createKeyValue({ key: 'X-Key', value: 'literal', secret: true })];
        wrap(<KeyValueTable label="Headers" items={items} onChange={vi.fn()} allowSecret />);
        const value = screen.getAllByLabelText('Value')[0] as HTMLInputElement;
        expect(value.type).toBe('password');
        fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
        expect(value.type).toBe('text');
    });
});

describe('VariableInput', () => {
    it('highlights defined and undefined variables without changing the value', () => {
        const { container } = wrap(
            <VariableInput aria-label="URL" value="{{base_url}}/users/{{id}}" onChange={vi.fn()} />,
        );
        const spans = container.querySelectorAll('[data-variable]');
        expect(
            [...spans].map((span) => [span.textContent, span.getAttribute('data-defined')]),
        ).toEqual([
            ['{{base_url}}', 'true'],
            ['{{id}}', 'false'],
        ]);
        expect(screen.getByLabelText('URL')).toHaveValue('{{base_url}}/users/{{id}}');
    });
});

describe('Breadcrumb', () => {
    const collection = createCollection('HIMS One Account Service API');
    const v1 = createFolder(collection.id, 'v1');
    const auth = createFolder(v1.id, 'auth');
    const admin = createFolder(auth.id, 'admin');
    const path: ContainerNode[] = [
        { kind: 'collection', node: collection },
        { kind: 'folder', node: v1 },
        { kind: 'folder', node: auth },
        { kind: 'folder', node: admin },
    ];

    it('collapses the middle of deep paths and selects nodes', () => {
        const onSelect = vi.fn();
        wrap(<Breadcrumb path={path} name="adminLogin" onSelect={onSelect} onRename={vi.fn()} />);
        const nav = screen.getByRole('navigation', { name: 'Request location' });
        expect(within(nav).queryByText('v1')).not.toBeInTheDocument();
        expect(within(nav).getByRole('button', { name: '2 more folders' })).toBeInTheDocument();
        fireEvent.click(within(nav).getByText('admin'));
        expect(onSelect).toHaveBeenCalledWith(admin.id);
    });

    it('renames the request in place', () => {
        const onRename = vi.fn();
        wrap(<Breadcrumb path={path} name="adminLogin" onSelect={vi.fn()} onRename={onRename} />);
        fireEvent.click(screen.getByRole('button', { name: 'Rename request' }));
        const input = screen.getByLabelText('Request name');
        fireEvent.change(input, { target: { value: 'adminSignIn' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onRename).toHaveBeenCalledWith('adminSignIn');
    });
});

describe('AuthorizationPanel', () => {
    const inherited = {
        auth: { type: 'bearer', token: '{{accessToken}}', prefix: 'Bearer' } as AuthConfig,
        source: { kind: 'collection' as const, id: 'c1', name: 'HIMS One Account Service' },
    };

    it('shows where inherited authorization comes from and can override it', () => {
        const onChange = vi.fn();
        wrap(
            <AuthorizationPanel
                auth={{ type: 'inherit' }}
                onChange={onChange}
                inherited={inherited}
                canInherit
                owner="request"
            />,
        );
        expect(screen.getByText('HIMS One Account Service')).toBeInTheDocument();
        expect(screen.getByText('Type').parentElement).toHaveTextContent('Bearer Token');
        fireEvent.click(screen.getByRole('button', { name: 'Override authorization' }));
        expect(onChange).toHaveBeenCalledWith(inherited.auth);
        expect(onChange.mock.calls[0]![0]).not.toBe(inherited.auth);
    });

    it('shows an empty state for No Auth', () => {
        wrap(
            <AuthorizationPanel
                auth={{ type: 'none' }}
                onChange={vi.fn()}
                inherited={inherited}
                canInherit
                owner="request"
            />,
        );
        expect(screen.getByText('No authorization selected')).toBeInTheDocument();
    });

    it('warns about a manual header that the scheme replaces', () => {
        wrap(
            <AuthorizationPanel
                auth={{ type: 'bearer', token: 't', prefix: 'Bearer' }}
                onChange={vi.fn()}
                inherited={inherited}
                canInherit
                owner="request"
                conflicts={['Authorization']}
            />,
        );
        expect(screen.getByText(/replaced by this authorization/)).toBeInTheDocument();
    });
});
