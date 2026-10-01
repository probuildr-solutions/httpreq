/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { editor } from 'monaco-editor';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import {
    applyIndentation,
    AUTHORING_OPTIONS,
    BASE_EDITOR_OPTIONS,
    READ_ONLY_OPTIONS,
} from './editorOptions';
import { EditorLoading } from './EditorLoading';
import { setPurpose, type EditorPurpose } from './intelligence';
import { cx, useComputedColorScheme } from '../kit';

const Editor = lazy(() => import('../LocalEditor'));

interface Props {
    value: string;
    onChange?: (value: string) => void;
    language: string;
    ariaLabel: string;
    readOnly?: boolean;
    /**
     * What the editor is for, which decides the assistance it gets: a body (variables, validation,
     * suggestions), a script of a given stage (the script API) or output (none). A read-only editor
     * is output unless it says otherwise.
     */
    purpose?: EditorPurpose;
    className?: string;
    /** Receives the editor instance, e.g. to run "Format Document". */
    onEditor?: (instance: editor.IStandaloneCodeEditor) => void;
}

/**
 * Monaco editor with the app's font, theme, four-space indentation and compact defaults (line
 * numbers, search, folding), a small corner radius and the editor assistance for its purpose. It
 * fills its frame, so give the frame (via `className`) a size.
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
    purpose,
    className,
    onEditor,
}: Props) {
    const colorScheme = useComputedColorScheme();
    const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
        () => ({
            ...BASE_EDITOR_OPTIONS,
            ...(readOnly ? READ_ONLY_OPTIONS : AUTHORING_OPTIONS),
            ariaLabel,
            padding: readOnly ? READ_ONLY_OPTIONS.padding : { top: 10 },
            formatOnPaste: !readOnly && language === 'json',
            // Inside a JSON string is where property names are typed.
            ...(!readOnly && language === 'json'
                ? { quickSuggestions: { other: true, comments: false, strings: true } }
                : {}),
        }),
        [ariaLabel, readOnly, language],
    );
    const resolved: EditorPurpose = purpose ?? (readOnly ? { kind: 'output' } : { kind: 'body' });
    const purposeKey = resolved.kind === 'script' ? `script:${resolved.stage}` : resolved.kind;

    const editorInstance = useRef<editor.IStandaloneCodeEditor | null>(null);
    // Stable handlers: a new function each render would make the wrapper re-subscribe to Monaco.
    const latest = useRef({ onChange, onEditor, resolved });
    latest.current = { onChange, onEditor, resolved };
    const handleChange = useCallback((content: string | undefined) => {
        latest.current.onChange?.(content ?? '');
    }, []);
    const handleMount = useCallback((instance: editor.IStandaloneCodeEditor) => {
        const tag = () => {
            const model = instance.getModel();
            if (model) setPurpose(model, latest.current.resolved);
        };
        tag();
        applyIndentation(instance.getModel());
        instance.onDidChangeModel(() => {
            tag();
            applyIndentation(instance.getModel());
        });
        latest.current.onEditor?.(instance);
        editorInstance.current = instance;
    }, []);

    // A purpose that changes on a mounted editor (the same body editor, another stage).
    useEffect(() => {
        const model = editorInstance.current?.getModel();
        if (model) setPurpose(model, latest.current.resolved);
    }, [purposeKey]);

    return (
        <div className={cx('overflow-hidden rounded-sm border border-line', className)}>
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
