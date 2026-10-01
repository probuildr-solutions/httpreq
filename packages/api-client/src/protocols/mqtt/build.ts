/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    createId,
    createMqttConfig,
    validatePublishTopic,
    validateTopicFilter,
    type HttpRequest,
    type MqttPublishInput,
    type MqttQos,
    type PreparedMqttConnection,
} from '@httpreq/shared';
import { getAuthProvider, resolveEffectiveAuth } from '../../auth/registry';
import type { AuthContext } from '../../auth/types';
import type { PipelineContext } from '../../pipeline';
import { createVariableResolver } from '../../variables';
import { parseProtocolUrl } from '../common';

export const MQTT_SCHEMES = ['mqtt', 'mqtts', 'tcp', 'ssl', 'tls', 'ws', 'wss'] as const;
const SECURE_SCHEMES = new Set(['mqtts', 'ssl', 'tls', 'wss']);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface BuiltMqtt {
    prepared: PreparedMqttConnection;
    subscriptions: { topic: string; qos: MqttQos }[];
    warnings: string[];
}

/**
 * Builds a broker connection from a saved request. The broker credentials come from the
 * request's (possibly inherited) authorization: Basic gives user name and password, Bearer gives
 * the token as the password. Any other scheme cannot be expressed in MQTT and is refused rather
 * than silently ignored.
 */
export const buildMqttConnection = async (
    request: HttpRequest,
    context: PipelineContext,
): Promise<BuiltMqtt> => {
    const config = request.mqtt ?? createMqttConfig();
    const warnings: string[] = [];
    const resolver = createVariableResolver(context.environment, context.resolverOptions);
    const authContext: AuthContext = { resolve: resolver.resolve, now: context.now ?? Date.now };

    let text = resolver.resolve(request.url.trim());
    if (text && !SCHEME.test(text) && !text.startsWith('{{')) text = `mqtt://${text}`;
    const url = parseProtocolUrl(
        text,
        resolver,
        context.environment,
        MQTT_SCHEMES,
        'MQTT broker',
        'mqtt://broker.example.com:1883',
    );
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    const secure = SECURE_SCHEMES.has(scheme);

    const effective = resolveEffectiveAuth(context.workspace, request);
    const provider = getAuthProvider(effective.auth);
    const blocking = provider
        .validate(effective.auth)
        .filter((issue) => issue.severity === 'error');
    if (blocking.length) {
        throw new AppError('AUTHENTICATION_ERROR', `${provider.label}: ${blocking[0]!.message}`);
    }
    const auth = provider.resolve(effective.auth, authContext);
    let username = '';
    let password = '';
    switch (auth.type) {
        case 'none':
            break;
        case 'basic':
            username = auth.username;
            password = auth.password;
            break;
        case 'bearer':
            password = auth.token;
            break;
        default:
            throw new AppError(
                'AUTHENTICATION_ERROR',
                `MQTT brokers take a user name and password, so ${provider.label} cannot be used. Choose Basic or Bearer.`,
            );
    }
    // Credentials in the URL would end up in logs and history; the authorization is the one place.
    if (url.username || url.password) {
        warnings.push('The user name and password in the URL were ignored; use Authorization.');
    }

    const subscriptions = config.subscriptions
        .filter((item) => item.enabled && item.topic.trim())
        .map((item) => ({ topic: resolver.resolve(item.topic.trim()), qos: item.qos }));
    for (const subscription of subscriptions) {
        const problem = validateTopicFilter(subscription.topic);
        if (problem)
            throw new AppError(
                'INVALID_REQUEST',
                `Subscription “${subscription.topic}”: ${problem}`,
            );
    }

    const will = config.will.enabled
        ? {
              ...config.will,
              topic: resolver.resolve(config.will.topic.trim()),
              payload: resolver.resolve(config.will.payload),
          }
        : null;
    if (will) {
        const problem = validatePublishTopic(will.topic);
        if (problem) throw new AppError('INVALID_REQUEST', `Last will: ${problem}`);
    }
    if (!secure && (config.tls.caCertificate || config.tls.clientCertificate)) {
        warnings.push('TLS certificates are ignored: the broker URL is not mqtts:// or wss://.');
    }
    if (secure && !config.tls.verifyCertificate) {
        warnings.push('Certificate verification is off for this broker connection.');
    }
    if (resolver.unresolved.size > 0) {
        warnings.push(
            `Not defined, used as written: ${[...resolver.unresolved].map((name) => `{{${name}}}`).join(', ')}.`,
        );
    }

    const port =
        url.port ||
        String(
            { mqtt: 1883, tcp: 1883, mqtts: 8883, ssl: 8883, tls: 8883, ws: 80, wss: 443 }[scheme],
        );
    const normalizedScheme = { tcp: 'mqtt', ssl: 'mqtts', tls: 'mqtts' }[scheme] ?? scheme;
    const path = scheme === 'ws' || scheme === 'wss' ? `${url.pathname}${url.search}` : '';
    return {
        prepared: {
            url: `${normalizedScheme}://${url.hostname}:${port}${path}`,
            clientId:
                resolver.resolve(config.clientId.trim()) || `httpreq-${createId().slice(0, 8)}`,
            username,
            password,
            protocolVersion: config.protocolVersion,
            keepAliveSeconds: config.keepAliveSeconds,
            cleanSession: config.cleanSession,
            connectTimeoutMs: config.connectTimeoutMs,
            reconnectPeriodMs: config.reconnectPeriodMs,
            tls: {
                verifyCertificate: config.tls.verifyCertificate,
                caCertificate: config.tls.caCertificate,
                clientCertificate: config.tls.clientCertificate,
                clientKey: config.tls.clientKey,
            },
            will,
        },
        subscriptions,
        warnings,
    };
};

/** The message the Publish action sends, with variables resolved and the payload validated. */
export const buildMqttPublish = (
    request: HttpRequest,
    context: PipelineContext,
): MqttPublishInput => {
    const config = request.mqtt ?? createMqttConfig();
    const resolver = createVariableResolver(context.environment, context.resolverOptions);
    const topic = resolver.resolve(config.publishTopic.trim());
    const problem = validatePublishTopic(topic);
    if (problem) throw new AppError('INVALID_REQUEST', problem);
    const payload = resolver.resolve(request.body.text);
    if (config.payloadFormat === 'json' && payload.trim()) {
        try {
            JSON.parse(payload);
        } catch (cause) {
            throw new AppError(
                'INVALID_REQUEST',
                `The JSON payload is not valid: ${(cause as Error).message}`,
                {
                    cause,
                },
            );
        }
    }
    if (config.payloadFormat === 'hex') {
        const digits = payload.replace(/[\s:]/g, '');
        if (digits.length % 2 !== 0 || /[^0-9a-f]/i.test(digits)) {
            throw new AppError(
                'INVALID_REQUEST',
                'Enter the payload as pairs of hexadecimal digits.',
            );
        }
    }
    return {
        topic,
        payload,
        format: config.payloadFormat,
        qos: config.publishQos,
        retain: config.publishRetain,
    };
};
