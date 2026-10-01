/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The Monaco features the editors opt into. `monaco-editor/esm/vs/editor/editor.api` is the bare
 * editor: it types and highlights, but has no suggestion list, hover, formatting, find or folding
 * until the module that provides each one is imported. `editor.all` imports every one of them
 * (the diff editor, code lenses, rename, references, inline completions…); this is the subset an
 * API client's request, script and response editors use, which keeps the editor chunk smaller and
 * its start-up quicker.
 *
 * Importing a module is the whole act: each registers its actions and widgets on load.
 */

// Suggestions, snippets and the parameter hints of a call.
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2';
import 'monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints';
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution';

// Formatting, folding and finding.
import 'monaco-editor/esm/vs/editor/contrib/format/browser/formatActions';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';

// Reading and editing code: matching brackets, comments, lines, words, multiple cursors.
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment';
import 'monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect';
import 'monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations';
import 'monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo';

// Going to the next problem (F8) after validation marks one, the context menu, the clipboard
// actions, and the message shown when a read-only editor is typed into.
import 'monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution';
import 'monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization';

// The icon font the suggestion kinds, folding arrows and hover widgets draw with.
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles';
