/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    emptyScriptReport,
    type Environment,
    type HttpRequest,
    type HttpResponse,
    type ScriptEngine,
    type ScriptError,
    type ScriptReport,
    type ScriptRequestView,
    type ScriptResponseView,
    type ScriptRunInput,
    type ScriptRunResult,
    type ScriptStage,
} from '@httpreq/shared';

/** The enabled variables of an environment as the name-to-value map scripts see. */
export const environmentToRecord = (environment: Environment | null): Record<string, string> => {
    const record: Record<string, string> = {};
    for (const variable of environment?.variables ?? []) {
        if (variable.enabled && variable.key.trim()) record[variable.key.trim()] = variable.value;
    }
    return record;
};

const toResponseView = (response: HttpResponse): ScriptResponseView => ({
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.binary ? '' : response.body,
    durationMs: response.durationMs,
    sizeBytes: response.sizeBytes,
});

const describe = (stage: ScriptStage, error: ScriptError) =>
    `${stage === 'preRequest' ? 'The pre-request script' : stage === 'postResponse' ? 'The post-response script' : 'The tests script'} failed: ${error.message}`;

/**
 * Connects a {@link ScriptEngine} to the request pipeline. One instance serves one send: it keeps
 * the environment and temporary variables that the stages share, collects the report, and
 * implements the pipeline's `ScriptRunner` seam structurally (it imports nothing from it, so the
 * pipeline and the scripting module stay independent).
 *
 * A failing pre-request script stops the send: the request it would have shaped is not the one the
 * user meant. Failures after the response arrived are reported next to it instead, because the
 * response is already in hand.
 */
export class ScriptSession {
    private environment: Record<string, string>;
    private readonly initial: Record<string, string>;
    private variables: Record<string, string> = {};
    private readonly result: ScriptReport = emptyScriptReport();

    constructor(
        private readonly engine: ScriptEngine,
        environment: Environment | null,
    ) {
        this.initial = environmentToRecord(environment);
        this.environment = { ...this.initial };
    }

    /** Whether any stage of this request has a script, so callers can skip the machinery. */
    static hasScripts(request: Pick<HttpRequest, 'scripts'>): boolean {
        const { preRequest, postResponse, tests } = request.scripts;
        return !!(preRequest.trim() || postResponse.trim() || tests.trim());
    }

    private async run(
        stage: ScriptStage,
        code: string,
        input: Pick<ScriptRunInput, 'request' | 'response'>,
    ) {
        const outcome: ScriptRunResult = await this.engine.run({
            stage,
            code,
            request: input.request,
            ...(input.response ? { response: input.response } : {}),
            environment: this.environment,
            variables: this.variables,
        });
        this.result.stages.push({
            stage,
            ok: outcome.ok,
            ...(outcome.error ? { error: outcome.error } : {}),
            durationMs: outcome.durationMs,
        });
        this.result.tests.push(...outcome.tests);
        this.result.logs.push(...outcome.logs.map((entry) => ({ ...entry, stage })));
        if (outcome.ok) {
            this.environment = outcome.environment;
            this.variables = outcome.variables;
        }
        return outcome;
    }

    async preRequest(view: ScriptRequestView, source: HttpRequest): Promise<void> {
        const code = source.scripts.preRequest;
        if (!code.trim()) return;
        const outcome = await this.run('preRequest', code, { request: view });
        if (!outcome.ok) {
            throw new AppError('INVALID_REQUEST', describe('preRequest', outcome.error!));
        }
        Object.assign(view, outcome.request);
        view.headers = outcome.request.headers;
    }

    async postResponse(response: HttpResponse, source: HttpRequest): Promise<void> {
        const request: ScriptRequestView = {
            method: source.method,
            url: source.url,
            headers: {},
            body: null,
            bodyEditable: false,
        };
        const stages: [ScriptStage, string][] = [
            ['postResponse', source.scripts.postResponse],
            ['tests', source.scripts.tests],
        ];
        for (const [stage, code] of stages) {
            if (!code.trim()) continue;
            await this.run(stage, code, { request, response: toResponseView(response) });
        }
    }

    /** What the scripts of this send produced; environment changes are relative to the start. */
    report(): ScriptReport {
        const set: Record<string, string> = {};
        for (const [key, value] of Object.entries(this.environment)) {
            if (this.initial[key] !== value) set[key] = value;
        }
        const unset = Object.keys(this.initial).filter((key) => !(key in this.environment));
        return { ...this.result, environmentChanges: { set, unset } };
    }
}
