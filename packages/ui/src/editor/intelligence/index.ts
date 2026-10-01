/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { IDisposable, editor } from 'monaco-editor';
import type { EditorFeature, Monaco } from './feature';
import { jsonFeature } from './jsonFeature';
import { scriptFeature } from './scriptFeature';
import { variableFeature } from './variableFeature';
import { xmlFeature } from './xmlFeature';

export { editorCatalog } from './catalog';
export { setPurpose, type EditorPurpose } from './context';
export { firstJsonError, jsonDiagnostics } from './jsonDiagnostics';
export { collectJsonKeys } from './jsonKeys';

/** Every feature, in the order they register. A new kind of assistance is added here. */
export const EDITOR_FEATURES: readonly EditorFeature[] = [
    variableFeature,
    jsonFeature,
    scriptFeature,
    xmlFeature,
];

let registered = false;

/**
 * Registers the editor features with Monaco, once. Providers are page-wide; features that act on
 * a model (validation, highlighting) are attached to every model as it is created and detached
 * when it is disposed.
 */
export const registerEditorIntelligence = (monaco: Monaco): void => {
    if (registered) return;
    registered = true;

    const attached = new Map<editor.ITextModel, IDisposable[]>();
    const attach = (model: editor.ITextModel) => {
        if (attached.has(model)) return;
        const disposables = EDITOR_FEATURES.flatMap(
            (feature) => feature.attach?.(monaco, model) ?? [],
        );
        attached.set(model, disposables);
        model.onWillDispose(() => {
            attached.get(model)?.forEach((disposable) => disposable.dispose());
            attached.delete(model);
        });
    };

    EDITOR_FEATURES.forEach((feature) => feature.register(monaco));
    monaco.editor.onDidCreateModel(attach);
    monaco.editor.getModels().forEach(attach);
};
