/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfiles, type ConnectionProfile } from '../db/profiles';
import { DbManagerContext, type DbManagerApi } from '../db/useDbManager';
import { openAdminTab, resetAdmin } from './adminStore';
import { TableDesigner } from './TableDesigner';

const profileId = 'a'.padEnd(16, '0');
const profile = (engine: 'mysql' | 'postgresql'): ConnectionProfile => ({
    id: profileId,
    name: 'Local',
    settings: { engine, host: 'h', port: 1, tls: { mode: 'prefer' } },
    group: '',
    favorite: false,
    lastUsed: null,
});

const manager = {
    available: true,
    ops: null,
    listMeta: vi.fn(async () => []),
    refresh: vi.fn(),
} as unknown as DbManagerApi;

function open(engine: 'mysql' | 'postgresql') {
    useProfiles.setState({ profiles: [profile(engine)] });
    const id = openAdminTab(
        {
            kind: 'design',
            title: 'New table',
            profileId,
            database: 'shop',
            schema: engine === 'postgresql' ? 'public' : undefined,
        },
        { fresh: true },
    );
    render(
        <DbManagerContext.Provider value={manager}>
            <TableDesigner id={id} />
        </DbManagerContext.Provider>,
    );
    return id;
}

const columnsTable = () => screen.getByRole('table', { name: 'Columns' });
const headers = () =>
    within(columnsTable())
        .getAllByRole('columnheader')
        .map((h) => h.textContent);
const typeBox = (n = 1) => screen.getByRole('combobox', { name: `Column ${n} type` });
const options = () => screen.getAllByRole('option').map((o) => o.textContent ?? '');
const openTypes = (n = 1) => {
    fireEvent.focus(typeBox(n));
    fireEvent.change(typeBox(n), { target: { value: '' } });
};
const sqlPreview = () => {
    fireEvent.click(screen.getByRole('tab', { name: 'SQL Preview' }));
    return screen.getByLabelText('Generated SQL').textContent ?? '';
};
const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

beforeEach(() => {
    resetAdmin();
    vi.clearAllMocks();
});
afterEach(cleanup);

describe('the table designer sections', () => {
    it('has a tab for each part of a table', () => {
        open('mysql');
        const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
        expect(tabs).toEqual([
            'Columns (1)',
            'Primary Key',
            'Indexes (0)',
            'Foreign Keys (0)',
            'Unique Constraints (0)',
            'Checks (0)',
            'Table Options',
            'SQL Preview',
        ]);
    });

    it('shows each constraint kind on its own tab', () => {
        open('mysql');
        const show = (tab: string, heading: string) => {
            fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }));
            expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
        };
        show('Primary Key', 'Primary key');
        show('Foreign Keys', 'Foreign keys');
        show('Unique Constraints', 'Unique constraints');
        show('Checks', 'Check constraints');
        fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
            target: { value: 'people' },
        });
        fireEvent.click(screen.getByRole('tab', { name: 'Table Options' }));
        fireEvent.change(field('Table comment'), { target: { value: 'People' } });
        expect(sqlPreview()).toContain('COMMENT');
    });

    it('starts a new table with an auto-numbered primary key', () => {
        open('mysql');
        expect(field('Column 1 name').value).toBe('id');
        expect(
            (screen.getByRole('checkbox', { name: 'Column 1 primary key' }) as HTMLInputElement)
                .checked,
        ).toBe(true);
        expect(
            (screen.getByRole('checkbox', { name: 'Column 1 auto increment' }) as HTMLInputElement)
                .checked,
        ).toBe(true);
    });
});

