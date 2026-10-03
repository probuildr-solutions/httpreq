/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfiles, type ConnectionProfile } from '../../db/profiles';
import { resetQueries } from '../../db/queryStore';
import { DbManagerContext, type DbManagerApi } from '../../db/useDbManager';
import { resetStudio } from '../../studioStore';
import { resetTabMeta } from '../../tabs/tabMetaStore';
import { DbStudioContext, type DbStudioApi } from '../../useDbStudio';
import { AdminTabView } from '../AdminTabView';
import { closeAdminDialog, useAdminDialog } from '../dialogStore';
import { openAdminTab, resetAdmin, useAdmin, type AdminKind } from '../adminStore';
import {
    newCollectionModel,
    newEventModel,
    newTriggerModel,
    routineModelFrom,
    newRoutineModel,
} from './models';
import { seedEditorState } from './useAdminTabState';

vi.mock('../../../editor/CodeEditor', () => ({
    CodeEditor: ({
        value,
        onChange,
        ariaLabel,
    }: {
        value: string;
        onChange?: (value: string) => void;
        ariaLabel: string;
    }) => (
        <textarea
            aria-label={ariaLabel}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
        />
    ),
}));

const profileId = 'a'.padEnd(16, '0');
const profile = (engine: 'mysql' | 'postgresql' | 'mongodb'): ConnectionProfile => ({
    id: profileId,
    name: 'Local',
    settings: { engine, host: 'h', port: 1, tls: { mode: 'prefer' } },
    group: '',
    favorite: false,
    lastUsed: null,
});

const listMeta = vi.fn(async (_id: string, kind: string) => {
    switch (kind) {
        case 'databases':
            return [{ name: 'shop', system: false }];
        case 'schemas':
            return [{ name: 'public', system: false }];
        case 'tables':
            return [
                { name: 'users', kind: 'table' },
                { name: 'orders', kind: 'table' },
            ];
        case 'triggers':
            return [{ name: 'first_one' }];
        default:
            return [];
    }
});
const refresh = vi.fn();
const manager = {
    available: true,
    db: null,
    ops: null,
    listMeta,
    refresh,
} as unknown as DbManagerApi;
const studio = { available: true } as unknown as DbStudioApi;

const Providers = ({ children }: { children: ReactNode }) => (
    <DbManagerContext.Provider value={manager}>
        <DbStudioContext.Provider value={studio}>{children}</DbStudioContext.Provider>
    </DbManagerContext.Provider>
);

function mount(
    kind: AdminKind,
    engine: 'mysql' | 'postgresql' | 'mongodb',
    state?: Record<string, unknown>,
    extra: { name?: string; schema?: string } = {},
) {
    useProfiles.setState({ profiles: [profile(engine)] });
    const id = openAdminTab(
        {
            kind,
            title: 'Editor',
            profileId,
            database: 'shop',
            schema: extra.schema ?? (engine === 'postgresql' ? 'public' : undefined),
            name: extra.name,
            state,
        },
        { fresh: true },
    );
    render(
        <Providers>
            <AdminTabView id={id} />
        </Providers>,
    );
    return id;
}

const dialog = () => useAdminDialog.getState().dialog;
const pick = async (name: string, option: string) => {
    fireEvent.click(screen.getByRole('combobox', { name }));
    fireEvent.click(await screen.findByRole('option', { name: option }));
};
const radios = (name: string) =>
    within(screen.getByRole('radiogroup', { name }))
        .getAllByRole('radio')
        .map((r) => r.textContent);

beforeEach(() => {
    resetAdmin();
    resetQueries();
    resetStudio();
    resetTabMeta();
    closeAdminDialog();
    vi.clearAllMocks();
});
afterEach(cleanup);

