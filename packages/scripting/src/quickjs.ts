/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    newQuickJSWASMModuleFromVariant,
    shouldInterruptAfterDeadline,
    type QuickJSContext,
    type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import type {
    ScriptEngine,
    ScriptError,
    ScriptLogEntry,
    ScriptRunInput,
    ScriptRunResult,
    ScriptTestResult,
} from '@httpreq/shared';
import { SCRIPT_PRELUDE } from './prelude';

export interface SandboxLimits {
    /** Wall-clock time a script may run, in milliseconds. */
    timeoutMs: number;
    /** Heap the interpreter may use. */
    memoryBytes: number;
    /** Native stack, which bounds recursion depth. */
    stackBytes: number;
    /** Largest script source accepted. */
    maxCodeChars: number;
    /** Longest text (a body, a header value) copied into the sandbox. */
    maxTextChars: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
    timeoutMs: 3_000,
    memoryBytes: 32 * 1024 * 1024,
    stackBytes: 512 * 1024,
    maxCodeChars: 256 * 1024,
    maxTextChars: 2 * 1024 * 1024,
};

/** Loads the interpreter. Injectable so tests, and a future engine, need not touch the WASM. */
export type QuickJSLoader = () => Promise<QuickJSWASMModule>;

const loadQuickJS: QuickJSLoader = async () => {
    // Loaded on first use: the interpreter is a few hundred KB that a user who never writes a
    // script should not pay for.
    const { default: variant } = await import('@jitl/quickjs-singlefile-mjs-release-sync');
    return newQuickJSWASMModuleFromVariant(variant);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> | null => {
    if (!isRecord(value)) return null;
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') return null;
        result[key] = item;
    }
    return result;
};

const LEVELS = new Set(['log', 'info', 'warn', 'error']);

/**
 * What the sandbox says it produced is data from an untrusted program, so it is checked field by
 * field and anything of the wrong type is rejected, not coerced.
 */
const parseOutput = (
    raw: string,
    input: ScriptRunInput,
): Omit<ScriptRunResult, 'durationMs'> | null => {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(value) || !isRecord(value.request)) return null;
    const headers = stringRecord(value.request.headers);
    const environment = stringRecord(value.environment);
    const variables = stringRecord(value.variables);
    const { method, url, body } = value.request;
    if (
        !headers ||
        !environment ||
        !variables ||
        typeof method !== 'string' ||
        typeof url !== 'string' ||
        (body !== null && typeof body !== 'string') ||
        !Array.isArray(value.tests) ||
        !Array.isArray(value.logs)
    ) {
        return null;
    }
    const tests: ScriptTestResult[] = [];
    for (const item of value.tests) {
        if (!isRecord(item) || typeof item.name !== 'string' || typeof item.passed !== 'boolean') {
            return null;
        }
        tests.push({
            name: item.name,
            passed: item.passed,
            ...(typeof item.error === 'string' ? { error: item.error } : {}),
        });
    }
    const logs: ScriptLogEntry[] = [];
    for (const item of value.logs) {
        if (
            !isRecord(item) ||
            typeof item.message !== 'string' ||
            !LEVELS.has(String(item.level))
        ) {
            return null;
        }
        logs.push({ level: item.level as ScriptLogEntry['level'], message: item.message });
    }
    return {
        ok: true,
        request: {
            method,
            url,
            headers,
            // A body that could not be replaced stays as it was.
            body: input.request.bodyEditable ? body : input.request.body,
            bodyEditable: input.request.bodyEditable,
        },
        environment,
        variables,
        tests,
        logs,
    };
};

const failure = (
    input: ScriptRunInput,
    error: ScriptError,
    durationMs: number,
): ScriptRunResult => ({
    ok: false,
    error,
    request: input.request,
    environment: input.environment,
    variables: input.variables,
    tests: [],
    logs: [],
    durationMs,
});

const describeError = (dumped: unknown, limits: SandboxLimits): ScriptError => {
    const error = isRecord(dumped) ? dumped : {};
    const name = typeof error.name === 'string' ? error.name : 'Error';
    const message = typeof error.message === 'string' ? error.message : String(dumped);
    if (message === 'interrupted') {
        return {
            name: 'TimeoutError',
            message: `The script ran longer than ${limits.timeoutMs} ms and was stopped.`,
        };
    }
    if (/out of memory/i.test(message)) {
        return { name: 'MemoryError', message: 'The script used more memory than it is allowed.' };
    }
    return { name, message };
};

const truncate = (text: string, limit: number) =>
    text.length > limit ? text.slice(0, limit) : text;

