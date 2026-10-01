/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// The editor features (suggestions, hover, formatting, find, folding) the bare API leaves out.
import './editor/contributions';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
// Tokenizer-only grammars (no language workers) for text bodies and request scripts.
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
// Languages the code generator can target, plus protobuf for gRPC definitions.
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import 'monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import { registerEditorIntelligence } from './editor/intelligence';

(
    globalThis as typeof globalThis & {
        MonacoEnvironment?: { getWorker(moduleId: string, label: string): Worker };
    }
).MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
        return label === 'json' ? new JsonWorker() : new EditorWorker();
    },
};

loader.config({ monaco });

// Completion, hover, validation and highlighting for variables, JSON, XML and scripts.
registerEditorIntelligence(monaco);

// Monaco measures glyph widths once. The bundled monospace web font may finish loading after the
// first editor mounts, so re-measure when it arrives to keep the cursor aligned with the text.
if (typeof document !== 'undefined' && 'fonts' in document) {
    void document.fonts
        .load("13px 'JetBrains Mono'")
        .then(() => monaco.editor.remeasureFonts())
        .catch(() => undefined);
}

/**
 * Creates one editor off screen and disposes it. The first `editor.create` builds Monaco's
 * services, themes and font measurements, which is the slowest part of showing any editor.
 */
export const warmUp = () => {
    if (typeof document === 'undefined') return;
    const host = document.createElement('div');
    host.style.cssText =
        'position:fixed;left:-10000px;top:0;width:200px;height:100px;visibility:hidden';
    document.body.append(host);
    try {
        const instance = monaco.editor.create(host, { value: '{}', language: 'json' });
        instance.dispose();
    } finally {
        host.remove();
    }
};
