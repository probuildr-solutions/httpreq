/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconCheck, IconCopy } from '@tabler/icons-react';
import type { editor } from 'monaco-editor';
import { useRef, useState, type ReactNode } from 'react';
import { CodeEditor } from '../../../editor/CodeEditor';
import { Alert, Button, CopyButton, Text, cx } from '../../../kit';

/** A labelled group of fields on a two-column grid; a field may span both. */
export function FormSection({
    title,
    description,
    children,
    className,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section className={cx('flex flex-col gap-2', className)} aria-label={title}>
            <div>
                <h3 className="m-0 text-sm font-semibold">{title}</h3>
                {description && (
                    <Text size="xs" className="text-dimmed">
                        {description}
                    </Text>
                )}
            </div>
            {children}
        </section>
    );
}

/** The fields of a section, two to a row and one on a narrow window. */
export const FIELD_GRID = 'grid grid-cols-1 gap-x-3 gap-y-2 @min-[640px]/form:grid-cols-2';

/** Shows generated statements read-only, with a copy button. */
export function SqlPreview({
    statements,
    empty = 'Nothing to run yet.',
    className,
}: {
    statements: readonly string[];
    empty?: string;
    className?: string;
}) {
    const text = statements.join('\n\n');
    return (
        <div className={cx('relative', className)}>
            {statements.length === 0 ? (
                <Text size="xs" className="text-dimmed">
                    {empty}
                </Text>
            ) : (
                <>
                    <pre
                        aria-label="Generated SQL"
                        className="m-0 max-h-72 overflow-auto rounded-sm border border-line bg-hover p-2 pr-10 font-mono text-xs whitespace-pre-wrap"
                    >
                        {text}
                    </pre>
                    <div className="absolute top-1 right-1">
                        <CopyButton value={text}>
                            {({ copied, copy }) => (
                                <Button
                                    size="compact-xs"
                                    variant="subtle"
                                    aria-label="Copy SQL"
                                    onClick={copy}
                                >
                                    {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                                </Button>
                            )}
                        </CopyButton>
                    </div>
                </>
            )}
        </div>
    );
}

/**
 * The Monaco editor for the body of a trigger, routine or event: the only place these forms use
 * a code editor. It exposes its instance so the form can read and replace the text (Format).
 */
export function BodyEditor({
    label,
    value,
    onChange,
    language,
    height = 'h-56',
    hint,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    language: string;
    height?: string;
    hint?: ReactNode;
}) {
    const instance = useRef<editor.IStandaloneCodeEditor | null>(null);
    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">{label}</label>
            {hint && (
                <Text size="xs" className="text-dimmed">
                    {hint}
                </Text>
            )}
            <CodeEditor
                value={value}
                onChange={onChange}
                language={language}
                ariaLabel={label}
                purpose={{ kind: 'output' }}
                className={height}
                onEditor={(next) => {
                    instance.current = next;
                }}
            />
        </div>
    );
}

export interface EditorShellProps {
    /** Fields above the scrolling body: the object's name, its target. */
    header: ReactNode;
    children: ReactNode;
    /** Problems that stop saving, shown above the form. */
    problems: readonly string[];
    /** The statements Save will run, for the preview. */
    statements: readonly string[];
    saveLabel: string;
    onSave: () => void;
    onCancel: () => void;
    /** Formats the body; omit to hide the button. */
    onFormat?: () => void;
    /** Extra checks beyond the form rules; its result is shown below the footer. */
    onValidate: () => string[];
    testId: string;
}

/**
 * The frame of a structured object editor: a header, the form, an optional SQL preview and a
 * footer with Save, Cancel, Preview SQL, Format and Validate. Trigger, procedure, function and
 * event editors share it, so they look and behave the same.
 */
export function EditorShell({
    header,
    children,
    problems,
    statements,
    saveLabel,
    onSave,
    onCancel,
    onFormat,
    onValidate,
    testId,
}: EditorShellProps) {
    const [preview, setPreview] = useState(false);
    const [checked, setChecked] = useState<string[] | null>(null);
    const validate = () => setChecked(onValidate());

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid={testId}>
            <div className="box-border flex min-h-10 flex-none flex-wrap items-center gap-2 border-b border-line bg-chrome px-2 py-1">
                {header}
            </div>
            <div className="@container/form min-h-0 flex-1 overflow-auto p-3">
                <div className="mx-auto flex max-w-5xl flex-col gap-5">
                    {problems.length > 0 && (
                        <Alert color="yellow" aria-label="Problems">
                            <ul className="m-0 list-none p-0">
                                {problems.map((problem) => (
                                    <li key={problem}>{problem}</li>
                                ))}
                            </ul>
                        </Alert>
                    )}
                    {children}
                    {preview && (
                        <FormSection
                            title="SQL preview"
                            description="Run in this order when you save."
                        >
                            <SqlPreview
                                statements={statements}
                                empty="Fix the problems above to see the statements."
                            />
                        </FormSection>
                    )}
                </div>
            </div>
            <div className="flex flex-none flex-wrap items-center gap-2 border-t border-line bg-chrome px-2 py-1.5">
                <Button size="compact-sm" onClick={onSave}>
                    {saveLabel}
                </Button>
                <Button size="compact-sm" variant="subtle" onClick={onCancel}>
                    Cancel
                </Button>
                <span className="mx-1 h-4 w-px bg-line" aria-hidden />
                <Button
                    size="compact-sm"
                    variant="subtle"
                    aria-pressed={preview}
                    onClick={() => setPreview((value) => !value)}
                >
                    Preview SQL
                </Button>
                {onFormat && (
                    <Button size="compact-sm" variant="subtle" onClick={onFormat}>
                        Format
                    </Button>
                )}
                <Button size="compact-sm" variant="subtle" onClick={validate}>
                    Validate
                </Button>
                {checked && (
                    <span
                        role="status"
                        className={cx(
                            'min-w-0 truncate text-xs',
                            checked.length ? 'text-danger-text' : 'text-success-text',
                        )}
                        title={checked.join('\n')}
                    >
                        {checked.length ? checked[0] : 'No problems found.'}
                        {checked.length > 1 && ` (+${checked.length - 1} more)`}
                    </span>
                )}
            </div>
        </div>
    );
}
