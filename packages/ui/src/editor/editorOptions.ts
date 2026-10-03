/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { editor } from 'monaco-editor';
import { INDENT_SIZE } from '../indent';
import { MONO_FONT_FAMILY } from '../theme';

/**
 * Options every Monaco editor in the app starts from, so they all look and indent alike. Indent
 * detection is off: a body that arrives with two-space indentation must not switch the editor
 * away from the app's four spaces.
 */
export const BASE_EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: MONO_FONT_FAMILY,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    tabSize: INDENT_SIZE,
    insertSpaces: true,
    detectIndentation: false,
    lineNumbersMinChars: 3,
    renderLineHighlight: 'line',
    // The scrollbar track stays out of the way of a compact panel.
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
};

/**
 * What makes an editor you type in helpful without making it heavy: brackets and quotes close
 * and surround, matching pairs are coloured, suggestions open on trigger characters and Tab
 * accepts them, and only words from the document itself are suggested (a script editor must not
 * offer words from the body editor beside it).
 */
export const AUTHORING_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    autoClosingBrackets: 'languageDefined',
    autoClosingQuotes: 'languageDefined',
    autoClosingOvertype: 'auto',
    autoSurround: 'languageDefined',
    bracketPairColorization: { enabled: true },
    matchBrackets: 'always',
    suggestOnTriggerCharacters: true,
    tabCompletion: 'on',
    wordBasedSuggestions: 'currentDocument',
    parameterHints: { enabled: true },
    suggest: {
        showWords: true,
        preview: true,
        insertMode: 'replace',
        snippetsPreventQuickSuggestions: false,
    },
    quickSuggestions: { other: true, comments: false, strings: false },
    formatOnPaste: false,
};

/** Options for output the user only reads: generated code, a response. */
export const READ_ONLY_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    readOnly: true,
    renderLineHighlight: 'none',
    padding: { top: 8, bottom: 8 },
    domReadOnly: true,
    contextmenu: true,
    occurrencesHighlight: 'off',
    selectionHighlight: false,
};

/** Applies the app's indentation to a model, whatever it was created with. */
export const applyIndentation = (model: editor.ITextModel | null | undefined) =>
    model?.updateOptions({ tabSize: INDENT_SIZE, indentSize: INDENT_SIZE, insertSpaces: true });

/**
 * Large File Mode: what is switched off so a big document stays responsive. Everything here costs
 * time or memory in proportion to the size of the text: the minimap, folding ranges, bracket
 * colouring and matching, word and semantic highlighting, suggestions, hovers, links, colour
 * decorators, formatting on paste or type, and sticky scroll. Tokenization is dealt with by the
 * editor using the plain-text language, and the editor's own large-file optimizations are asked
 * for explicitly.
 */
export const LARGE_FILE_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    largeFileOptimizations: true,
    minimap: { enabled: false },
    folding: false,
    foldingHighlight: false,
    showFoldingControls: 'never',
    bracketPairColorization: { enabled: false },
    matchBrackets: 'never',
    guides: { bracketPairs: false, indentation: false },
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    wordBasedSuggestions: 'off',
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    hover: { enabled: false },
    links: false,
    colorDecorators: false,
    codeLens: false,
    lightbulb: { enabled: 'off' as never },
    formatOnPaste: false,
    formatOnType: false,
    renderWhitespace: 'none',
    renderLineHighlight: 'none',
    stickyScroll: { enabled: false },
    'semanticHighlighting.enabled': false,
    unicodeHighlight: {
        ambiguousCharacters: false,
        invisibleCharacters: false,
        nonBasicASCII: false,
    },
    smoothScrolling: false,
    cursorSmoothCaretAnimation: 'off',
    wordWrap: 'off',
    maxTokenizationLineLength: 2000,
};
