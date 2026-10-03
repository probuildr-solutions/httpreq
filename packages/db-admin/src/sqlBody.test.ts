/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    checkSqlBody,
    formatSqlBody,
    functionBodyFromDefinition,
    mysqlDialect,
    postgresDialect,
    routineFromDefinition,
    triggerFromDefinition,
    triggerFunctionName,
} from './index';

describe('formatSqlBody', () => {
    it('indents blocks and trims trailing whitespace', () => {
        const input = [
            'BEGIN',
            'IF NEW.a > 1 THEN',
            'SET NEW.b = 2;   ',
            'ELSE',
            'SET NEW.b = 3;',
            'END IF;',
            'END',
        ].join('\n');
        expect(formatSqlBody(input)).toBe(
            [
                'BEGIN',
                '    IF NEW.a > 1 THEN',
                '        SET NEW.b = 2;',
                '    ELSE',
                '        SET NEW.b = 3;',
                '    END IF;',
                'END',
            ].join('\n'),
        );
    });

    it('collapses blank lines and leaves comments and strings alone', () => {
        const input = "SELECT '  keep   spaces  ';\n\n\n\n/* a\n     b */\nSELECT 2;";
        expect(formatSqlBody(input)).toBe(
            "SELECT '  keep   spaces  ';\n\n/* a\n     b */\nSELECT 2;",
        );
    });

    it('is idempotent', () => {
        const once = formatSqlBody('BEGIN\nWHILE x < 3 DO\nSET x = x + 1;\nEND WHILE;\nEND');
        expect(formatSqlBody(once)).toBe(once);
    });
});

describe('checkSqlBody', () => {
    it('accepts a sound body', () => {
        expect(checkSqlBody("SELECT (1 + 2) -- (not counted\n, 'it''s fine (' ;")).toEqual([]);
    });

    it('finds an unclosed string, comment and parenthesis', () => {
        expect(checkSqlBody("SELECT 'oops;")[0]).toMatch(/string opened on line 1/);
        expect(checkSqlBody('SELECT 1; /* never')[0]).toMatch(/comment opened on line 1/);
        expect(checkSqlBody('SELECT (1 + 2')[0]).toMatch(/never closed/);
        expect(checkSqlBody('SELECT 1)\n')[0]).toMatch(/without a "\("/);
    });
});

describe('reading definitions back', () => {
    it('reads a MySQL trigger, with its order and body', () => {
        const design = triggerFromDefinition(
            mysqlDialect,
            'CREATE TRIGGER `audit` AFTER INSERT ON `users` FOR EACH ROW FOLLOWS `first` BEGIN INSERT INTO log VALUES (NEW.id); END',
            { name: 'audit', database: 'shop' },
            'users',
        );
        expect(design).toMatchObject({
            name: 'audit',
            table: 'users',
            timing: 'AFTER',
            events: ['INSERT'],
            order: { position: 'FOLLOWS', trigger: 'first' },
            body: 'INSERT INTO log VALUES (NEW.id);',
        });
    });

    it('reads a PostgreSQL trigger and the function it runs', () => {
        const definition =
            'CREATE TRIGGER t BEFORE INSERT OR UPDATE OF email ON public.users FOR EACH ROW WHEN (new.email IS NOT NULL) EXECUTE FUNCTION public.t_fn()';
        expect(triggerFunctionName(definition)).toEqual({ schema: 'public', name: 't_fn' });
        const body = functionBodyFromDefinition(
            'CREATE FUNCTION public.t_fn() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN RETURN NEW; END;\n$$',
        );
        const design = triggerFromDefinition(
            postgresDialect,
            definition,
            { name: 't', schema: 'public' },
            'users',
            body ?? '',
        );
        expect(design).toMatchObject({
            table: 'users',
            timing: 'BEFORE',
            events: ['INSERT', 'UPDATE'],
            updateOf: ['email'],
            when: 'new.email IS NOT NULL',
            forEachRow: true,
        });
        expect(design?.body).toContain('RETURN NEW');
    });

    it('declines a trigger it cannot read, so the caller shows the SQL', () => {
        expect(
            triggerFromDefinition(mysqlDialect, 'something else', { name: 'x' }, 't'),
        ).toBeNull();
    });

    it('reads a MySQL procedure and function', () => {
        const procedure = routineFromDefinition(
            mysqlDialect,
            "CREATE PROCEDURE `archive`(IN cutoff date, OUT n int)\nSQL SECURITY INVOKER\nCOMMENT 'Cleanup'\nBEGIN\n    DELETE FROM t WHERE d < cutoff;\nEND",
            { name: 'archive', database: 'shop' },
            'procedure',
        );
        expect(procedure?.parameters).toEqual([
            { name: 'cutoff', mode: 'IN', type: 'date' },
            { name: 'n', mode: 'OUT', type: 'int' },
        ]);
        expect(procedure).toMatchObject({ security: 'INVOKER', comment: 'Cleanup' });
        expect(procedure?.body).toBe('DELETE FROM t WHERE d < cutoff;');

        const fn = routineFromDefinition(
            mysqlDialect,
            'CREATE FUNCTION `double_it`(x int)\nRETURNS int\nDETERMINISTIC\nBEGIN\n    RETURN x * 2;\nEND',
            { name: 'double_it' },
            'function',
        );
        expect(fn).toMatchObject({ returns: 'int', deterministic: true });
        expect(fn?.body).toBe('RETURN x * 2;');
    });

    it('reads a PostgreSQL function', () => {
        const fn = routineFromDefinition(
            postgresDialect,
            'CREATE OR REPLACE FUNCTION public.add(a integer, b integer)\n RETURNS integer\n LANGUAGE sql\n SECURITY DEFINER\nAS $function$\nSELECT a + b\n$function$',
            { name: 'add', schema: 'public' },
            'function',
        );
        expect(fn).toMatchObject({ returns: 'integer', language: 'sql', security: 'DEFINER' });
        expect(fn?.body).toBe('SELECT a + b');
    });
});
