/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconPlus, IconSend, IconTrash } from '@tabler/icons-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createVariableResolver } from '@httpreq/api-client';
import {
    createMqttConfig,
    createMqttSubscription,
    isMqttQos,
    MQTT_PAYLOAD_FORMATS,
    MQTT_PROTOCOL_VERSIONS,
    MQTT_VERSION_LABELS,
    validatePublishTopic,
    validateTopicFilter,
    type HttpRequest,
    type MqttConfig,
    type MqttMessage,
    type MqttQos,
    type MqttSubscription,
} from '@httpreq/shared';
import { useCapabilities } from '../capabilities';
import { emptyMqtt, useConnectionsStore } from '../connections';
import { CodeEditor } from '../editor/CodeEditor';
import { activeEnvironment, useWorkbenchStore } from '../store';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    NumberInput,
    SegmentedControl,
    Select,
    Stack,
    StatusDot,
    Switch,
    Text,
    TextInput,
    Textarea,
    cx,
} from '../kit';
import { useMqttApi } from './useMqtt';

const STATUS_LABEL = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnecting: 'Disconnecting…',
    error: 'Error',
} as const;

const QOS_OPTIONS = [
    { value: '0', label: 'QoS 0 – at most once' },
    { value: '1', label: 'QoS 1 – at least once' },
    { value: '2', label: 'QoS 2 – exactly once' },
];

const SECTION_LABEL = 'text-xs font-semibold tracking-wide text-dimmed uppercase';

const toQos = (value: string | null): MqttQos => {
    const parsed = Number(value);
    return isMqttQos(parsed) ? parsed : 0;
};

const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? timestamp
        : date.toLocaleTimeString(undefined, { hour12: false });
};

const MessageRow = memo(function MessageRow({ message }: { message: MqttMessage }) {
    const arrow = message.direction === 'sent' ? '↑' : message.direction === 'received' ? '↓' : '•';
    return (
        <div
            className="grid grid-cols-[16px_1fr_auto] gap-2 border-b border-line px-2.5 py-1 text-xs last:border-b-0 data-[direction=sent]:bg-info-soft data-[error=true]:bg-danger-soft"
            data-direction={message.direction}
            data-error={message.error ? 'true' : undefined}
        >
            <span aria-hidden>{arrow}</span>
            <div className="min-w-0">
                {message.topic && (
                    <div className="flex flex-wrap items-center gap-1">
                        <span className="font-mono font-semibold break-all">{message.topic}</span>
                        <Badge size="xs" variant="light" color="gray">
                            QoS {message.qos}
                        </Badge>
                        {message.retain && (
                            <Badge size="xs" variant="light" color="violet">
                                retained
                            </Badge>
                        )}
                        {message.encoding === 'hex' && (
                            <Badge size="xs" variant="light" color="gray">
                                hex
                            </Badge>
                        )}
                    </div>
                )}
                <pre className="m-0 font-mono break-words whitespace-pre-wrap">
                    {message.payload}
                </pre>
            </div>
            <span className="text-dimmed">{formatTime(message.timestamp)}</span>
        </div>
    );
});

type View = 'messages' | 'subscriptions' | 'connection' | 'tls';

interface Props {
    request: HttpRequest;
    onChange: (patch: Partial<HttpRequest>) => void;
}

/**
 * The MQTT session UI: connection state, publish, subscriptions, the message log and the
 * connection and TLS settings. Every control that needs a live connection is driven by the state
 * the broker session reports, so none of them is enabled before it can work.
 */
