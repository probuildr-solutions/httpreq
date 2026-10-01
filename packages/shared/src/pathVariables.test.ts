/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { createKeyValue } from './model';
import { applyPathVariables, pathVariableNames, syncPathVariables } from './pathVariables';

describe('path variables', () => {
    it('finds :name segments but not ports or query values', () => {
        expect(pathVariableNames('http://localhost:3000/users/:userId/posts/:id?x=:no')).toEqual([
            'userId',
            'id',
        ]);
        expect(pathVariableNames('{{base_url}}/a/{{b}}')).toEqual([]);
    });

    it('keeps typed values when the URL changes', () => {
        const rows = [createKeyValue({ key: 'id', value: '5' })];
        const next = syncPathVariables('/a/:id/b/:other', rows);
        expect(next.map((row) => `${row.key}=${row.value}`)).toEqual(['id=5', 'other=']);
        expect(next[0]).toBe(rows[0]);
    });

    it('substitutes values, encoding them but keeping {{variables}}', () => {
        const rows = [
            createKeyValue({ key: 'id', value: 'a b/c' }),
            createKeyValue({ key: 'org', value: '{{org}}' }),
        ];
        expect(applyPathVariables('/o/:org/u/:id/x/:none?q=:id', rows)).toBe(
            '/o/{{org}}/u/a%20b%2Fc/x/:none?q=:id',
        );
    });
});
