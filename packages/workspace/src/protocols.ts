/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    createGrpcConfig,
    createId,
    createMqttConfig,
    createSoapConfig,
    isMqttQos,
    isProtocolId,
    isSoapVersion,
    MQTT_PAYLOAD_FORMATS,
    MQTT_PROTOCOL_VERSIONS,
    type GrpcConfig,
    type HttpRequest,
    type MqttConfig,
    type MqttPayloadFormat,
    type MqttProtocolVersion,
    type MqttQos,
    type ProtoFile,
    type SoapConfig,
} from '@httpreq/shared';

/**
 * Normalization of the protocol-specific parts of a stored or imported request. Like the rest of
 * the workspace normalizer it never trusts its input: unknown fields are dropped, wrong types fall
 * back to defaults, and sizes are bounded so a hostile file cannot make the editors choke.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object';
const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const list = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);

/** Largest stored text per field (WSDL, proto, certificate): 2 MB. */
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_PROTO_FILES = 50;
const MAX_SUBSCRIPTIONS = 200;

const bounded = (value: unknown) => {
    const text = str(value);
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
};

const oneOf = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;

export const normalizeSoap = (value: unknown): SoapConfig => {
    const defaults = createSoapConfig();
    if (!isObject(value)) return defaults;
    return {
        version: isSoapVersion(value.version) ? value.version : defaults.version,
        action: str(value.action),
        headerXml: bounded(value.headerXml),
        wsdlUrl: str(value.wsdlUrl),
        wsdl: bounded(value.wsdl),
        operation: str(value.operation),
    };
};

export const normalizeGrpc = (value: unknown): GrpcConfig => {
    const defaults = createGrpcConfig();
    if (!isObject(value)) return defaults;
    const protoFiles: ProtoFile[] = list(value.protoFiles)
        .slice(0, MAX_PROTO_FILES)
        .map((file) => ({
            name: str(file.name).trim() || 'service.proto',
            content: bounded(file.content),
        }));
    return {
        protoFiles,
        service: str(value.service),
        method: str(value.method),
        deadlineMs: num(value.deadlineMs, defaults.deadlineMs),
    };
};

export const normalizeMqtt = (value: unknown): MqttConfig => {
    const defaults = createMqttConfig();
    if (!isObject(value)) return defaults;
    const tls = isObject(value.tls) ? value.tls : {};
    const will = isObject(value.will) ? value.will : {};
    const qos = (candidate: unknown): MqttQos => (isMqttQos(candidate) ? candidate : 0);
    return {
        clientId: str(value.clientId),
        protocolVersion: oneOf<MqttProtocolVersion>(
            value.protocolVersion,
            MQTT_PROTOCOL_VERSIONS,
            defaults.protocolVersion,
        ),
        keepAliveSeconds: num(value.keepAliveSeconds, defaults.keepAliveSeconds),
        cleanSession: bool(value.cleanSession, defaults.cleanSession),
        connectTimeoutMs: num(value.connectTimeoutMs, defaults.connectTimeoutMs),
        reconnectPeriodMs: num(value.reconnectPeriodMs, defaults.reconnectPeriodMs),
        tls: {
            verifyCertificate: bool(tls.verifyCertificate, true),
            caCertificate: bounded(tls.caCertificate),
            clientCertificate: bounded(tls.clientCertificate),
            // A key is never read back from storage or an import; it is entered per session.
            clientKey: '',
        },
        will: {
            enabled: bool(will.enabled, false),
            topic: str(will.topic),
            payload: str(will.payload),
            qos: qos(will.qos),
            retain: bool(will.retain, false),
        },
        subscriptions: list(value.subscriptions)
            .slice(0, MAX_SUBSCRIPTIONS)
            .map((item) => ({
                id: typeof item.id === 'string' && item.id ? item.id : createId(),
                topic: str(item.topic),
                qos: qos(item.qos),
                enabled: bool(item.enabled, true),
            })),
        publishTopic: str(value.publishTopic),
        publishQos: qos(value.publishQos),
        publishRetain: bool(value.publishRetain, false),
        payloadFormat: oneOf<MqttPayloadFormat>(
            value.payloadFormat,
            MQTT_PAYLOAD_FORMATS,
            defaults.payloadFormat,
        ),
        messageLimit: Math.min(5000, Math.max(1, num(value.messageLimit, defaults.messageLimit))),
    };
};

/** The protocol fields of a request: nothing at all for HTTP, so its stored shape is unchanged. */
export const normalizeProtocolFields = (
    value: Json,
): Pick<HttpRequest, 'protocol' | 'soap' | 'grpc' | 'mqtt'> => {
    if (!isProtocolId(value.protocol) || value.protocol === 'http') return {};
    switch (value.protocol) {
        case 'soap':
            return { protocol: 'soap', soap: normalizeSoap(value.soap) };
        case 'grpc':
            return { protocol: 'grpc', grpc: normalizeGrpc(value.grpc) };
        case 'mqtt':
            return { protocol: 'mqtt', mqtt: normalizeMqtt(value.mqtt) };
    }
};
