/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { IDisposable, editor } from 'monaco-editor';

export type Monaco = typeof import('monaco-editor/esm/vs/editor/editor.api');

/**
 * One piece of editor assistance. A feature registers its language providers once, and may attach
 * to individual models (to validate or decorate them). Features know nothing of each other, so a
 * new one is a new file and a line in the list in `index.ts`.
 */
export interface EditorFeature {
    readonly id: string;
    /** Registers providers for the whole page. */
    register(monaco: Monaco): IDisposable[];
    /** Called for every model that is created; return a disposable to tidy up when it goes. */
    attach?(monaco: Monaco, model: editor.ITextModel): IDisposable | undefined;
}
