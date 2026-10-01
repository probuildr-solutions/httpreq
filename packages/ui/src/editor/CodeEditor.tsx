/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { editor } from 'monaco-editor';
import { lazy, Suspense, useCallback, useMemo, useRef } from 'react';
import { applyIndentation, BASE_EDITOR_OPTIONS } from './editorOptions';
import { EditorLoading } from './EditorLoading';
import { cx, useComputedColorScheme } from '../kit';

const Editor = lazy(() => import('../LocalEditor'));

interface Props {
    value: string;
    onChange?: (value: string) => void;
    language: string;
    ariaLabel: string;
    readOnly?: boolean;
    className?: string;
    /** Receives the editor instance, e.g. to run "Format Document". */
    onEditor?: (instance: editor.IStandaloneCodeEditor) => void;
}

/**
 * Monaco editor with the app's font, theme, four-space indentation and compact defaults (line
 * numbers, search, folding). It fills its frame, so give the frame (via `className`) a size.
 *
 * Changing `language` (JSON to XML, say) keeps the same editor instance and only switches the
 * model's language; the options object is stable, so a re-render never reconfigures Monaco.
 */
export function CodeEditor({
    value,
    onChange,
    language,
    ariaLabel,
    readOnly,
    className,
    onEditor,
}: Props) {
    const colorScheme = useComputedColorScheme();
    const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
        () => ({
            ...BASE_EDITOR_OPTIONS,
            ariaLabel,
            readOnly,
            padding: { top: 10 },
            formatOnPaste: language === 'json',
        }),
        [ariaLabel, readOnly, language],
    );

    // Stable handlers: a new function each render would make the wrapper re-subscribe to Monaco.
    const latest = useRef({ onChange, onEditor });
    latest.current = { onChange, onEditor };
    const handleChange = useCallback((content: string | undefined) => {
        latest.current.onChange?.(content ?? '');
    }, []);
    const handleMount = useCallback((instance: editor.IStandaloneCodeEditor) => {
        applyIndentation(instance.getModel());
        instance.onDidChangeModel(() => applyIndentation(instance.getModel()));
        latest.current.onEditor?.(instance);
    }, []);

    return (
        <div className={cx('overflow-hidden border border-line', className)}>
            <Suspense fallback={<EditorLoading />}>
                <Editor
                    language={language}
                    theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
                    value={value}
                    onChange={handleChange}
                    onMount={handleMount}
                    loading={<EditorLoading />}
                    options={options}
                />
            </Suspense>
        </div>
    );
}
