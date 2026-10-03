/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The actions of the query toolbar, as data. The toolbar component renders this list and nothing
 * else, so an action exists once: it cannot be drawn twice by a copied block of markup, and the list
 * can be checked for duplicates without rendering anything.
 */
export type ToolbarActionId =
    'run' | 'runAll' | 'stop' | 'explain' | 'save' | 'export' | 'begin' | 'commit' | 'rollback';

export type ToolbarGroup = 'run' | 'file' | 'transaction';

export interface ToolbarState {
    /** A connection is chosen for the tab. */
    hasConnection: boolean;
    running: boolean;
    /** The engine can explain a statement. */
    canExplain: boolean;
    /** The engine has transactions. */
    canTransact: boolean;
    inTransaction: boolean;
    /** Nothing to save: the tab is unchanged from its file. */
    saved: boolean;
    /** The engine can export a result. */
    canExport: boolean;
    /** What a statement is called on this engine: statement, command. */
    statementNoun: string;
}

export interface ToolbarAction {
    id: ToolbarActionId;
    group: ToolbarGroup;
    label: string;
    tooltip: string;
    disabled: boolean;
    variant: 'filled' | 'light' | 'subtle';
    color?: 'red' | 'teal' | 'yellow';
}

/** The actions to show for the state of a query tab, in toolbar order. Each id appears at most once. */
export const toolbarActions = (state: ToolbarState): ToolbarAction[] => {
    const idle = state.hasConnection && !state.running;
    const actions: ToolbarAction[] = [
        {
            id: 'run',
            group: 'run',
            label: 'Run',
            tooltip: `Run the ${state.statementNoun} at the cursor, or the selection (Ctrl+Enter)`,
            disabled: !idle,
            variant: 'filled',
        },
        {
            id: 'runAll',
            group: 'run',
            label: 'Run all',
            tooltip: `Run every ${state.statementNoun}; each result gets its own tab (Ctrl+Shift+Enter)`,
            disabled: !idle,
            variant: 'light',
        },
        {
            id: 'stop',
            group: 'run',
            label: 'Stop',
            tooltip: 'Stop the running statement',
            disabled: !state.running,
            variant: 'light',
            color: 'red',
        },
    ];
    if (state.canExplain)
        actions.push({
            id: 'explain',
            group: 'run',
            label: 'Explain',
            tooltip: 'Show how the server runs the statement',
            disabled: !idle,
            variant: 'subtle',
        });
    actions.push(
        {
            id: 'save',
            group: 'file',
            label: 'Save',
            tooltip: 'Save to a file (Ctrl+S)',
            disabled: state.saved,
            variant: 'subtle',
        },
        {
            id: 'export',
            group: 'file',
            label: 'Export',
            tooltip: 'Export the result of this statement to a file',
            disabled: !idle || !state.canExport,
            variant: 'subtle',
        },
    );
    if (state.canTransact) {
        if (state.inTransaction) {
            actions.push(
                {
                    id: 'commit',
                    group: 'transaction',
                    label: 'Commit',
                    tooltip: 'Make the changes of this transaction permanent',
                    disabled: false,
                    variant: 'light',
                    color: 'teal',
                },
                {
                    id: 'rollback',
                    group: 'transaction',
                    label: 'Roll back',
                    tooltip: 'Undo the changes of this transaction',
                    disabled: false,
                    variant: 'light',
                    color: 'yellow',
                },
            );
        } else {
            actions.push({
                id: 'begin',
                group: 'transaction',
                label: 'Begin',
                tooltip: 'Statements run in a transaction until you commit or roll back',
                disabled: !idle,
                variant: 'subtle',
            });
        }
    }
    return actions;
};

/** The ids that appear more than once; empty for a valid toolbar. */
export const duplicateActionIds = (actions: readonly ToolbarAction[]): ToolbarActionId[] => {
    const seen = new Set<ToolbarActionId>();
    const duplicated = new Set<ToolbarActionId>();
    for (const action of actions) {
        if (seen.has(action.id)) duplicated.add(action.id);
        seen.add(action.id);
    }
    return [...duplicated];
};
