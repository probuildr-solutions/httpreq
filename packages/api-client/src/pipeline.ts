/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    applyPathVariables,
    isHttpMethod,
    type AuthConfig,
    type Environment,
    type ExecutionHooks,
    type FileReference,
    type HttpMethod,
    type HttpRequest,
    type HttpResponse,
    type HttpRuntime,
    type PreparedBody,
    type PreparedRequest,
    type ScriptRequestView,
    type Workspace,
} from '@httpreq/shared';
import { getAuthProvider, resolveEffectiveAuth, type EffectiveAuth } from './auth/registry';
import { HeaderMap, type AuthContext, type RequestDraft } from './auth/types';
import { defaultBodyContentType } from './generatedHeaders';
import { soapToHttp } from './protocols/soap/adapter';
import { createVariableResolver, type ResolverOptions, type VariableResolver } from './variables';

/**
 * Request execution pipeline, shared by the web and desktop apps:
 *
 *   saved request → variable resolution → authorization resolution → pre-request scripts →
 *   final request builder → platform runtime → response processing → post-response scripts
 *
 * The saved request is never mutated; resolved values only exist in the `PreparedRequest`.
 */

/**
 * Lifecycle hooks for request scripts; the seam the Scripts module (`@httpreq/scripting`) plugs
 * into. The pipeline hands a script runner plain data and takes plain data back: `preRequest`
 * mutates the view it is given, and the pipeline validates and applies the result, so a script can
 * never put the request into a shape the transport would not accept.
 */
export interface ScriptRunner {
    preRequest?(request: ScriptRequestView, source: HttpRequest): void | Promise<void>;
    postResponse?(response: HttpResponse, source: HttpRequest): void | Promise<void>;
}

/**
 * Runs the pre-request scripts over a view of the request and returns the validated result, or
 * null when no script ran. Shared by every protocol that has a request to script.
 */
export const runPreRequestScripts = async (
    scripts: ScriptRunner | undefined,
    view: ScriptRequestView,
    source: HttpRequest,
): Promise<ScriptRequestView | null> => {
    if (!scripts?.preRequest) return null;
    const working: ScriptRequestView = { ...view, headers: { ...view.headers } };
    await scripts.preRequest(working, source);
    return working;
};

export interface PipelineContext {
    /** For authorization inheritance. */
    workspace: Workspace;
    environment: Environment | null;
    /** Reads the bytes of a file chosen for a binary or multipart body. */
    readFile?(file: FileReference): Promise<Uint8Array | undefined>;
    scripts?: ScriptRunner;
    now?: () => number;
    resolverOptions?: ResolverOptions;
}