/**
 * Runs scripts in QuickJS compiled to WebAssembly.
 *
 * Every run gets a fresh interpreter with a memory ceiling, a stack ceiling and a deadline, and the
 * interpreter has no host functions: it cannot reach the network, the file system, Electron, Node
 * or the page, because none of them exist inside it. Data goes in as a JSON string and comes out
 * as one, and is validated before the host uses it.
 */
export class QuickJsScriptEngine implements ScriptEngine {
    readonly name = 'QuickJS (WebAssembly sandbox)';
    private module: Promise<QuickJSWASMModule> | null = null;
    private readonly limits: SandboxLimits;

    constructor(
        limits: Partial<SandboxLimits> = {},
        private readonly load: QuickJSLoader = loadQuickJS,
    ) {
        this.limits = { ...DEFAULT_LIMITS, ...limits };
    }

    private quickJs(): Promise<QuickJSWASMModule> {
        this.module ??= this.load().catch((cause: unknown) => {
            // Retry on the next run instead of caching a failed load forever.
            this.module = null;
            throw cause;
        });
        return this.module;
    }

    async run(input: ScriptRunInput): Promise<ScriptRunResult> {
        const started = Date.now();
        const elapsed = () => Date.now() - started;
        const { limits } = this;
        if (input.code.length > limits.maxCodeChars) {
            return failure(
                input,
                { name: 'Error', message: 'The script is larger than 256 KB.' },
                0,
            );
        }

        let QuickJS: QuickJSWASMModule;
        try {
            QuickJS = await this.quickJs();
        } catch {
            return failure(
                input,
                {
                    name: 'SandboxUnavailable',
                    message:
                        'The script sandbox could not be started. Scripts do not run without it, and are never run outside it.',
                },
                elapsed(),
            );
        }

        const runtime = QuickJS.newRuntime();
        let context: QuickJSContext | undefined;
        try {
            runtime.setMemoryLimit(limits.memoryBytes);
            runtime.setMaxStackSize(limits.stackBytes);
            runtime.setInterruptHandler(
                shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs),
            );
            context = runtime.newContext();
            const vm = context;

            const bounded: ScriptRunInput = {
                ...input,
                request: {
                    ...input.request,
                    body:
                        input.request.body === null
                            ? null
                            : truncate(input.request.body, limits.maxTextChars),
                },
                ...(input.response
                    ? {
                          response: {
                              ...input.response,
                              body: truncate(input.response.body, limits.maxTextChars),
                          },
                      }
                    : {}),
            };
            const { code, ...data } = bounded;
            void code; // The source is evaluated separately; only the data goes in as JSON.
            const json = vm.newString(JSON.stringify(data));
            vm.setProp(vm.global, '__input', json);
            json.dispose();

            const evaluate = (source: string, filename: string): ScriptError | null => {
                const result = vm.evalCode(source, filename);
                if (result.error) {
                    const dumped = vm.dump(result.error);
                    result.error.dispose();
                    return describeError(dumped, limits);
                }
                result.value.dispose();
                return null;
            };

            const prelude = evaluate(SCRIPT_PRELUDE, 'prelude.js');
            if (prelude) return failure(input, prelude, elapsed());
            const userError = evaluate(input.code, 'script.js');
            // Promise callbacks the script queued (a `.then`) run before the result is read.
            const pending = runtime.executePendingJobs();
            if (pending.error) {
                const dumped = vm.dump(pending.error);
                pending.error.dispose();
                if (!userError) return failure(input, describeError(dumped, limits), elapsed());
            }

            const finished = vm.evalCode('__finish()', 'finish.js');
            if (finished.error) {
                const dumped = vm.dump(finished.error);
                finished.error.dispose();
                return failure(input, userError ?? describeError(dumped, limits), elapsed());
            }
            const raw = vm.dump(finished.value) as unknown;
            finished.value.dispose();
            const output = typeof raw === 'string' ? parseOutput(raw, input) : null;
            if (!output) {
                return failure(
                    input,
                    userError ?? {
                        name: 'Error',
                        message: 'The script produced an unreadable result.',
                    },
                    elapsed(),
                );
            }
            // A script that threw still reports what ran before it (logs, completed tests).
            return userError
                ? { ...output, ok: false, error: userError, durationMs: elapsed() }
                : { ...output, durationMs: elapsed() };
        } catch (cause) {
            return failure(
                input,
                describeError({ message: String((cause as Error)?.message ?? cause) }, limits),
                elapsed(),
            );
        } finally {
            try {
                context?.dispose();
                runtime.dispose();
            } catch {
                // QuickJS can abort while freeing a runtime that hit its stack limit. The result of
                // the run is already in hand; the aborted WebAssembly instance is not reusable, so
                // the next run starts a fresh one.
                this.module = null;
            }
        }
    }
}
