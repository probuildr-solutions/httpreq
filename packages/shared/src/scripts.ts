/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Contracts of the Scripts module. Scripts are plain data in and plain data out: an engine is
 * handed JSON-serializable state and returns JSON-serializable results, and never receives a
 * handle to the application, the file system, the network or the host runtime. That is what lets
 * an engine run in an isolated interpreter and lets engines be swapped without touching callers.
 */

/** The lifecycle stages a script can be attached to, in the order they run. */
export const SCRIPT_STAGES = ['preRequest', 'postResponse', 'tests'] as const;
export type ScriptStage = (typeof SCRIPT_STAGES)[number];

export const SCRIPT_STAGE_LABELS: Record<ScriptStage, string> = {
    preRequest: 'Pre-request',
    postResponse: 'Post-response',
    tests: 'Tests',
};

/** The request as a script sees and may change it, after variables and authorization. */
export interface ScriptRequestView {
    method: string;
    url: string;
    headers: Record<string, string>;
    /** The text body, or null when there is none or it is not text (binary and multipart). */
    body: string | null;
    /** False when `body` cannot be replaced, e.g. the request has a multipart body. */
    bodyEditable: boolean;
}

export interface ScriptResponseView {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    /** Empty for a binary response. */
    body: string;
    durationMs: number;
    sizeBytes: number;
}

export interface ScriptRunInput {
    stage: ScriptStage;
    code: string;
    request: ScriptRequestView;
    /** Present for the post-response and tests stages. */
    response?: ScriptResponseView;
    /** The active environment's enabled variables, name to value. */
    environment: Record<string, string>;
    /** Temporary variables shared by the stages of one send; never persisted. */
    variables: Record<string, string>;
}

export interface ScriptTestResult {
    name: string;
    passed: boolean;
    /** The assertion message of a failed test. */
    error?: string;
}

export interface ScriptLogEntry {
    level: 'log' | 'info' | 'warn' | 'error';
    message: string;
}

export interface ScriptError {
    name: string;
    message: string;
}

export interface ScriptRunResult {
    /** False when the script threw, ran out of time or memory, or the engine was unavailable. */
    ok: boolean;
    error?: ScriptError;
    request: ScriptRequestView;
    environment: Record<string, string>;
    variables: Record<string, string>;
    tests: ScriptTestResult[];
    logs: ScriptLogEntry[];
    durationMs: number;
}

/**
 * Runs one script. The only extension point engines implement: the pipeline, the test report and
 * the editors depend on this interface alone.
 */
export interface ScriptEngine {
    readonly name: string;
    run(input: ScriptRunInput): Promise<ScriptRunResult>;
}

/** Everything the scripts of one send produced, shown next to the response. */
export interface ScriptReport {
    stages: { stage: ScriptStage; ok: boolean; error?: ScriptError; durationMs: number }[];
    tests: ScriptTestResult[];
    logs: (ScriptLogEntry & { stage: ScriptStage })[];
    /** Environment variables the scripts set (name to value) and the names they removed. */
    environmentChanges: { set: Record<string, string>; unset: string[] };
}

export const emptyScriptReport = (): ScriptReport => ({
    stages: [],
    tests: [],
    logs: [],
    environmentChanges: { set: {}, unset: [] },
});