describe('the trigger editor', () => {
    it('is a form with a code editor only for the body', () => {
        mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', newTriggerModel({ database: 'shop' })),
        );
        expect(screen.getByTestId('trigger-editor')).toBeTruthy();
        expect(screen.getByRole('textbox', { name: 'Trigger name' })).toBeTruthy();
        expect(screen.getByRole('combobox', { name: 'Target table' })).toBeTruthy();
        // The body is the only code editor on the form.
        expect(screen.getAllByRole('textbox', { name: 'Trigger body' })).toHaveLength(1);
        for (const label of ['Create trigger', 'Cancel', 'Preview SQL', 'Format', 'Validate'])
            expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    });

    it('offers only what MySQL supports', () => {
        mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', newTriggerModel({ database: 'shop' })),
        );
        expect(radios('Timing')).toEqual(['BEFORE', 'AFTER']);
        expect(radios('Event')).toEqual(['INSERT', 'UPDATE', 'DELETE']);
        expect(screen.queryByRole('radiogroup', { name: 'Runs for each' })).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Condition' })).toBeNull();
        expect(screen.getByRole('combobox', { name: 'Order' })).toBeTruthy();
        expect(screen.getByRole('combobox', { name: 'Database' })).toBeTruthy();
    });

    it('offers INSTEAD OF, several events, TRUNCATE, statement level and a condition on PostgreSQL', () => {
        mount(
            'trigger-editor',
            'postgresql',
            seedEditorState('trigger', newTriggerModel({ schema: 'public' })),
        );
        expect(radios('Timing')).toEqual(['BEFORE', 'AFTER', 'INSTEAD OF']);
        const events = within(screen.getByRole('group', { name: 'Events' }));
        for (const event of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
            expect(events.getByRole('checkbox', { name: event })).toBeTruthy();
        expect(events.getAllByRole('checkbox')).toHaveLength(4);
        expect(radios('Runs for each')).toEqual(['For each row', 'For each statement']);
        expect(screen.getByRole('textbox', { name: 'Condition' })).toBeTruthy();
        expect(screen.queryByRole('combobox', { name: 'Order' })).toBeNull();
        expect(screen.getByRole('combobox', { name: 'Schema' })).toBeTruthy();
    });

    it('creates a MySQL trigger: previews the SQL and hands it to the confirmation dialog', async () => {
        mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', newTriggerModel({ database: 'shop' })),
        );
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger name' }), {
            target: { value: 'audit_users' },
        });
        await pick('Target table', 'users');
        fireEvent.click(screen.getByRole('radio', { name: 'AFTER' }));
        fireEvent.click(screen.getByRole('radio', { name: 'UPDATE' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger body' }), {
            target: { value: 'INSERT INTO log VALUES (NEW.id);' },
        });

        fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
        const sql = screen.getByLabelText('Generated SQL').textContent ?? '';
        expect(sql).toContain('CREATE TRIGGER `shop`.`audit_users`');
        expect(sql).toContain('AFTER UPDATE ON `shop`.`users`');
        expect(sql).toContain('FOR EACH ROW');

        fireEvent.click(screen.getByRole('button', { name: 'Create trigger' }));
        expect(dialog()).toMatchObject({
            kind: 'statements',
            profileId,
            title: 'Create trigger audit_users?',
        });
        expect((dialog() as { statements: string[] }).statements[0]).toContain('CREATE TRIGGER');
    });

    it('creates a PostgreSQL trigger with several events, a column list and a condition', async () => {
        mount(
            'trigger-editor',
            'postgresql',
            seedEditorState('trigger', newTriggerModel({ schema: 'public' })),
        );
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger name' }), {
            target: { value: 'touch' },
        });
        await pick('Target table', 'users');
        fireEvent.click(screen.getByRole('checkbox', { name: 'UPDATE' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Update columns' }), {
            target: { value: 'email, name' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Condition' }), {
            target: { value: 'NEW.email IS NOT NULL' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger body' }), {
            target: { value: 'BEGIN RETURN NEW; END;' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create trigger' }));
        const statements = (dialog() as { statements: string[] }).statements;
        expect(statements).toHaveLength(2);
        expect(statements[0]).toContain('CREATE OR REPLACE FUNCTION "public"."touch_fn"()');
        expect(statements[1]).toContain('INSERT OR UPDATE OF "email", "name" ON "public"."users"');
        expect(statements[1]).toContain('WHEN (NEW.email IS NOT NULL)');
    });

    it('will not save an incomplete trigger and says what is missing', () => {
        mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', newTriggerModel({ database: 'shop' })),
        );
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger name' }), {
            target: { value: 'half' },
        });
        expect(screen.getByRole('alert').textContent).toContain('Choose the table');
        fireEvent.click(screen.getByRole('button', { name: 'Create trigger' }));
        expect(dialog()).toBeNull();
    });

    it('validates on request and formats the body', () => {
        mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', newTriggerModel({ database: 'shop' })),
        );
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger body' }), {
            target: { value: "SET NEW.a = 'oops;" },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
        expect(screen.getByRole('status').textContent).toMatch(
            /Choose the table|never closed|needs a name/,
        );

        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger body' }), {
            target: { value: 'BEGIN\nIF a THEN\nSET b = 1;\nEND IF;\nEND' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Format' }));
        expect(
            (screen.getByRole('textbox', { name: 'Trigger body' }) as HTMLTextAreaElement).value,
        ).toBe('BEGIN\n    IF a THEN\n        SET b = 1;\n    END IF;\nEND');
    });

    it('edits an existing trigger by dropping it before creating it again', () => {
        const design = {
            name: 'audit',
            database: 'shop',
            table: 'users',
            timing: 'AFTER' as const,
            events: ['INSERT' as const],
            body: 'INSERT INTO log VALUES (NEW.id);',
        };
        mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', { mode: 'edit', original: design, design }),
            { name: 'audit' },
        );
        expect(
            (screen.getByRole('textbox', { name: 'Trigger name' }) as HTMLInputElement).value,
        ).toBe('audit');
        fireEvent.click(screen.getByRole('radio', { name: 'UPDATE' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save trigger' }));
        const statements = (dialog() as { statements: string[] }).statements;
        expect(statements[0]).toBe('DROP TRIGGER IF EXISTS `shop`.`audit`;');
        expect(statements[1]).toContain('AFTER UPDATE ON');
    });

    it('marks the tab unsaved once something changes', () => {
        const id = mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', newTriggerModel({ database: 'shop' })),
        );
        expect(useAdmin.getState().tabs[id]!.dirty).toBe(false);
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger name' }), {
            target: { value: 'x' },
        });
        expect(useAdmin.getState().tabs[id]!.dirty).toBe(true);
        fireEvent.change(screen.getByRole('textbox', { name: 'Trigger name' }), {
            target: { value: '' },
        });
        expect(useAdmin.getState().tabs[id]!.dirty).toBe(false);
    });
});

