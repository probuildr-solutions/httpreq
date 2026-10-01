/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { IDisposable, editor } from 'monaco-editor';
import { editorCatalog } from './catalog';
import { purposeOf } from './context';
import type { EditorFeature, Monaco } from './feature';
import { matchNames, previewValue, variableAt, variablesIn, variableTrigger } from './variables';

/** Languages whose text may carry `{{variables}}`: every body format and the scripts. */
const LANGUAGES = ['json', 'plaintext', 'xml', 'html', 'javascript'];

/** A document this large is not decorated: scanning it on every keystroke would be felt. */
const MAX_DECORATED_LENGTH = 300_000;
const DECORATION_DELAY_MS = 120;

/**
 * `{{variable}}` support in every editor: names offered after `{{`, the value and source on
 * hover, and the same defined / not-defined highlighting the single-line fields use. The text
 * rules live in `variables.ts`; this file only maps them onto Monaco positions.
 */
export const variableFeature: EditorFeature = {
    id: 'variables',

    register(monaco) {
        const completion = monaco.languages.registerCompletionItemProvider(LANGUAGES, {
            triggerCharacters: ['{'],
            provideCompletionItems(model, position) {
                const resolver = editorCatalog.variables();
                if (!resolver || purposeOf(model).kind === 'output') return { suggestions: [] };
                const trigger = variableTrigger(
                    model.getLineContent(position.lineNumber),
                    position.column - 1,
                );
                if (!trigger) return { suggestions: [] };
                const range = new monaco.Range(
                    position.lineNumber,
                    trigger.start + 1,
                    position.lineNumber,
                    trigger.end + 1,
                );
                return {
                    suggestions: matchNames(resolver.names(), trigger.query).map((name, index) => {
                        const definition = resolver.lookup(name);
                        return {
                            label: name,
                            kind: definition?.dynamic
                                ? monaco.languages.CompletionItemKind.Function
                                : monaco.languages.CompletionItemKind.Variable,
                            // The braces are part of the insertion: `{{` was typed, `}}` is added.
                            insertText: `${name}}}`,
                            filterText: name,
                            sortText: String(index).padStart(4, '0'),
                            detail: definition ? previewValue(definition) : undefined,
                            documentation: definition
                                ? { value: `**{{${name}}}**\n\n${definition.source}` }
                                : undefined,
                            range,
                        };
                    }),
                };
            },
        });

        const hover = monaco.languages.registerHoverProvider(LANGUAGES, {
            provideHover(model, position) {
                if (purposeOf(model).kind === 'output') return null;
                const line = model.getLineContent(position.lineNumber);
                const found = variableAt(line, position.column - 1);
                if (!found) return null;
                const definition = editorCatalog.variables()?.lookup(found.name);
                const heading = `**{{${found.name}}}**`;
                return {
                    range: new monaco.Range(
                        position.lineNumber,
                        found.start + 1,
                        position.lineNumber,
                        found.end + 1,
                    ),
                    contents: [
                        {
                            value: definition
                                ? `${heading}\n\n\`${previewValue(definition)}\`\n\nSource: ${definition.source}`
                                : `${heading}\n\nNot defined in the active environment. It is sent as written.`,
                        },
                    ],
                };
            },
        });
        return [completion, hover];
    },

    attach(monaco, model) {
        return new VariableDecorations(monaco, model);
    },
};

/** Keeps one model's `{{variable}}` highlighting current as its text and the catalog change. */
class VariableDecorations implements IDisposable {
    private ids: string[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly subscriptions: IDisposable[] = [];
    private readonly unsubscribe: () => void;

    constructor(
        private readonly monaco: Monaco,
        private readonly model: editor.ITextModel,
    ) {
        this.subscriptions.push(model.onDidChangeContent(() => this.schedule()));
        this.unsubscribe = editorCatalog.subscribe(() => this.schedule());
        this.schedule();
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.apply(), DECORATION_DELAY_MS);
    }

    private apply(): void {
        if (this.model.isDisposed()) return;
        const { model } = this;
        const decorate =
            purposeOf(model).kind !== 'output' && model.getValueLength() <= MAX_DECORATED_LENGTH;
        const resolver = editorCatalog.variables();
        const next = decorate
            ? variablesIn(model.getValue()).map(({ name, start, end }) => {
                  const from = model.getPositionAt(start);
                  const to = model.getPositionAt(end);
                  return {
                      range: new this.monaco.Range(
                          from.lineNumber,
                          from.column,
                          to.lineNumber,
                          to.column,
                      ),
                      options: {
                          inlineClassName: resolver?.lookup(name) ? 'hr-var' : 'hr-var-missing',
                          stickiness:
                              this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                      },
                  };
              })
            : [];
        this.ids = model.deltaDecorations(this.ids, next);
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.unsubscribe();
        this.subscriptions.forEach((subscription) => subscription.dispose());
        if (!this.model.isDisposed()) this.model.deltaDecorations(this.ids, []);
    }
}
