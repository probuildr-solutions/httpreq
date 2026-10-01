/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    createMqttConfig,
    protocolOf,
    SECRET_PLACEHOLDER,
    type CodegenBody,
    type CodegenHeader,
    type CodegenRequest,
    type GrpcCodegenRequest,
    type HttpCodegenRequest,
    type HttpRequest,
    type MqttCodegenRequest,
    type PreparedBody,
} from '@httpreq/shared';
import {
    buildGrpcCall,
    buildMqttConnection,
    buildMqttPublish,
    buildRequest,
    createVariableResolver,
    getAuthProvider,
    resolveEffectiveAuth,
    type PipelineContext,
} from '@httpreq/api-client';
import {
    emptyRules,
    redactBody,
    redactHeader,
    redactUrl,
    replaceSecretValues,
    type SecretRules,
} from './redact';

/**
 * Turns a saved request into the resolved, protocol-neutral description generators consume, by
 * running the same builders a real send uses. That is what guarantees the generated code matches
 * what the app would send: there is no second implementation of variable resolution,
 * authorization or SOAP envelopes here.
 *
 * No scripts run (generating code has no side effects) and files are referenced by name.
 */

export interface CodegenBuildOptions {
    includeSecrets: boolean;
}

/** Every secret the request can contribute, so it can be found wherever it ends up. */
export const secretRulesFor = (request: HttpRequest, context: PipelineContext): SecretRules => {
    const rules = emptyRules();
    const resolver = createVariableResolver(context.environment, context.resolverOptions);
    const effective = resolveEffectiveAuth(context.workspace, request);
    const provider = getAuthProvider(effective.auth);
    const resolved = provider.resolve(effective.auth, {
        resolve: resolver.resolve,
        now: context.now ?? Date.now,
    }) as unknown as Record<string, unknown>;

    for (const field of provider.secretFields) {
        const value = resolved[field];
        if (typeof value === 'string' && value) rules.values.push(value);
    }
    provider
        .appliedHeaders(effective.auth)
        .forEach((name) => rules.headerNames.add(name.toLowerCase()));
    const { auth } = effective;
    if (auth.type === 'api-key' && auth.location === 'query') {
        rules.queryNames.add(resolver.resolve(auth.key));
    }
    if (auth.type === 'jwt' && auth.addTo === 'query') rules.queryNames.add(auth.queryParamKey);

    for (const variable of context.environment?.variables ?? []) {
        if (variable.secret && variable.enabled && variable.value)
            rules.values.push(variable.value);
    }
    for (const header of request.headers) {
        if (header.secret && header.enabled && header.key.trim()) {
            rules.headerNames.add(resolver.resolve(header.key.trim()).toLowerCase());
            if (header.value) rules.values.push(resolver.resolve(header.value));
        }
    }
    return rules;
};

const fromPreparedBody = (
    body: PreparedBody | undefined,
    request: HttpRequest,
    headers: CodegenHeader[],
): CodegenBody => {
    if (!body) return { kind: 'none' };
    if (body.kind === 'bytes') {
        return { kind: 'file', fileName: request.body.binary?.name ?? 'file' };
    }
    if (body.kind === 'multipart') {
        return {
            kind: 'multipart',
            parts: body.parts.map((part) =>
                'bytes' in part
                    ? { name: part.name, fileName: part.fileName }
                    : { name: part.name, value: part.value },
            ),
        };
    }
    const contentType =
        headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? '';
    if (/^application\/x-www-form-urlencoded/i.test(contentType)) {
        const fields = [...new URLSearchParams(body.text)].map(([name, value]) => ({
            name,
            value,
        }));
        return { kind: 'form', fields };
    }
    return { kind: 'text', text: body.text };
};

