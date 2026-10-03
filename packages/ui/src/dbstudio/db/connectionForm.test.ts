/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    applyString,
    blankForm,
    extraParametersText,
    settingsOf,
    stringOf,
    withExtraParameters,
} from './connectionForm';

const applied = (form: ReturnType<typeof blankForm>, text: string) => {
    const result = applyString(form, text);
    if (!result.ok) throw new Error(result.error.message);
    return result.form;
};

describe('connection form and string', () => {
    it('fills the form from a string, switching the engine, and writes the string back masked', () => {
        const form = applied(
            blankForm('mysql', 3306),
            'postgresql://app:s%40cret@db.example.com:5433/shop?sslmode=require&options=-c%20search_path%3Dsales',
        );
        expect(form).toMatchObject({
            engine: 'postgresql',
            host: 'db.example.com',
            port: 5433,
            username: 'app',
            password: 's@cret',
            database: 'shop',
            tls: 'require',
            options: { searchPath: 'sales' },
        });
        expect(stringOf(form)).toBe(
            'postgresql://app:****@db.example.com:5433/shop?sslmode=require&options=-c%20search_path%3Dsales',
        );
    });

    it('keeps the form and reports the problem when the string is invalid', () => {
        const form = blankForm('mysql', 3306);
        const result = applyString(form, 'mysql://h:70000/db');
        expect(result.ok).toBe(false);
    });

    it('updates the string when the form changes', () => {
        const form = { ...blankForm('mongodb', 27017), host: 'a', username: 'u', database: 'd' };
        expect(stringOf(form)).toBe('mongodb://u@a:27017/d');
        expect(
            stringOf({
                ...form,
                options: { srv: 'true', retryWrites: 'true' },
                tls: 'verify-full',
            }),
        ).toBe('mongodb+srv://u@a/d?retryWrites=true');
    });

    it('round-trips every Atlas parameter through the form', () => {
        const text =
            'mongodb+srv://u:p@cluster0.ab1cd.mongodb.net/test?authSource=admin&replicaSet=rs0&readPreference=secondary&w=majority&retryWrites=true&retryReads=false&appName=x';
        const form = applied(blankForm('mongodb', 27017), text);
        expect(form.options).toMatchObject({
            srv: 'true',
            authSource: 'admin',
            replicaSet: 'rs0',
            readPreference: 'secondary',
            w: 'majority',
            retryWrites: 'true',
            retryReads: 'false',
            appName: 'x',
        });
        expect(settingsOf(form).options).toMatchObject({ srv: 'true', w: 'majority' });
        expect(stringOf(form).replace(':****', ':p')).toContain('authSource=admin');
    });

    it('drops a parameter that was removed from the string', () => {
        let form = applied(blankForm('mysql', 3306), 'mysql://u@h/d?charset=utf8mb4');
        expect(form.options.charset).toBe('utf8mb4');
        form = applied(form, 'mysql://u@h/d');
        expect(form.options).toEqual({});
    });

    it('reads and writes parameters that have no field of their own', () => {
        let form = applied(blankForm('mysql', 3306), 'mysql://u@h/d?charset=utf8mb4&foo=1');
        expect(extraParametersText(form)).toBe('charset=utf8mb4\nfoo=1');
        form = withExtraParameters(form, 'charset=latin1\n\nbar=2');
        expect(form.options).toEqual({ charset: 'latin1', bar: '2' });
    });

    it('saves only what differs from the defaults', () => {
        const settings = settingsOf({ ...blankForm('mysql', 3306), host: 'h' });
        expect(settings).toEqual({
            engine: 'mysql',
            host: 'h',
            port: 3306,
            tls: { mode: 'prefer' },
        });
    });
});
