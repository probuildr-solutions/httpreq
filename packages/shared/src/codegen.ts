/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ProtocolId } from './protocols';
import type { MqttPublishInput, MqttSubscription, MqttProtocolVersion } from './mqtt';
import type { ProtoFile } from './grpc';

/**
 * Contracts of the Code Generation module. A generator never sees a saved request: it receives a
 * {@link CodegenRequest}, a fully resolved, protocol-neutral description of what to send, so
 * generators carry no knowledge of variables, authorization schemes or the workspace.
 */

export interface CodegenHeader {
    name: string;
    value: string;
}

export type CodegenBody =
    | { kind: 'none' }
    | { kind: 'text'; text: string }
    | { kind: 'form'; fields: { name: string; value: string }[] }
    | {
          kind: 'multipart';
          parts: ({ name: string; value: string } | { name: string; fileName: string })[];
      }
    | { kind: 'file'; fileName: string };

export interface HttpCodegenRequest {
    protocol: 'http' | 'soap';
    method: string;
    url: string;
    headers: CodegenHeader[];
    body: CodegenBody;
    followRedirects: boolean;
    verifyTls: boolean;
    timeoutMs: number;
}

export interface GrpcCodegenRequest {
    protocol: 'grpc';
    /** `host:port`. */
    target: string;
    tls: boolean;
    verifyTls: boolean;
    protoFiles: ProtoFile[];
    /** Fully qualified service name. */
    service: string;
    method: string;
    clientStreaming: boolean;
    serverStreaming: boolean;
    /** The request message as JSON text. */
    message: string;
    metadata: CodegenHeader[];
    deadlineMs: number;
}

export interface MqttCodegenRequest {
    protocol: 'mqtt';
    url: string;
    clientId: string;
    username: string;
    password: string;
    protocolVersion: MqttProtocolVersion;
    keepAliveSeconds: number;
    cleanSession: boolean;
    verifyTls: boolean;
    caCertificateFile: string;
    clientCertificateFile: string;
    clientKeyFile: string;
    subscriptions: Pick<MqttSubscription, 'topic' | 'qos'>[];
    /** Null when there is no publish topic yet: the generated code then only subscribes. */
    publish: MqttPublishInput | null;
}

export type CodegenRequest = HttpCodegenRequest | GrpcCodegenRequest | MqttCodegenRequest;

export interface CodegenOptions {
    /** Use real credentials in the output. Off by default: secrets become placeholders. */
    includeSecrets: boolean;
    /** Spaces per indentation level for languages where it is a style choice. */
    indent: number;
}

export const DEFAULT_CODEGEN_OPTIONS: CodegenOptions = { includeSecrets: false, indent: 4 };

/** One target (a language with a client library). Implementations are pure functions of input. */
export interface CodeGenerator<R extends CodegenRequest = CodegenRequest> {
    /** Stable id, e.g. `python-requests`. */
    readonly id: string;
    /** Shown in the selector, e.g. `Python – requests`. */
    readonly label: string;
    /** Grouping in the selector, e.g. `Python`. */
    readonly language: string;
    /** Monaco language id used for highlighting. */
    readonly editorLanguage: string;
    /** File extension without the dot, used when the code is saved to a file, e.g. `py`. */
    readonly fileExtension: string;
    /** Runtime or library version the output needs, shown beside the selector, e.g. `Java 15+`. */
    readonly requirements?: string;
    readonly protocols: readonly ProtocolId[];
    generate(request: R, options: CodegenOptions): string;
}

export type CodegenResult =
    { supported: true; code: string } | { supported: false; reason: string };

/** Placeholder text standing in for a secret in generated code. */
export const SECRET_PLACEHOLDER = '<SECRET>';
