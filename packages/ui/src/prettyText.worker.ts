/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/// <reference lib="webworker" />
import { prettyText, type PrettyKind } from './prettyText';

/** Formats large bodies off the UI thread; see `prettyBody.ts`. */
self.onmessage = (event: MessageEvent<{ id: number; text: string; kind: PrettyKind }>) => {
    const { id, text, kind } = event.data;
    self.postMessage({ id, result: prettyText(text, kind) });
};
