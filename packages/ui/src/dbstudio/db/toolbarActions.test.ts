/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { duplicateActionIds, toolbarActions, type ToolbarState } from './toolbarActions';

const base: ToolbarState = {
    hasConnection: true,
    running: false,
    canExplain: true,
    canTransact: true,
    inTransaction: false,
    saved: false,
    canExport: true,
    statementNoun: 'statement',
};
const ids = (state: Partial<ToolbarState> = {}) =>
    toolbarActions({ ...base, ...state }).map((a) => a.id);

describe('the query toolbar actions', () => {
    it('lists each action once, so Export cannot be drawn twice', () => {
        for (const state of [
            base,
            { running: true },
            { inTransaction: true },
            { canExplain: false, canTransact: false },
            { hasConnection: false },
        ] as Partial<ToolbarState>[]) {
            const actions = toolbarActions({ ...base, ...state });
            expect(duplicateActionIds(actions)).toEqual([]);
            expect(actions.filter((a) => a.id === 'export')).toHaveLength(1);
        }
        // The check itself catches a repeated action.
        expect(duplicateActionIds([...toolbarActions(base), ...toolbarActions(base)])).toContain(
            'export',
        );
    });

    it('keeps Run, Run all and Stop always present and only switches them', () => {
        expect(ids()).toEqual(expect.arrayContaining(['run', 'runAll', 'stop']));
        const idle = toolbarActions(base);
        const running = toolbarActions({ ...base, running: true });
        expect(idle.map((a) => a.id)).toEqual(running.map((a) => a.id));
        const disabled = (list: typeof idle, id: string) => list.find((a) => a.id === id)!.disabled;
        expect([disabled(idle, 'run'), disabled(idle, 'stop')]).toEqual([false, true]);
        expect([
            disabled(running, 'run'),
            disabled(running, 'runAll'),
            disabled(running, 'stop'),
        ]).toEqual([true, true, false]);
    });

    it('offers Explain and transactions only where the engine has them', () => {
        expect(ids({ canExplain: false })).not.toContain('explain');
        expect(ids({ canTransact: false })).not.toContain('begin');
        expect(ids()).toContain('begin');
        expect(ids({ inTransaction: true })).toEqual(
            expect.arrayContaining(['commit', 'rollback']),
        );
        expect(ids({ inTransaction: true })).not.toContain('begin');
    });

    it('disables what cannot be used without a connection or an exportable engine', () => {
        const without = toolbarActions({ ...base, hasConnection: false });
        expect(without.find((a) => a.id === 'run')!.disabled).toBe(true);
        expect(without.find((a) => a.id === 'export')!.disabled).toBe(true);
        expect(
            toolbarActions({ ...base, canExport: false }).find((a) => a.id === 'export')!.disabled,
        ).toBe(true);
        expect(
            toolbarActions({ ...base, saved: true }).find((a) => a.id === 'save')!.disabled,
        ).toBe(true);
    });

    it('gives every action a tooltip and groups them', () => {
        for (const action of toolbarActions(base)) expect(action.tooltip.length).toBeGreaterThan(5);
        expect(toolbarActions(base).map((a) => a.group)).toEqual([
            'run',
            'run',
            'run',
            'run',
            'file',
            'file',
            'transaction',
        ]);
    });
});