const buildHttp = async (
    request: HttpRequest,
    context: PipelineContext,
    includeSecrets: boolean,
): Promise<HttpCodegenRequest> => {
    const built = await buildRequest(request, {
        ...context,
        scripts: undefined,
        // Files are not read for code generation; their names are enough.
        readFile: async () => new Uint8Array(),
    });
    const { prepared } = built;
    const rules = includeSecrets ? null : secretRulesFor(request, context);
    let headers: CodegenHeader[] = Object.entries(prepared.headers).map(([name, value]) => ({
        name,
        value,
    }));
    let body = fromPreparedBody(prepared.body, request, headers);
    let url = prepared.url;
    if (rules) {
        headers = headers.map((header) => redactHeader(header, rules));
        body = redactBody(body, rules);
        url = redactUrl(url, rules);
    }
    return {
        protocol: protocolOf(request) === 'soap' ? 'soap' : 'http',
        method: prepared.method,
        url,
        headers,
        body,
        followRedirects: prepared.options.followRedirects,
        verifyTls: prepared.options.verifyTls,
        timeoutMs: request.settings.timeoutMs,
    };
};

const buildGrpc = async (
    request: HttpRequest,
    context: PipelineContext,
    includeSecrets: boolean,
): Promise<GrpcCodegenRequest> => {
    const { prepared, serverStreaming } = await buildGrpcCall(request, {
        ...context,
        scripts: undefined,
    });
    const rules = includeSecrets ? null : secretRulesFor(request, context);
    const metadata = Object.entries(prepared.metadata).map(([name, value]) => {
        const header = { name, value };
        return rules ? redactHeader(header, rules) : header;
    });
    return {
        protocol: 'grpc',
        target: prepared.target,
        tls: prepared.tls,
        verifyTls: prepared.verifyTls,
        protoFiles: prepared.protoFiles,
        service: prepared.service,
        method: prepared.method,
        clientStreaming: false,
        serverStreaming,
        message: rules ? replaceSecretValues(prepared.message, rules.values) : prepared.message,
        metadata,
        deadlineMs: prepared.deadlineMs,
    };
};

const buildMqtt = async (
    request: HttpRequest,
    context: PipelineContext,
    includeSecrets: boolean,
): Promise<MqttCodegenRequest> => {
    const { prepared, subscriptions } = await buildMqttConnection(request, context);
    let publish: MqttCodegenRequest['publish'] = null;
    if ((request.mqtt ?? createMqttConfig()).publishTopic.trim()) {
        publish = buildMqttPublish(request, context);
    }
    const rules = includeSecrets ? null : secretRulesFor(request, context);
    if (rules && publish)
        publish = { ...publish, payload: replaceSecretValues(publish.payload, rules.values) };
    return {
        protocol: 'mqtt',
        url: prepared.url,
        clientId: prepared.clientId,
        username: prepared.username,
        password: !includeSecrets && prepared.password ? SECRET_PLACEHOLDER : prepared.password,
        protocolVersion: prepared.protocolVersion,
        keepAliveSeconds: prepared.keepAliveSeconds,
        cleanSession: prepared.cleanSession,
        verifyTls: prepared.tls.verifyCertificate,
        // PEM contents never go into generated code; the code reads files the user provides.
        caCertificateFile: prepared.tls.caCertificate ? 'ca.pem' : '',
        clientCertificateFile: prepared.tls.clientCertificate ? 'client.crt' : '',
        clientKeyFile: prepared.tls.clientKey ? 'client.key' : '',
        subscriptions,
        publish,
    };
};

export const buildCodegenRequest = async (
    request: HttpRequest,
    context: PipelineContext,
    options: CodegenBuildOptions = { includeSecrets: false },
): Promise<CodegenRequest> => {
    switch (protocolOf(request)) {
        case 'grpc':
            return buildGrpc(request, context, options.includeSecrets);
        case 'mqtt':
            return buildMqtt(request, context, options.includeSecrets);
        default:
            return buildHttp(request, context, options.includeSecrets);
    }
};

/** The message to show when a request cannot be turned into code (a missing URL, a bad proto). */
export const codegenFailureReason = (error: unknown): string =>
    error instanceof AppError ? error.message : 'The request could not be prepared.';
