/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { IDisposable, editor } from 'monaco-editor';
import { editorCatalog } from './catalog';
import { purposeOf } from './context';
import type { EditorFeature, Monaco } from './feature';
import { jsonDiagnostics } from './jsonDiagnostics';
import { propertyNameAt } from './jsonKeys';
import { matchNames } from './variables';

const OWNER = 'httpreq-json';
const VALIDATION_DELAY_MS = 250;
/** Beyond this a body is not validated as it is typed: parsing it on each keystroke would show. */
const MAX_VALIDATED_LENGTH = 1_000_000;

/**
 * JSON bodies: variable-aware validation (see `jsonDiagnostics.ts`) and property names taken from
 * the other requests in the workspace. Monaco's JSON language service still provides formatting,
 * folding, hover and its own completions; only its validation is replaced, because it cannot
 * tell `{{variables}}` from a syntax error.
 */
export const jsonFeature: EditorFeature = {
    id: 'json',

    register(monaco) {
        // The worker's validation would underline every unquoted variable.
        const json = (
            monaco.languages as unknown as {
                json?: { jsonDefaults: { setDiagnosticsOptions(options: object): void } };
            }
        ).json;
        json?.jsonDefaults.setDiagnosticsOptions({
            validate: false,
            allowComments: false,
            schemaValidation: 'ignore',
        });

        const completion = monaco.languages.registerCompletionItemProvider('json', {
            triggerCharacters: ['"'],
            provideCompletionItems(model, position) {
                if (purposeOf(model).kind !== 'body') return { suggestions: [] };
                const before = model.getValueInRange({
                    startLineNumber: 1,
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column,
                });
                const name = propertyNameAt(before);
                if (!name) return { suggestions: [] };
                const text = model.getValue();
                // Keys the document already has are offered by the JSON service itself.
                const keys = matchNames(
                    editorCatalog.jsonKeys().filter((key) => !text.includes(`"${key}"`)),
                    name.partial,
                );
                const range = new monaco.Range(
                    position.lineNumber,
                    position.column - name.partial.length,
                    position.lineNumber,
                    position.column,
                );
                return {
                    suggestions: keys.map((key, index) => ({
                        label: key,
                        kind: monaco.languages.CompletionItemKind.Property,
                        detail: 'Used in this workspace',
                        insertText: key,
                        sortText: `2${String(index).padStart(4, '0')}`,
                        range,
                    })),
                };
            },
        });
        return [completion];
    },

    attach(monaco, model) {
        return new JsonMarkers(monaco, model);
    },
};

/** Keeps one JSON model's markers current as its text changes. */
class JsonMarkers implements IDisposable {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly subscriptions: IDisposable[];

    constructor(
        private readonly monaco: Monaco,
        private readonly model: editor.ITextModel,
    ) {
        this.subscriptions = [
            model.onDidChangeContent(() => this.schedule()),
            // The same model can switch between JSON and another format.
            model.onDidChangeLanguage(() => this.schedule()),
        ];
        this.schedule();
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.validate(), VALIDATION_DELAY_MS);
    }

    private validate(): void {
        const { model, monaco } = this;
        if (model.isDisposed()) return;
        const applies =
            model.getLanguageId() === 'json' &&
            purposeOf(model).kind === 'body' &&
            model.getValueLength() <= MAX_VALIDATED_LENGTH;
        if (!applies) {
            monaco.editor.setModelMarkers(model, OWNER, []);
            return;
        }
        const markers: editor.IMarkerData[] = jsonDiagnostics(model.getValue()).map((problem) => {
            const start = model.getPositionAt(problem.offset);
            const end = model.getPositionAt(problem.offset + Math.max(1, problem.length));
            return {
                severity:
                    problem.severity === 'error'
                        ? monaco.MarkerSeverity.Error
                        : monaco.MarkerSeverity.Warning,
                message: problem.message,
                startLineNumber: start.lineNumber,
                startColumn: start.column,
                endLineNumber: end.lineNumber,
                endColumn: end.column,
                source: 'JSON',
            };
        });
        monaco.editor.setModelMarkers(model, OWNER, markers);
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.subscriptions.forEach((subscription) => subscription.dispose());
        if (!this.model.isDisposed()) this.monaco.editor.setModelMarkers(this.model, OWNER, []);
    }
}