describe('the stored procedure editor', () => {
    const open = (engine: 'mysql' | 'postgresql' = 'mysql') =>
        mount(
            'procedure-editor',
            engine,
            seedEditorState(
                'routine',
                newRoutineModel('procedure', {
                    database: engine === 'mysql' ? 'shop' : undefined,
                    schema: engine === 'postgresql' ? 'public' : undefined,
                }),
            ),
        );
    const grid = () => screen.getByRole('table', { name: 'Parameters' });

    it('has general details, a parameters table, a body and additional options', () => {
        open();
        for (const section of ['General', 'Parameters', 'Procedure body', 'Additional options'])
            expect(screen.getByRole('region', { name: section })).toBeTruthy();
        expect(
            within(grid())
                .getAllByRole('columnheader')
                .map((h) => h.textContent),
        ).toEqual(['Name', 'Mode', 'Data type', 'Length / precision', '']);
    });

    it('edits parameters like the headers table: add, duplicate, reorder, remove', () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Parameter 1 name' }), {
            target: { value: 'a' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Parameter 2 name' }), {
            target: { value: 'b' },
        });
        const names = () =>
            screen
                .getAllByRole('textbox', { name: /Parameter \d name/ })
                .map((i) => (i as HTMLInputElement).value);
        expect(names()).toEqual(['a', 'b']);

        fireEvent.click(screen.getByRole('button', { name: 'Move Parameter b up' }));
        expect(names()).toEqual(['b', 'a']);
        expect(
            screen.getByRole('button', { name: 'Move Parameter b up' }).hasAttribute('disabled'),
        ).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Duplicate Parameter a' }));
        expect(names()).toEqual(['b', 'a', 'a_copy']);

        fireEvent.click(screen.getByRole('button', { name: 'Remove Parameter a_copy' }));
        expect(names()).toEqual(['b', 'a']);
    });

    it('offers IN, OUT and INOUT for a procedure but only IN for a MySQL function', async () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
        fireEvent.click(screen.getByRole('combobox', { name: 'Parameter 1 mode' }));
        expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
            'IN',
            'OUT',
            'INOUT',
        ]);
        cleanup();
        resetAdmin();

        mount(
            'function-editor',
            'mysql',
            seedEditorState('routine', newRoutineModel('function', { database: 'shop' })),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
        fireEvent.click(screen.getByRole('combobox', { name: 'Parameter 1 mode' }));
        expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['IN']);
        expect(screen.getByText('A function takes input parameters only.')).toBeTruthy();
        expect(screen.getByRole('combobox', { name: 'Return type' })).toBeTruthy();
    });

    it('shows defaults, language and owner for PostgreSQL only', () => {
        open('postgresql');
        expect(within(grid()).getByRole('columnheader', { name: 'Default' })).toBeTruthy();
        expect(screen.getByRole('combobox', { name: 'Language' })).toBeTruthy();
        expect(screen.getByRole('textbox', { name: 'Owner' })).toBeTruthy();
        expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull();
        cleanup();
        resetAdmin();
        open('mysql');
        expect(
            within(screen.getByRole('table', { name: 'Parameters' })).queryByRole('columnheader', {
                name: 'Default',
            }),
        ).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
        expect(screen.getByRole('textbox', { name: 'Comment' })).toBeTruthy();
    });

    it('builds the CREATE PROCEDURE statement from the form', async () => {
        open();
        fireEvent.change(screen.getByRole('textbox', { name: 'Procedure name' }), {
            target: { value: 'archive_old' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Parameter 1 name' }), {
            target: { value: 'cutoff' },
        });
        const type = screen.getByRole('combobox', { name: 'Parameter 1 data type' });
        fireEvent.focus(type);
        fireEvent.change(type, { target: { value: 'varchar' } });
        fireEvent.click(await screen.findByRole('option', { name: /^varchar/ }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Parameter 1 length' }), {
            target: { value: '40' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Procedure body' }), {
            target: { value: 'DELETE FROM t WHERE d < cutoff;' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create procedure' }));
        const statements = (dialog() as { statements: string[] }).statements;
        // MySQL cannot replace a procedure, so it drops first; creating one also drops (harmlessly).
        const create = statements.find((s) => s.startsWith('CREATE PROCEDURE'))!;
        expect(create).toContain('`archive_old`(IN `cutoff` varchar(40))');
        expect(create).toContain('DELETE FROM t WHERE d < cutoff;');
    });

    it('opens an existing routine with its parameters, split into type and length', () => {
        const model = routineModelFrom({
            kind: 'procedure',
            name: 'p',
            database: 'shop',
            parameters: [{ name: 'n', mode: 'IN', type: 'decimal(10,2)' }],
            body: 'SELECT n;',
        });
        mount('procedure-editor', 'mysql', seedEditorState('routine', model), { name: 'p' });
        expect(
            (screen.getByRole('combobox', { name: 'Parameter 1 data type' }) as HTMLInputElement)
                .value,
        ).toBe('decimal');
        expect(
            (screen.getByRole('textbox', { name: 'Parameter 1 length' }) as HTMLInputElement).value,
        ).toBe('10,2');
        expect(screen.getByRole('button', { name: 'Save procedure' })).toBeTruthy();
    });
});

describe('the event editor', () => {
    const open = () =>
        mount(
            'event-editor',
            'mysql',
            seedEditorState('event', newEventModel({ database: 'shop' })),
        );

    it('builds a recurring schedule from pickers, not text', () => {
        open();
        fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
            target: { value: 'nightly' },
        });
        expect((screen.getByLabelText('Start') as HTMLInputElement).type).toBe('datetime-local');
        fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-01-01T02:00' } });
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-12-31T00:00' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Interval' }), {
            target: { value: '2' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
            target: { value: 'Purge' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Event body' }), {
            target: { value: 'DELETE FROM sessions WHERE expired = 1' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
        const sql = screen.getByLabelText('Generated SQL').textContent ?? '';
        expect(sql).toContain('CREATE EVENT `shop`.`nightly`');
        expect(sql).toContain(
            "ON SCHEDULE EVERY 2 DAY STARTS '2026-01-01 02:00:00' ENDS '2026-12-31 00:00:00'",
        );
        expect(sql).toContain('ON COMPLETION PRESERVE');
        fireEvent.click(screen.getByRole('button', { name: 'Create event' }));
        expect(dialog()).toMatchObject({ kind: 'statements', title: 'Create event nightly?' });
    });

    it('switches to a one-off event: a single run time and no interval or end', () => {
        open();
        fireEvent.click(screen.getByRole('radio', { name: 'Once' }));
        expect(screen.getByLabelText('Run at')).toBeTruthy();
        expect(screen.queryByLabelText('End')).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Interval' })).toBeNull();
        fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
            target: { value: 'once' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Event body' }), {
            target: { value: 'SELECT 1' },
        });
        expect(screen.getByRole('alert').textContent).toContain('Choose when the event runs');
        fireEvent.change(screen.getByLabelText('Run at'), {
            target: { value: '2026-05-05T10:00' },
        });
        fireEvent.click(screen.getByRole('checkbox', { name: /Keep the event/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
        const sql = screen.getByLabelText('Generated SQL').textContent ?? '';
        expect(sql).toContain("ON SCHEDULE AT '2026-05-05 10:00:00'");
        expect(sql).toContain('ON COMPLETION NOT PRESERVE');
    });

    it('chooses the status', async () => {
        open();
        await pick('Status', 'Disabled');
        fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
            target: { value: 'e' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Event body' }), {
            target: { value: 'SELECT 1' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Preview SQL' }));
        expect(screen.getByLabelText('Generated SQL').textContent).toContain('\nDISABLE');
    });
});

describe('the MongoDB collection designer', () => {
    const open = (
        state = seedEditorState('collection', newCollectionModel({ database: 'shop' })),
    ) => mount('collection-designer', 'mongodb', state);
    const fields = () => screen.getByRole('table', { name: 'Fields' });
    const nameInputs = () =>
        screen
            .getAllByRole('textbox', { name: /Field \d+ name/ })
            .map((i) => (i as HTMLInputElement).value);

    it('is not a table designer: no SQL columns, collection options and a validation schema', () => {
        open();
        expect(screen.getByTestId('collection-designer')).toBeTruthy();
        for (const section of ['General', 'Collection options', 'Validation schema'])
            expect(screen.getByRole('region', { name: section })).toBeTruthy();
        expect(screen.queryByRole('columnheader', { name: 'Length' })).toBeNull();
        expect(
            within(fields())
                .getAllByRole('columnheader')
                .map((h) => h.textContent),
        ).toEqual(['Field', 'BSON type', 'Required', 'Default', 'Description', 'Validation', '']);
    });

    it('lists every BSON type', async () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
        fireEvent.click(screen.getByRole('combobox', { name: 'Field 1 type' }));
        expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
            'double',
            'string',
            'object',
            'array',
            'binData',
            'objectId',
            'bool',
            'date',
            'null',
            'regex',
            'javascript',
            'int',
            'timestamp',
            'long',
            'decimal',
            'minKey',
            'maxKey',
        ]);
    });

    it('nests fields in objects and describes array items', async () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Field 1 name' }), {
            target: { value: 'address' },
        });
        await pick('Field 1 type', 'object');
        fireEvent.click(screen.getByRole('button', { name: 'Add a field inside address' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Field 2 name' }), {
            target: { value: 'city' },
        });
        fireEvent.click(screen.getByRole('checkbox', { name: 'Field 2 required' }));

        fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Field 3 name' }), {
            target: { value: 'tags' },
        });
        await pick('Field 3 type', 'array');
        // The array gets an items row with its own type.
        expect(screen.getByRole('row', { name: 'Items of tags' })).toBeTruthy();
        expect(nameInputs()).toEqual(['address', 'city', 'tags']);

        fireEvent.click(screen.getByText('Generated JSON Schema'));
        const schema = JSON.parse(
            screen.getAllByLabelText('Generated SQL')[0]!.textContent ?? '{}',
        );
        expect(schema.properties.address.properties.city).toEqual({ bsonType: 'string' });
        expect(schema.properties.address.required).toEqual(['city']);
        expect(schema.properties.tags).toEqual({
            bsonType: 'array',
            items: { bsonType: 'string' },
        });
    });

    it('collapses a branch, duplicates, reorders and removes fields', () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Field 1 name' }), {
            target: { value: 'a' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Field 2 name' }), {
            target: { value: 'b' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Move Field b up' }));
        expect(nameInputs()).toEqual(['b', 'a']);
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate Field a' }));
        expect(nameInputs()).toEqual(['b', 'a', 'a_copy']);
        fireEvent.click(screen.getByRole('button', { name: 'Remove Field b' }));
        expect(nameInputs()).toEqual(['a', 'a_copy']);
    });

    it('edits validation rules for a field and shows them in the schema', () => {
        open();
        fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Field 1 name' }), {
            target: { value: 'name' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Field 1 validation' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Max length' }), {
            target: { value: '60' },
        });
        fireEvent.click(screen.getByText('Generated JSON Schema'));
        expect(screen.getByLabelText('Generated SQL').textContent).toContain('"maxLength": 60');
    });

    it('creates a capped collection and rules out a combination MongoDB rejects', async () => {
        open();
        fireEvent.change(screen.getByRole('textbox', { name: 'Collection name' }), {
            target: { value: 'logs' },
        });
        fireEvent.click(screen.getByRole('switch', { name: /Capped collection/ }));
        expect(screen.getByRole('alert').textContent).toContain('maximum size');
        fireEvent.change(screen.getByRole('textbox', { name: 'Size in megabytes' }), {
            target: { value: '5' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Maximum documents' }), {
            target: { value: '1000' },
        });
        // A capped collection cannot be a time series.
        expect(
            (screen.getByRole('switch', { name: /Time series/ }) as HTMLInputElement).disabled,
        ).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));
        const statements = (dialog() as { statements: string[] }).statements;
        expect(statements[0]).toContain('db.getSiblingDB("shop").createCollection("logs"');
        expect(statements[0]).toContain('capped: true');
        expect(statements[0]).toContain(`size: ${5 * 1024 * 1024}`);
        expect(statements[0]).toContain('max: 1000');
    });

    it('creates a time series collection with a collation', () => {
        open();
        fireEvent.change(screen.getByRole('textbox', { name: 'Collection name' }), {
            target: { value: 'readings' },
        });
        fireEvent.click(screen.getByRole('switch', { name: /Time series/ }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Time field' }), {
            target: { value: 'ts' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Collation locale' }), {
            target: { value: 'en' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));
        const statement = (dialog() as { statements: string[] }).statements[0]!;
        expect(statement).toContain('timeseries: { timeField: "ts", granularity: "seconds" }');
        expect(statement).toContain('collation: { locale: "en"');
    });

    it('lets the validator be written by hand', () => {
        open();
        fireEvent.change(screen.getByRole('textbox', { name: 'Collection name' }), {
            target: { value: 'c' },
        });
        fireEvent.click(screen.getByRole('switch', { name: /Write the validator by hand/ }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Validator' }), {
            target: { value: '{ $jsonSchema: { required: ["x"] } }' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));
        expect((dialog() as { statements: string[] }).statements[0]).toContain(
            'validator: { $jsonSchema: { required: ["x"] } }',
        );
    });

    it('changes only the validation of an existing collection', () => {
        mount(
            'collection-designer',
            'mongodb',
            seedEditorState('collection', newCollectionModel({ database: 'shop', name: 'users' })),
            { name: 'users' },
        );
        expect(
            (screen.getByRole('textbox', { name: 'Collection name' }) as HTMLInputElement).disabled,
        ).toBe(true);
        expect(
            (screen.getByRole('switch', { name: /Capped collection/ }) as HTMLInputElement)
                .disabled,
        ).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Field 1 name' }), {
            target: { value: 'email' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Save validation' }));
        const statement = (dialog() as { statements: string[] }).statements[0]!;
        expect(statement).toContain('collMod: "users"');
        expect(statement).toContain('"email"');
    });
});

describe('waiting for lists from the server', () => {
    it('still works when the server returns nothing', async () => {
        listMeta.mockImplementationOnce(async () => {
            throw new Error('offline');
        });
        mount(
            'trigger-editor',
            'mysql',
            seedEditorState('trigger', newTriggerModel({ database: 'shop', table: 'users' })),
        );
        await act(async () => undefined);
        // The table chosen when the editor opened stays selectable and shown.
        await waitFor(() =>
            expect(screen.getByRole('combobox', { name: 'Target table' }).textContent).toContain(
                'users',
            ),
        );
    });
});