export function MqttPanel({ request, onChange }: Props) {
    const config = request.mqtt ?? createMqttConfig();
    const api = useMqttApi();
    const capabilities = useCapabilities();
    const state = useConnectionsStore((s) => s.mqtt[request.id]) ?? emptyMqtt();
    const workspace = useWorkbenchStore((s) => s.workspace);
    const [view, setView] = useState<View>('messages');
    const log = useRef<HTMLDivElement>(null);

    const connected = state.status === 'connected';
    const secureUrl = /^(mqtts|ssl|tls|wss):/i.test(request.url.trim());

    const patchMqtt = (patch: Partial<MqttConfig>) => onChange({ mqtt: { ...config, ...patch } });
    const patchTls = (patch: Partial<MqttConfig['tls']>) =>
        patchMqtt({ tls: { ...config.tls, ...patch } });
    const patchWill = (patch: Partial<MqttConfig['will']>) =>
        patchMqtt({ will: { ...config.will, ...patch } });

    const resolve = useMemo(
        () => createVariableResolver(activeEnvironment(workspace)).resolve,
        [workspace],
    );

    // Keep the newest message in view, unless the user has scrolled up to read.
    useEffect(() => {
        const element = log.current;
        if (!element) return;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        if (nearBottom) element.scrollTop = element.scrollHeight;
    }, [state.messages.length]);

    const topicProblem = config.publishTopic
        ? validatePublishTopic(resolve(config.publishTopic))
        : null;

    const updateSubscription = (id: string, patch: Partial<MqttSubscription>) =>
        patchMqtt({
            subscriptions: config.subscriptions.map((item) =>
                item.id === id ? { ...item, ...patch } : item,
            ),
        });

    return (
        <Stack gap="sm" className="min-h-0 flex-1">
            {!capabilities.mqtt && (
                <Alert color="yellow" variant="light" className="p-2">
                    <Text size="xs">
                        MQTT connections run in the HttpReq desktop app; a browser cannot open raw
                        broker connections. You can still edit this request here.
                    </Text>
                </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <StatusDot status={state.status} />
                <Text size="sm" aria-live="polite" className="font-medium">
                    {STATUS_LABEL[state.status]}
                </Text>
                {connected && state.connectedAt && (
                    <Text size="xs" className="text-dimmed">
                        since {formatTime(state.connectedAt)}
                    </Text>
                )}
                <SegmentedControl
                    size="xs"
                    aria-label="MQTT section"
                    value={view}
                    onChange={(value) => setView(value as View)}
                    className="ml-auto"
                    data={[
                        { value: 'messages', label: 'Messages' },
                        { value: 'subscriptions', label: 'Subscriptions' },
                        { value: 'connection', label: 'Connection' },
                        { value: 'tls', label: 'TLS' },
                    ]}
                />
            </div>
            {state.error && state.status !== 'connected' && (
                <Alert color="red" variant="light" className="p-2" role="alert">
                    <Text size="xs">{state.error}</Text>
                </Alert>
            )}

            {view === 'messages' && (
                <div className="flex min-h-0 flex-1 flex-col gap-3">
                    <div className="grid grid-cols-1 gap-2 @lg/request-editor:grid-cols-[1fr_auto_auto]">
                        <TextInput
                            size="xs"
                            label="Publish topic"
                            placeholder="sensors/temperature"
                            value={config.publishTopic}
                            error={topicProblem ?? undefined}
                            onChange={(event) =>
                                patchMqtt({ publishTopic: event.currentTarget.value })
                            }
                        />
                        <Select
                            size="xs"
                            label="QoS"
                            value={String(config.publishQos)}
                            data={QOS_OPTIONS}
                            onChange={(value) => patchMqtt({ publishQos: toQos(value) })}
                            className="w-[190px]"
                        />
                        <Select
                            size="xs"
                            label="Payload"
                            value={config.payloadFormat}
                            data={MQTT_PAYLOAD_FORMATS.map((format) => ({
                                value: format,
                                label: format === 'hex' ? 'Binary (hex)' : format.toUpperCase(),
                            }))}
                            onChange={(value) =>
                                value &&
                                patchMqtt({ payloadFormat: value as MqttConfig['payloadFormat'] })
                            }
                            className="w-[140px]"
                        />
                    </div>
                    <CodeEditor
                        className="h-28 flex-none"
                        language={config.payloadFormat === 'json' ? 'json' : 'plaintext'}
                        ariaLabel="MQTT payload"
                        value={request.body.text}
                        onChange={(text) =>
                            onChange({ body: { ...request.body, mode: 'text', text } })
                        }
                    />
                    <div className="flex flex-wrap items-center gap-3">
                        <Switch
                            label="Retain"
                            checked={config.publishRetain}
                            onChange={(event) =>
                                patchMqtt({ publishRetain: event.currentTarget.checked })
                            }
                        />
                        <Button
                            size="xs"
                            leftSection={<IconSend size={14} />}
                            disabled={!connected || !config.publishTopic.trim() || !!topicProblem}
                            onClick={() => void api.publish(request)}
                        >
                            Publish
                        </Button>
                        <Button
                            size="xs"
                            variant="subtle"
                            color="gray"
                            className="ml-auto"
                            disabled={state.messages.length === 0}
                            onClick={() => api.clear(request.id)}
                        >
                            Clear log
                        </Button>
                    </div>
                    <div
                        ref={log}
                        role="log"
                        aria-label="MQTT messages"
                        className="min-h-24 flex-1 overflow-auto border border-line"
                    >
                        {state.messages.length === 0 ? (
                            <Text size="xs" className="text-dimmed p-3">
                                {connected
                                    ? 'No messages yet. Subscribe to a topic, or publish one.'
                                    : 'Connect to a broker to publish and receive messages.'}
                            </Text>
                        ) : (
                            state.messages.map((message) => (
                                <MessageRow key={message.id} message={message} />
                            ))
                        )}
                    </div>
                </div>
            )}

            {view === 'subscriptions' && (
                <Stack gap="xs" className="max-w-[760px]">
                    <Text size="xs" className="text-dimmed">
                        Enabled subscriptions are made when the connection opens. While connected,
                        use Subscribe or Unsubscribe to change one immediately.
                    </Text>
                    {config.subscriptions.map((subscription) => {
                        const resolved = resolve(subscription.topic.trim());
                        const problem = subscription.topic ? validateTopicFilter(resolved) : null;
                        const active = resolved in state.subscriptions;
                        return (
                            <div key={subscription.id} className="flex flex-wrap items-start gap-2">
                                <TextInput
                                    size="xs"
                                    aria-label="Topic filter"
                                    placeholder="sensors/+/temperature"
                                    value={subscription.topic}
                                    error={problem ?? undefined}
                                    onChange={(event) =>
                                        updateSubscription(subscription.id, {
                                            topic: event.currentTarget.value,
                                        })
                                    }
                                    className="min-w-[200px] flex-1"
                                />
                                <Select
                                    size="xs"
                                    aria-label="Subscription QoS"
                                    value={String(subscription.qos)}
                                    data={QOS_OPTIONS}
                                    onChange={(value) =>
                                        updateSubscription(subscription.id, { qos: toQos(value) })
                                    }
                                    className="w-[190px]"
                                />
                                <Switch
                                    aria-label="Subscribe on connect"
                                    checked={subscription.enabled}
                                    onChange={(event) =>
                                        updateSubscription(subscription.id, {
                                            enabled: event.currentTarget.checked,
                                        })
                                    }
                                />
                                {connected && (
                                    <Button
                                        size="xs"
                                        variant="default"
                                        disabled={!subscription.topic.trim() || !!problem}
                                        onClick={() =>
                                            void (active
                                                ? api.unsubscribe(request.id, [resolved])
                                                : api.subscribe(request.id, [
                                                      { topic: resolved, qos: subscription.qos },
                                                  ]))
                                        }
                                    >
                                        {active ? 'Unsubscribe' : 'Subscribe'}
                                    </Button>
                                )}
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    aria-label="Remove subscription"
                                    onClick={() =>
                                        patchMqtt({
                                            subscriptions: config.subscriptions.filter(
                                                (item) => item.id !== subscription.id,
                                            ),
                                        })
                                    }
                                >
                                    <IconTrash size={14} />
                                </ActionIcon>
                            </div>
                        );
                    })}
                    <Button
                        size="xs"
                        variant="subtle"
                        className="self-start"
                        leftSection={<IconPlus size={14} />}
                        onClick={() =>
                            patchMqtt({
                                subscriptions: [...config.subscriptions, createMqttSubscription()],
                            })
                        }
                    >
                        Add subscription
                    </Button>
                </Stack>
            )}

            {view === 'connection' && (
                <Stack gap="sm" className="max-w-[760px]">
                    <div className="grid grid-cols-1 gap-3 @lg/request-editor:grid-cols-2">
                        <TextInput
                            size="xs"
                            label="Client ID"
                            description="Empty generates a unique one for each connection."
                            value={config.clientId}
                            onChange={(event) => patchMqtt({ clientId: event.currentTarget.value })}
                        />
                        <Select
                            size="xs"
                            label="Protocol version"
                            value={String(config.protocolVersion)}
                            data={MQTT_PROTOCOL_VERSIONS.map((version) => ({
                                value: String(version),
                                label: MQTT_VERSION_LABELS[version],
                            }))}
                            onChange={(value) =>
                                patchMqtt({
                                    protocolVersion: Number(value) as MqttConfig['protocolVersion'],
                                })
                            }
                        />
                        <NumberInput
                            size="xs"
                            label="Keep alive"
                            min={0}
                            suffix=" s"
                            value={config.keepAliveSeconds}
                            onChange={(v) =>
                                patchMqtt({ keepAliveSeconds: typeof v === 'number' ? v : 0 })
                            }
                        />
                        <NumberInput
                            size="xs"
                            label="Connect timeout"
                            min={0}
                            step={1000}
                            suffix=" ms"
                            value={config.connectTimeoutMs}
                            onChange={(v) =>
                                patchMqtt({ connectTimeoutMs: typeof v === 'number' ? v : 0 })
                            }
                        />
                        <NumberInput
                            size="xs"
                            label="Reconnect every"
                            description="0 does not reconnect."
                            min={0}
                            step={1000}
                            suffix=" ms"
                            value={config.reconnectPeriodMs}
                            onChange={(v) =>
                                patchMqtt({ reconnectPeriodMs: typeof v === 'number' ? v : 0 })
                            }
                        />
                        <NumberInput
                            size="xs"
                            label="Messages kept"
                            min={1}
                            value={config.messageLimit}
                            onChange={(v) =>
                                patchMqtt({ messageLimit: typeof v === 'number' ? v : 500 })
                            }
                        />
                    </div>
                    <Switch
                        label={config.protocolVersion === 5 ? 'Clean start' : 'Clean session'}
                        checked={config.cleanSession}
                        onChange={(event) =>
                            patchMqtt({ cleanSession: event.currentTarget.checked })
                        }
                    />
                    <div>
                        <Text className={SECTION_LABEL}>Last will</Text>
                        <Switch
                            label="Publish a message if the client disconnects unexpectedly"
                            checked={config.will.enabled}
                            onChange={(event) =>
                                patchWill({ enabled: event.currentTarget.checked })
                            }
                        />
                        {config.will.enabled && (
                            <div className="mt-2 grid grid-cols-1 gap-2 @lg/request-editor:grid-cols-2">
                                <TextInput
                                    size="xs"
                                    label="Will topic"
                                    value={config.will.topic}
                                    onChange={(event) =>
                                        patchWill({ topic: event.currentTarget.value })
                                    }
                                />
                                <Select
                                    size="xs"
                                    label="Will QoS"
                                    value={String(config.will.qos)}
                                    data={QOS_OPTIONS}
                                    onChange={(value) => patchWill({ qos: toQos(value) })}
                                />
                                <TextInput
                                    size="xs"
                                    label="Will payload"
                                    value={config.will.payload}
                                    onChange={(event) =>
                                        patchWill({ payload: event.currentTarget.value })
                                    }
                                />
                                <Switch
                                    label="Retain will"
                                    checked={config.will.retain}
                                    onChange={(event) =>
                                        patchWill({ retain: event.currentTarget.checked })
                                    }
                                />
                            </div>
                        )}
                    </div>
                    <Text size="xs" className="text-dimmed">
                        The broker user name and password come from the Authorization tab (Basic, or
                        Bearer for token-based brokers).
                    </Text>
                </Stack>
            )}

            {view === 'tls' && (
                <Stack gap="sm" className="max-w-[760px]">
                    {!secureUrl && (
                        <Alert color="gray" variant="light" className="p-2">
                            <Text size="xs">
                                TLS applies to mqtts:// and wss:// brokers. This URL is not one, so
                                these settings are not used.
                            </Text>
                        </Alert>
                    )}
                    <Switch
                        label="Verify the broker’s certificate"
                        description="Turn off only for development brokers with self-signed certificates."
                        checked={config.tls.verifyCertificate}
                        onChange={(event) =>
                            patchTls({ verifyCertificate: event.currentTarget.checked })
                        }
                    />
                    <Textarea
                        size="xs"
                        label="CA certificate (PEM)"
                        description="Trusted in addition to the system roots, e.g. a private CA."
                        minRows={3}
                        className="font-mono"
                        value={config.tls.caCertificate}
                        onChange={(event) => patchTls({ caCertificate: event.currentTarget.value })}
                    />
                    <Textarea
                        size="xs"
                        label="Client certificate (PEM)"
                        description="For brokers that require mutual TLS."
                        minRows={3}
                        className="font-mono"
                        value={config.tls.clientCertificate}
                        onChange={(event) =>
                            patchTls({ clientCertificate: event.currentTarget.value })
                        }
                    />
                    <Textarea
                        size="xs"
                        label="Client private key (PEM)"
                        description="Kept in memory for this session only; it is never saved, exported or shown in generated code."
                        minRows={3}
                        className={cx('font-mono')}
                        value={config.tls.clientKey}
                        onChange={(event) => patchTls({ clientKey: event.currentTarget.value })}
                    />
                </Stack>
            )}
        </Stack>
    );
}
