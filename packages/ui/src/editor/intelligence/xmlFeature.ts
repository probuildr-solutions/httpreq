/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { prettyXmlText } from '../../prettyText';
import { purposeOf } from './context';
import type { EditorFeature } from './feature';
import { elementToClose } from './xml';

/**
 * XML and SOAP bodies: the element a typed `</` should close, and Format Document. Monaco's XML
 * grammar highlights but never closes tags, and has no formatter of its own; the body panel's
 * Format button used to special-case XML for the same reason, and now the keyboard shortcut and
 * the editor's own menu work too.
 */
export const xmlFeature: EditorFeature = {
    id: 'xml',

    register(monaco) {
        const closing = monaco.languages.registerCompletionItemProvider(['xml', 'html'], {
            triggerCharacters: ['/'],
            provideCompletionItems(model, position) {
                if (purposeOf(model).kind !== 'body') return { suggestions: [] };
                const before = model.getValueInRange({
                    startLineNumber: 1,
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column,
                });
                const target = elementToClose(before);
                if (!target) return { suggestions: [] };
                return {
                    suggestions: [
                        {
                            label: target.name,
                            kind: monaco.languages.CompletionItemKind.Property,
                            detail: `Close <${target.name}>`,
                            insertText: `${target.name}>`,
                            filterText: target.name,
                            sortText: '0',
                            preselect: true,
                            range: new monaco.Range(
                                position.lineNumber,
                                position.column - target.partial.length,
                                position.lineNumber,
                                position.column,
                            ),
                        },
                    ],
                };
            },
        });

        const formatting = monaco.languages.registerDocumentFormattingEditProvider('xml', {
            provideDocumentFormattingEdits(model) {
                const pretty = prettyXmlText(model.getValue());
                // A document that is not well formed is left as it is rather than mangled.
                return pretty.ok ? [{ range: model.getFullModelRange(), text: pretty.text }] : [];
            },
        });
        return [closing, formatting];
    },
};
