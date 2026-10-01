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
};

/** Applies the app's indentation to a model, whatever it was created with. */
export const applyIndentation = (model: editor.ITextModel | null | undefined) =>
    model?.updateOptions({ tabSize: INDENT_SIZE, indentSize: INDENT_SIZE, insertSpaces: true });
