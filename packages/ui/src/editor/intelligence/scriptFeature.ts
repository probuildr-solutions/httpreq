/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { IDisposable, editor, languages } from 'monaco-editor';
import type { ScriptStage } from '@httpreq/shared';
import { purposeOf } from './context';
import type { EditorFeature, Monaco } from './feature';
import {
    globalsFor,
    membersOf,
    signatureOf,
    SNIPPETS,
    type ApiKind,
    type ApiMember,
} from './scriptApi';
import { callSiteAt, memberAccessAt, memberAt, resolveType } from './scriptContext';

/** The stage a model's script runs in, or null when the model is not a script. */
const stageOf = (model: editor.ITextModel): ScriptStage | null => {
    const purpose = purposeOf(model);
    return purpose.kind === 'script' ? purpose.stage : null;
};

const textBefore = (model: editor.ITextModel, line: number, column: number): string =>
    model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: line,
        endColumn: column,
    });

const markdown = (member: ApiMember): string => {
    const signature = member.params ? signatureOf(member) : member.name;
    return `\`\`\`ts\n${signature}\n\`\`\`\n\n${member.doc}`;
};

/**
 * Completion, hover and signature help for the script API in the Scripts editor. What exists, and
 * what each member does, is read from `scriptApi.ts`; how a `.` is understood is `scriptContext.ts`.
 * Nothing here needs the TypeScript language service, so the Scripts editor stays light.
 */
export const scriptFeature: EditorFeature = {
    id: 'scripts',

    register(monaco) {
        const kinds: Record<ApiKind, languages.CompletionItemKind> = {
            property: monaco.languages.CompletionItemKind.Property,
            method: monaco.languages.CompletionItemKind.Method,
            function: monaco.languages.CompletionItemKind.Function,
            class: monaco.languages.CompletionItemKind.Class,
            constant: monaco.languages.CompletionItemKind.Constant,
        };
        const asSnippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

        const item = (
            member: ApiMember,
            range: InstanceType<Monaco['Range']>,
            index: number,
        ): languages.CompletionItem => {
            const callable = member.kind === 'method' || member.kind === 'function';
            return {
                label: member.name,
                kind: kinds[member.kind],
                detail: signatureOf(member),
                documentation: { value: member.doc },
                // A call's parentheses are inserted with the cursor between them.
                insertText: callable ? `${member.name}($1)` : member.name,
                insertTextRules: callable ? asSnippet : undefined,
                sortText: String(index).padStart(4, '0'),
                range,
            };
        };

        const completion = monaco.languages.registerCompletionItemProvider('javascript', {
            triggerCharacters: ['.'],
            provideCompletionItems(model, position) {
                const stage = stageOf(model);
                if (!stage) return { suggestions: [] };
                const before = textBefore(model, position.lineNumber, position.column);
                const access = memberAccessAt(before);
                const word = model.getWordUntilPosition(position);
                const range = new monaco.Range(
                    position.lineNumber,
                    word.startColumn,
                    position.lineNumber,
                    word.endColumn,
                );
                if (access) {
                    const type = resolveType(access.path, stage);
                    return {
                        suggestions: type
                            ? membersOf(type, stage).map((member, index) =>
                                  item(member, range, index),
                              )
                            : [],
                    };
                }
                return {
                    suggestions: [
                        ...globalsFor(stage).map((member, index) => item(member, range, index)),
                        ...SNIPPETS.filter(
                            (snippet) => !snippet.stages || snippet.stages.includes(stage),
                        ).map((snippet, index): languages.CompletionItem => ({
                            label: snippet.label,
                            kind: monaco.languages.CompletionItemKind.Snippet,
                            detail: snippet.detail,
                            insertText: snippet.body,
                            insertTextRules: asSnippet,
                            sortText: `1${String(index).padStart(3, '0')}`,
                            range,
                        })),
                    ],
                };
            },
        });

        const hover = monaco.languages.registerHoverProvider('javascript', {
            provideHover(model, position) {
                const stage = stageOf(model);
                const word = stage ? model.getWordAtPosition(position) : null;
                if (!stage || !word) return null;
                // The word is replaced by a stand-in so a `.` before it reads as a member access.
                const before = textBefore(model, position.lineNumber, word.startColumn);
                const member = memberAt(memberAccessAt(`${before}x`)?.path ?? [], word.word, stage);
                if (!member) return null;
                return {
                    range: new monaco.Range(
                        position.lineNumber,
                        word.startColumn,
                        position.lineNumber,
                        word.endColumn,
                    ),
                    contents: [{ value: markdown(member) }],
                };
            },
        });

        const signatures = monaco.languages.registerSignatureHelpProvider('javascript', {
            signatureHelpTriggerCharacters: ['(', ','],
            provideSignatureHelp(model, position) {
                const stage = stageOf(model);
                if (!stage) return null;
                const site = callSiteAt(textBefore(model, position.lineNumber, position.column));
                const member = site && memberAt(site.path, site.name, stage);
                if (!site || !member?.params || member.params.length === 0) return null;
                return {
                    value: {
                        signatures: [
                            {
                                label: signatureOf(member),
                                documentation: { value: member.doc },
                                parameters: member.params.map((param) => ({
                                    label: param.name,
                                    documentation: param.doc,
                                })),
                            },
                        ],
                        activeSignature: 0,
                        activeParameter: Math.min(site.argument, member.params.length - 1),
                    },
                    dispose() {},
                };
            },
        });

        return [completion, hover, signatures] satisfies IDisposable[];
    },
};
