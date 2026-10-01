/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import type { Environment } from '@httpreq/shared';
import { createVariableResolver, isTemplateOnly, parseTemplate } from './variables';

const environment: Environment = {
    id: 'e',
    name: 'Dev',
    variables: [
        { id: '1', key: 'a', value: '{{b}}', enabled: true, secret: false },
        { id: '2', key: 'b', value: 'B', enabled: true, secret: false },
        { id: '3', key: 'loop', value: '{{loop}}', enabled: true, secret: false },
        { id: '4', key: 'token', value: 'secret', enabled: true, secret: true },
    ],
};

describe('variables', () => {
    it('splits templates into literal and variable segments', () => {
        expect(parseTemplate('{{base_url}}/v1?x={{ id }}')).toEqual([
            { text: '{{base_url}}', variable: 'base_url', start: 0, end: 12 },
            { text: '/v1?x=', start: 12, end: 18 },
            { text: '{{ id }}', variable: 'id', start: 18, end: 26 },
        ]);
    });

    it('resolves nested references and leaves unknown ones as written', () => {
        const resolver = createVariableResolver(environment);
        expect(resolver.resolve('{{a}}-{{missing}}')).toBe('B-{{missing}}');
        expect([...resolver.unresolved]).toEqual(['missing']);
    });

    it('terminates on self-referencing variables', () => {
        expect(createVariableResolver(environment).resolve('{{loop}}')).toBe('{{loop}}');
    });

    it('describes variables with their source without exposing dynamic values', () => {
        const resolver = createVariableResolver(environment);
        expect(resolver.lookup('token')).toMatchObject({
            value: 'secret',
            secret: true,
            source: 'Dev',
        });
        expect(resolver.lookup('$guid')).toMatchObject({ dynamic: true, source: 'Dynamic' });
        expect(resolver.resolve('{{$guid}}')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('can keep secrets as references', () => {
        expect(
            createVariableResolver(environment, { keepSecrets: true }).resolve('{{token}}'),
        ).toBe('{{token}}');
    });

    it('detects template-only values', () => {
        expect(isTemplateOnly('{{token}}')).toBe(true);
        expect(isTemplateOnly(' {{a}}{{b}} ')).toBe(true);
        expect(isTemplateOnly('Bearer {{token}}')).toBe(false);
        expect(isTemplateOnly('literal')).toBe(false);
    });
});