describe('the MySQL column grid', () => {
    it('has the columns of a table designer', () => {
        open('mysql');
        expect(headers()).toEqual([
            'Column',
            'Data type',
            'Length',
            'Precision',
            'Scale',
            'Unsigned',
            'Null',
            'PK',
            'Unique',
            'Auto inc.',
            'Default',
            'Generated as',
            'Comment',
            '',
        ]);
    });

    it('offers every MySQL type, grouped by category, in a searchable list', () => {
        open('mysql');
        openTypes();
        const all = options();
        for (const type of [
            'tinyint',
            'smallint',
            'mediumint',
            'int',
            'bigint',
            'decimal',
            'numeric',
            'float',
            'double',
            'bit',
            'date',
            'datetime',
            'timestamp',
            'time',
            'year',
            'char',
            'varchar',
            'binary',
            'varbinary',
            'tinytext',
            'text',
            'mediumtext',
            'longtext',
            'tinyblob',
            'blob',
            'mediumblob',
            'longblob',
            'enum',
            'set',
            'json',
            'geometry',
            'point',
        ])
            expect(all.some((o) => o.startsWith(type))).toBe(true);
        const groups = screen.getAllByText(
            /^(Numeric|Boolean|String|Binary|Date and time|Structured|Geometric|Other)$/,
        );
        expect(groups.map((g) => g.textContent)).toEqual(
            expect.arrayContaining([
                'Numeric',
                'String',
                'Binary',
                'Date and time',
                'Structured',
                'Geometric',
                'Other',
            ]),
        );
    });

    it('narrows the list as you type, by name or alias', () => {
        open('mysql');
        fireEvent.focus(typeBox());
        fireEvent.change(typeBox(), { target: { value: 'blob' } });
        expect(options().map((o) => o.replace(/\s.*$/, ''))).toEqual([
            'blob',
            'tinyblob',
            'mediumblob',
            'longblob',
        ]);
        fireEvent.change(typeBox(), { target: { value: 'integer' } });
        expect(options()[0]).toMatch(/^int/);
        fireEvent.change(typeBox(), { target: { value: 'zzz' } });
        expect(screen.queryAllByRole('option')).toHaveLength(0);
    });

    it('is driven by the keyboard', () => {
        open('mysql');
        fireEvent.focus(typeBox());
        fireEvent.change(typeBox(), { target: { value: 'text' } });
        fireEvent.keyDown(typeBox(), { key: 'ArrowDown' });
        fireEvent.keyDown(typeBox(), { key: 'Enter' });
        // text, then tinytext, mediumtext… in order of match: the second is chosen.
        expect(typeBox().getAttribute('aria-expanded')).toBe('false');
        expect((typeBox() as HTMLInputElement).value).toMatch(/text$/);
        expect((typeBox() as HTMLInputElement).value).not.toBe('varchar');
    });

    it('enables length, precision and scale by what the type takes, from catalog data', () => {
        open('mysql');
        const length = () => field('Column 1 length');
        const precision = () => field('Column 1 precision');
        const scale = () => field('Column 1 scale');
        const choose = (type: string) => {
            fireEvent.focus(typeBox());
            fireEvent.change(typeBox(), { target: { value: type } });
            fireEvent.click(
                screen.getAllByRole('option').find((o) => o.textContent?.startsWith(type))!,
            );
        };

        choose('varchar');
        expect([length().disabled, precision().disabled, scale().disabled]).toEqual([
            false,
            true,
            true,
        ]);

        choose('decimal');
        expect([length().disabled, precision().disabled]).toEqual([true, false]);
        expect(scale().disabled).toBe(true); // until a precision is given
        fireEvent.change(precision(), { target: { value: '10' } });
        expect(scale().disabled).toBe(false);
        fireEvent.change(scale(), { target: { value: '2' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
            target: { value: 'prices' },
        });
        expect(sqlPreview()).toContain('decimal(10,2)');

        fireEvent.click(screen.getByRole('tab', { name: /^Columns/ }));
        choose('datetime');
        expect([length().disabled, precision().disabled, scale().disabled]).toEqual([
            true,
            false,
            true,
        ]);

        choose('json');
        expect([length().disabled, precision().disabled, scale().disabled]).toEqual([
            true,
            true,
            true,
        ]);
        expect(
            (screen.getByRole('checkbox', { name: 'Column 1 unsigned' }) as HTMLInputElement)
                .disabled,
        ).toBe(true);
        expect(
            (screen.getByRole('checkbox', { name: 'Column 1 auto increment' }) as HTMLInputElement)
                .disabled,
        ).toBe(true);

        choose('bigint');
        expect(
            (screen.getByRole('checkbox', { name: 'Column 1 unsigned' }) as HTMLInputElement)
                .disabled,
        ).toBe(false);
        expect(
            (screen.getByRole('checkbox', { name: 'Column 1 auto increment' }) as HTMLInputElement)
                .disabled,
        ).toBe(false);
    });

    it('marks a single column unique, which becomes a unique constraint', () => {
        open('mysql');
        fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
        fireEvent.change(field('Column 2 name'), { target: { value: 'email' } });
        fireEvent.change(field('Column 1 name'), { target: { value: 'id' } });
        fireEvent.click(screen.getByRole('checkbox', { name: 'Column 2 unique' }));
        expect(
            (screen.getByRole('checkbox', { name: 'Column 2 unique' }) as HTMLInputElement).checked,
        ).toBe(true);
        fireEvent.change(field('Column 1 name'), { target: { value: 'id' } }); // name needed first
        fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
            target: { value: 'people' },
        });
        expect(sqlPreview()).toContain('UNIQUE (`email`)');
        fireEvent.click(screen.getByRole('tab', { name: /^Columns/ }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Column 2 unique' }));
        expect(sqlPreview()).not.toContain('UNIQUE');
    });

    it('adds, duplicates, reorders and removes columns', () => {
        open('mysql');
        fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
        fireEvent.change(field('Column 2 name'), { target: { value: 'email' } });
        const names = () =>
            screen
                .getAllByRole('textbox', { name: /Column \d+ name/ })
                .map((i) => (i as HTMLInputElement).value);
        expect(names()).toEqual(['id', 'email']);

        fireEvent.click(screen.getByRole('button', { name: 'Duplicate Column email' }));
        expect(names()).toEqual(['id', 'email', 'email_copy']);

        fireEvent.click(screen.getByRole('button', { name: 'Move Column email_copy up' }));
        expect(names()).toEqual(['id', 'email_copy', 'email']);
        expect(
            screen.getByRole('button', { name: 'Move Column id up' }).hasAttribute('disabled'),
        ).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Remove Column email_copy' }));
        expect(names()).toEqual(['id', 'email']);
        // The primary key never names a removed column.
        fireEvent.click(screen.getByRole('button', { name: 'Remove Column id' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
            target: { value: 't' },
        });
        expect(sqlPreview()).not.toContain('PRIMARY KEY (`id`)');
    });

    it('a duplicated column is not a second auto-increment column', () => {
        open('mysql');
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate Column id' }));
        expect(
            (screen.getByRole('checkbox', { name: 'Column 2 auto increment' }) as HTMLInputElement)
                .checked,
        ).toBe(false);
    });

    it('writes the CREATE TABLE statement', () => {
        open('mysql');
        fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
            target: { value: 'people' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
        fireEvent.change(field('Column 2 name'), { target: { value: 'name' } });
        fireEvent.change(field('Column 2 length'), { target: { value: '80' } });
        fireEvent.click(screen.getByRole('checkbox', { name: 'Column 2 nullable' }));
        const sql = sqlPreview();
        expect(sql).toContain('CREATE TABLE `shop`.`people`');
        expect(sql).toContain('`id` int NOT NULL AUTO_INCREMENT');
        expect(sql).toContain('`name` varchar(80) NOT NULL');
        expect(sql).toContain('PRIMARY KEY (`id`)');
    });
});

describe('the PostgreSQL column grid', () => {
    it('shows identity instead of auto increment and no MySQL-only columns', () => {
        open('postgresql');
        const names = headers();
        expect(names).toContain('Identity');
        expect(names).not.toContain('Auto inc.');
        expect(names).not.toContain('Unsigned');
        expect(names).not.toContain('Comment');
        expect(names).toEqual(
            expect.arrayContaining(['Precision', 'Scale', 'Unique', 'Generated as']),
        );
    });

    it('offers the PostgreSQL types: numeric, serial, character, binary, date/time, ranges, geometry', () => {
        open('postgresql');
        openTypes();
        const all = options().map((o) => o.replace(/\s+(\d|auto).*$/, ''));
        for (const type of [
            'smallint',
            'integer',
            'bigint',
            'decimal',
            'numeric',
            'real',
            'double precision',
            'smallserial',
            'serial',
            'bigserial',
            'character',
            'character varying',
            'text',
            'bytea',
            'date',
            'time',
            'time with time zone',
            'timestamp',
            'timestamp with time zone',
            'interval',
            'boolean',
            'uuid',
            'json',
            'jsonb',
            'xml',
            'inet',
            'cidr',
            'macaddr',
            'int4range',
            'int8range',
            'numrange',
            'tsrange',
            'tstzrange',
            'daterange',
            'point',
            'line',
            'box',
            'polygon',
            'circle',
        ])
            expect(all.some((o) => o.startsWith(type))).toBe(true);
    });

    it('finds a type by its short alias', () => {
        open('postgresql');
        fireEvent.focus(typeBox());
        fireEvent.change(typeBox(), { target: { value: 'timestamptz' } });
        expect(options()[0]).toMatch(/^timestamp with time zone/);
        fireEvent.change(typeBox(), { target: { value: 'int4' } });
        expect(options()[0]).toMatch(/^integer/);
    });

    it('keeps a custom type and an array type as typed', () => {
        open('postgresql');
        fireEvent.focus(typeBox());
        fireEvent.change(typeBox(), { target: { value: 'integer[]' } });
        fireEvent.keyDown(typeBox(), { key: 'Enter' });
        expect((typeBox() as HTMLInputElement).value).toBe('integer[]');
        fireEvent.focus(typeBox());
        fireEvent.change(typeBox(), { target: { value: 'order_status' } });
        fireEvent.blur(typeBox());
        expect((typeBox() as HTMLInputElement).value).toBe('order_status');
    });

    it('uses identity columns rather than assuming SERIAL', () => {
        open('postgresql');
        fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
            target: { value: 'people' },
        });
        const identity = () =>
            screen.getByRole('checkbox', { name: 'Column 1 auto increment' }) as HTMLInputElement;
        expect(identity().checked).toBe(true);
        expect(sqlPreview()).toContain('"id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL');
        expect(sqlPreview()).not.toMatch(/serial/i);

        // A serial type numbers itself, so the identity box is ticked and cannot be changed.
        fireEvent.click(screen.getByRole('tab', { name: /^Columns/ }));
        fireEvent.focus(typeBox());
        fireEvent.change(typeBox(), { target: { value: 'bigserial' } });
        fireEvent.click(screen.getAllByRole('option')[0]!);
        expect(identity().checked).toBe(true);
        expect(identity().disabled).toBe(true);

        // A text column cannot be an identity column.
        fireEvent.focus(typeBox());
        fireEvent.change(typeBox(), { target: { value: 'text' } });
        fireEvent.click(screen.getAllByRole('option')[0]!);
        expect(identity().disabled).toBe(true);
    });

    it('takes precision and scale for numeric and fractional digits for timestamps', () => {
        open('postgresql');
        const choose = (type: string) => {
            fireEvent.focus(typeBox());
            fireEvent.change(typeBox(), { target: { value: type } });
            fireEvent.click(screen.getAllByRole('option')[0]!);
        };
        choose('numeric');
        expect(field('Column 1 precision').disabled).toBe(false);
        fireEvent.change(field('Column 1 precision'), { target: { value: '12' } });
        fireEvent.change(field('Column 1 scale'), { target: { value: '4' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
            target: { value: 'm' },
        });
        expect(sqlPreview()).toContain('numeric(12,4)');
        fireEvent.click(screen.getByRole('tab', { name: /^Columns/ }));
        choose('timestamp with time zone');
        fireEvent.change(field('Column 1 precision'), { target: { value: '3' } });
        expect(sqlPreview()).toContain('timestamp(3) with time zone');
    });
});