export interface BuiltRequest {
    prepared: PreparedRequest;
    effectiveAuth: EffectiveAuth;
    /** The effective authorization with variables substituted (used to answer challenges). */
    resolvedAuth: AuthConfig;
    warnings: string[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Manually configured, enabled headers that the effective authorization will replace. */
export const findHeaderConflicts = (request: HttpRequest, effective: EffectiveAuth): string[] => {
    const applied = new Set(
        getAuthProvider(effective.auth)
            .appliedHeaders(effective.auth)
            .map((name) => name.toLowerCase()),
    );
    return request.headers
        .filter((item) => item.enabled && item.key && applied.has(item.key.trim().toLowerCase()))
        .map((item) => item.key);
};

const enabledRows = <T extends { enabled: boolean; key: string }>(items: T[]) =>
    items.filter((item) => item.enabled && item.key.trim() !== '');

const readFile = async (context: PipelineContext, file: FileReference | null | undefined) => {
    if (!file) throw new AppError('INVALID_REQUEST', 'Select a file for the request body.');
    const bytes = await context.readFile?.(file);
    if (!bytes) {
        throw new AppError(
            'INVALID_REQUEST',
            `The file “${file.name}” is no longer available. Select it again; files are not kept after a restart.`,
        );
    }
    return bytes;
};

const buildBody = async (
    request: HttpRequest,
    resolver: VariableResolver,
    headers: HeaderMap,
    context: PipelineContext,
    warnings: string[],
): Promise<PreparedBody | undefined> => {
    const { body } = request;
    if (body.mode === 'none') return undefined;
    if (request.method === 'GET' || request.method === 'HEAD') {
        warnings.push(`The body is not sent with ${request.method} requests.`);
        return undefined;
    }
    // The same mapping the editor previews, so what it shows is what is sent.
    const defaultType = () => {
        const type = defaultBodyContentType(body);
        if (type && !headers.has('Content-Type')) headers.set('Content-Type', type);
    };

    switch (body.mode) {
        case 'json': {
            const text = resolver.resolve(body.json);
            if (!text.trim()) return undefined;
            try {
                JSON.parse(text);
            } catch (cause) {
                throw new AppError(
                    'INVALID_REQUEST',
                    `The JSON body is not valid after variables were substituted: ${(cause as Error).message}`,
                    { cause },
                );
            }
            defaultType();
            return { kind: 'text', text };
        }
        case 'text':
            defaultType();
            return { kind: 'text', text: resolver.resolve(body.text) };
        case 'form-urlencoded': {
            const form = new URLSearchParams();
            enabledRows(body.formUrlEncoded).forEach((item) =>
                form.append(resolver.resolve(item.key), resolver.resolve(item.value)),
            );
            defaultType();
            return { kind: 'text', text: form.toString() };
        }
        case 'multipart': {
            // The runtime writes the multipart boundary; a manual Content-Type would omit it.
            if (headers.has('Content-Type')) {
                headers.delete('Content-Type');
                warnings.push(
                    'The manual Content-Type header was replaced by multipart/form-data with a boundary.',
                );
            }
            const parts = [];
            for (const field of enabledRows(body.multipart)) {
                const name = resolver.resolve(field.key);
                if (field.kind === 'file') {
                    const file = field.file;
                    parts.push({
                        name,
                        fileName: file?.name ?? 'file',
                        contentType: file?.type || 'application/octet-stream',
                        bytes: await readFile(context, file),
                    });
                } else {
                    parts.push({ name, value: resolver.resolve(field.value) });
                }
            }
            return { kind: 'multipart', parts };
        }
        case 'binary': {
            const bytes = await readFile(context, body.binary);
            defaultType();
            return { kind: 'bytes', bytes };
        }
    }
};

/** Runs every pipeline stage up to the final request, without sending it. */
export const buildRequest = async (
    source: HttpRequest,
    context: PipelineContext,
): Promise<BuiltRequest> => {
    // SOAP is HTTP with an envelope: it is reshaped into a plain HTTP request here, so everything
    // below (variables, authorization, scripts, transport) is shared with HTTP rather than copied.
    const request = source.protocol === 'soap' ? soapToHttp(source) : source;
    const warnings: string[] = [];
    const resolver = createVariableResolver(context.environment, context.resolverOptions);
    const authContext: AuthContext = {
        resolve: resolver.resolve,
        now: context.now ?? Date.now,
    };

    // 1. Variable resolution. An undefined variable in the scheme or host makes the request
    // unsendable; one in the path or query is sent as written, with a warning.
    let urlText = resolver.resolve(applyPathVariables(request.url.trim(), request.pathVariables));
    const undefinedInUrl = [...resolver.unresolved];
    if (!urlText) throw new AppError('INVALID_REQUEST', 'Enter a URL before sending.');
    if (!SCHEME.test(urlText) && !urlText.startsWith('{{')) urlText = `http://${urlText}`;
    let url: URL | undefined;
    try {
        url = new URL(urlText);
    } catch {
        url = undefined;
    }
    if (!url || url.host.includes('%7B%7B') || url.host.includes('{{')) {
        if (undefinedInUrl.length) {
            const names = undefinedInUrl.map((name) => `{{${name}}}`).join(', ');
            const scope = context.environment
                ? `the “${context.environment.name}” environment`
                : 'any environment (none is selected)';
            throw new AppError(
                'INVALID_REQUEST',
                `${names} in the URL is not defined in ${scope}.`,
            );
        }
        throw new AppError('INVALID_REQUEST', `“${urlText}” is not a valid URL.`);
    }

    let headers = new HeaderMap();
    enabledRows(request.headers).forEach((item) =>
        headers.set(resolver.resolve(item.key.trim()), resolver.resolve(item.value)),
    );
    const draft: RequestDraft = { method: request.method, url, headers };

    // 2. Authorization resolution (following inheritance), then application.
    const effectiveAuth = resolveEffectiveAuth(context.workspace, request);
    const provider = getAuthProvider(effectiveAuth.auth);
    const blocking = provider
        .validate(effectiveAuth.auth)
        .filter((issue) => issue.severity === 'error');
    if (blocking.length) {
        throw new AppError('AUTHENTICATION_ERROR', `${provider.label}: ${blocking[0]!.message}`);
    }
    const conflicts = findHeaderConflicts(request, effectiveAuth);
    if (conflicts.length) {
        warnings.push(`${provider.label} replaced the manual ${conflicts.join(', ')} header.`);
    }
    const resolvedAuth = provider.resolve(effectiveAuth.auth, authContext);
    // A variable can resolve to nothing (e.g. a session-only secret after a restart): say so.
    for (const issue of provider.validate(resolvedAuth)) {
        if (
            !provider
                .validate(effectiveAuth.auth)
                .some((original) => original.message === issue.message)
        ) {
            warnings.push(`${provider.label}: ${issue.message} (after variables were substituted)`);
        }
    }
    await provider.applyToRequest(resolvedAuth, draft, authContext);

    // 3. Final request body, then pre-request scripts over the finished request.
    let body = await buildBody(request, resolver, headers, context, warnings);
    const scripted = await runPreRequestScripts(
        context.scripts,
        {
            method: draft.method,
            url: draft.url.toString(),
            headers: headers.toRecord(),
            body: body?.kind === 'text' ? body.text : null,
            bodyEditable: !body || body.kind === 'text',
        },
        request,
    );
    if (scripted) {
        const method = scripted.method.toUpperCase();
        if (!isHttpMethod(method)) {
            throw new AppError(
                'INVALID_REQUEST',
                `The pre-request script set an unsupported method “${scripted.method}”.`,
            );
        }
        draft.method = method as HttpMethod;
        try {
            draft.url = new URL(scripted.url);
        } catch {
            throw new AppError('INVALID_REQUEST', 'The pre-request script set an invalid URL.');
        }
        headers = new HeaderMap(scripted.headers);
        if (scripted.bodyEditable) {
            const bodiless = draft.method === 'GET' || draft.method === 'HEAD';
            body = scripted.body && !bodiless ? { kind: 'text', text: scripted.body } : undefined;
        }
    }
    if (resolver.unresolved.size > 0) {
        warnings.push(
            `Not defined, sent as written: ${[...resolver.unresolved].map((name) => `{{${name}}}`).join(', ')}.`,
        );
    }
    const { settings } = request;
    return {
        prepared: {
            method: request.method,
            url: draft.url.toString(),
            headers: headers.toRecord(),
            ...(body ? { body } : {}),
            options: {
                followRedirects: settings.followRedirects,
                verifyTls: settings.verifyTls,
                sendCookies: settings.sendCookies,
                maxResponseBytes: Math.round(settings.responseSizeLimitMb * 1024 * 1024),
            },
        },
        effectiveAuth,
        resolvedAuth,
        warnings,
    };
};

export interface ExecutionResult {
    response: HttpResponse;
    built: BuiltRequest;
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Builds, sends (answering one auth challenge if the scheme supports it) and post-processes.
 *
 * The request timeout limits the wait for a response. A stream (SSE) is an intentionally open
 * connection, so the timer stops as soon as its headers arrive; the user ends it with `signal`.
 */
export const executeRequest = async (
    request: HttpRequest,
    context: PipelineContext,
    runtime: HttpRuntime,
    signal?: AbortSignal,
    hooks?: ExecutionHooks,
): Promise<ExecutionResult> => {
    const built = await buildRequest(request, context);
    const timeoutMs = request.settings.timeoutMs;
    const timeout = timeoutMs > 0 ? new AbortController() : undefined;
    const timer = timeout
        ? setTimeout(() => timeout.abort(new DOMException('Timed out.', 'TimeoutError')), timeoutMs)
        : undefined;
    const combined =
        timeout && signal ? AbortSignal.any([signal, timeout.signal]) : (timeout?.signal ?? signal);
    const streamHooks: ExecutionHooks = {
        ...hooks,
        onStreamStart: (head) => {
            clearTimeout(timer);
            hooks?.onStreamStart?.(head);
        },
    };

    const send = (prepared: PreparedRequest) => runtime.execute(prepared, combined, streamHooks);
    try {
        let response = await send(built.prepared);
        const provider = getAuthProvider(built.resolvedAuth);
        if (provider.handleChallenge) {
            const authContext = { resolve: (text: string) => text, now: context.now ?? Date.now };
            const retry = await provider.handleChallenge(
                built.resolvedAuth,
                built.prepared,
                response,
                authContext,
            );
            if (retry) response = await send(retry);
        }
        await context.scripts?.postResponse?.(response, request);
        return { response, built };
    } catch (error) {
        if (
            timeout?.signal.aborted &&
            !signal?.aborted &&
            (isAbort(error) || (error as Error)?.name === 'TimeoutError')
        ) {
            throw new AppError(
                'CONNECTION_TIMEOUT',
                `No response within ${timeoutMs} ms (request timeout).`,
                {
                    cause: error,
                },
            );
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
};
