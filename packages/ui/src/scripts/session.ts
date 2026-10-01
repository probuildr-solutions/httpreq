/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { QuickJsScriptEngine, ScriptSession } from '@httpreq/scripting';
import type { Environment, HttpRequest, ScriptEngine } from '@httpreq/shared';

/**
 * The application's script engine. One instance is shared: it loads the interpreter on first use
 * and creates a fresh, isolated interpreter for every script run. Replacing the engine (for a
 * different sandbox) means changing this one line.
 */
let engine: ScriptEngine | null = null;
export const scriptEngine = (): ScriptEngine => (engine ??= new QuickJsScriptEngine());

/** A script session for one send, or null when the request has no scripts (nothing to load). */
export const createScriptSession = (
    request: HttpRequest,
    environment: Environment | null,
): ScriptSession | null =>
    ScriptSession.hasScripts(request) ? new ScriptSession(scriptEngine(), environment) : null;
