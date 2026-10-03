/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useState } from 'react';
import { AppModal } from '../../AppModal';
import { Alert, Button, Text } from '../../kit';
import { useDbManager } from '../db/useDbManager';

/**
 * Shows statements before they run and runs them on request. Every action that changes the
 * database from a form (creating an index, dropping a trigger, calling a procedure) goes through
 * this one dialog, so the person always sees the exact SQL, and a failure names the statement that
 * failed and how many before it had already been applied.
 */
export function RunStatementsDialog({
    title,
    description,
    statements,
    profileId,
    confirmLabel = 'Run',
    danger,
    onClose,
    onDone,
}: {
    title: string;
    description?: string;
    statements: string[];
    profileId: string;
    confirmLabel?: string;
    danger?: boolean;
    onClose: () => void;
    onDone: () => void;
}) {
    const { ops } = useDbManager();
    const [running, setRunning] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const run = async () => {
        if (!ops) return;
        setRunning(true);
        setFailure(null);
        try {
            const outcomes = await ops.execute(profileId, statements);
            const failed = outcomes.find((o) => !o.ok);
            if (failed) {
                const applied = outcomes.filter((o) => o.ok).length;
                setFailure(
                    `${failed.error}\n\nThe statement that failed:\n${failed.sql}${applied ? `\n\n${applied} earlier statement${applied === 1 ? ' was' : 's were'} already applied.` : ''}`,
                );
                return;
            }
            onDone();
        } finally {
            setRunning(false);
        }
    };

    return (
        <AppModal
            opened
            onClose={onClose}
            title={title}
            size="lg"
            footer={
                <>
                    <Button size="xs" variant="subtle" onClick={onClose} disabled={running}>
                        Cancel
                    </Button>
                    <Button
                        size="xs"
                        color={danger ? 'red' : undefined}
                        loading={running}
                        disabled={statements.length === 0}
                        onClick={() => void run()}
                    >
                        {confirmLabel}
                    </Button>
                </>
            }
        >
            {description && (
                <Text size="sm" className="mb-2">
                    {description}
                </Text>
            )}
            <pre
                aria-label="Statements to run"
                className="m-0 max-h-80 overflow-auto rounded-sm border border-line bg-hover p-2 font-mono text-xs whitespace-pre-wrap"
            >
                {statements.join('\n\n')}
            </pre>
            {failure && (
                <Alert color="red" className="mt-2" title="It did not complete">
                    <pre className="m-0 font-mono text-xs whitespace-pre-wrap">{failure}</pre>
                </Alert>
            )}
        </AppModal>
    );
}
