/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { editor } from 'monaco-editor';
import type { ScriptStage } from '@httpreq/shared';

/**
 * What an editor is for. Providers are registered per language and a language is shared (the
 * Scripts editor and a JavaScript request body are both `javascript`), so each model is tagged
 * with its purpose and a provider answers only for the purposes it understands.
 */
export type EditorPurpose =
    /** A request or message body: text with `{{variables}}`. */
    | { kind: 'body' }
    /** A script that runs in the sandbox at a stage of the request. */
    | { kind: 'script'; stage: ScriptStage }
    /** Read-only output (generated code, a response): no assistance beyond highlighting. */
    | { kind: 'output' };

const purposes = new WeakMap<editor.ITextModel, EditorPurpose>();

export const setPurpose = (model: editor.ITextModel, purpose: EditorPurpose): void => {
    purposes.set(model, purpose);
};

/**
 * Assistance is opt-in: a model nobody tagged (the response viewer's) is output and gets none, so
 * no editor is validated or decorated by accident.
 */
export const purposeOf = (model: editor.ITextModel): EditorPurpose =>
    purposes.get(model) ?? { kind: 'output' };
