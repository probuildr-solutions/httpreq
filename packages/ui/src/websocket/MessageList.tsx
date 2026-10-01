/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconPlugConnected, IconTrash } from '@tabler/icons-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { WebSocketMessage, WebSocketStatus } from '@httpreq/shared';
import { formatSize } from '../format';
import { PaneHeader } from '../WorkbenchSplit';
import {
    ActionIcon,
    Badge,
    Group,
    Loader,
    Stack,
    Text,
    ThemeIcon,
    Tooltip,
    VisuallyHidden,
} from '../kit';

const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? timestamp
        : `${date.toLocaleTimeString(undefined, { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};

const ARROW: Record<WebSocketMessage['direction'], string> = {
    sent: '↑',
    received: '↓',
    system: '•',
};

const LABEL: Record<WebSocketMessage['direction'], string> = {
    sent: 'Sent',
    received: 'Received',
    system: 'Connection',
};

interface Props {
    messages: readonly WebSocketMessage[];
    /** Drives the empty state, which says why there is nothing to read yet. */
    status: WebSocketStatus;
    onClear: () => void;
}

/**
 * One logged frame. Memoized so a new message renders one row, not the whole log again: a chatty
 * socket delivers many messages a second into a log of up to several hundred.
 */
const MessageRow = memo(function MessageRow({ message }: { message: WebSocketMessage }) {
    return (
        <div
            className="group/message grid grid-cols-[18px_1fr_auto] items-start gap-2 border-b border-line px-2.5 py-[5px] last:border-b-0 data-[direction=sent]:bg-info-soft data-[direction=system]:bg-gray-0 dark:data-[direction=system]:bg-white/[0.03] data-[error=true]:bg-danger-soft"
            data-direction={message.direction}
            data-error={message.error ? 'true' : undefined}
        >
            <span
                className="text-center font-mono text-[13px] leading-normal group-data-[direction=sent]/message:text-info-text group-data-[direction=received]/message:text-success-text"
                aria-hidden
            >
                {ARROW[message.direction]}
            </span>
            <pre className="m-0 max-h-[14em] overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
                <VisuallyHidden>{LABEL[message.direction]}: </VisuallyHidden>
                {message.data}
            </pre>
            <span className="flex flex-col items-end gap-0.5 text-[10px] whitespace-nowrap text-dimmed tabular-nums">
                <span>{formatTime(message.timestamp)}</span>
                {message.direction !== 'system' && (
                    <span>
                        {message.payloadType.toUpperCase()} · {formatSize(message.sizeBytes)}
                    </span>
                )}
            </span>
        </div>
    );
});

/**
 * The connection's message history, oldest first. It follows new messages automatically, but
 * stops doing so as soon as the user scrolls up to read something, and resumes at the bottom.
 */
export const MessageList = memo(function MessageList({ messages, status, onClear }: Props) {
    const viewport = useRef<HTMLDivElement>(null);
    const [follow, setFollow] = useState(true);

    useEffect(() => {
        if (!follow) return;
        const element = viewport.current;
        if (element) element.scrollTop = element.scrollHeight;
    }, [messages, follow]);

    const onScroll = () => {
        const element = viewport.current;
        if (!element) return;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        setFollow(atBottom);
    };

    const frames = messages.filter((message) => message.direction !== 'system').length;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PaneHeader aria-label="Message log">
                <Group gap="xs">
                    <Text size="xs" className="font-semibold">
                        Messages
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                        {frames}
                    </Badge>
                    {!follow && (
                        <Text size="xs" className="text-dimmed">
                            Paused — scroll to the bottom to follow
                        </Text>
                    )}
                </Group>
                <Tooltip label="Clear messages">
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label="Clear messages"
                        disabled={messages.length === 0}
                        onClick={onClear}
                    >
                        <IconTrash size={14} />
                    </ActionIcon>
                </Tooltip>
            </PaneHeader>

            <div
                ref={viewport}
                className="min-h-0 flex-1 overflow-auto py-1"
                onScroll={onScroll}
                role="log"
                aria-label="WebSocket messages"
                aria-live="polite"
                tabIndex={0}
            >
                {messages.length === 0 ? (
                    // The same shape as the HTTP response panel's empty state, so both kinds of request
                    // read the same way before anything has arrived.
                    <div className="flex h-full items-center justify-center px-3 py-6">
                        <Stack align="center" gap="xs">
                            <ThemeIcon variant="light" size={44} round>
                                {status === 'connecting' ? (
                                    <Loader size="sm" />
                                ) : (
                                    <IconPlugConnected size={22} />
                                )}
                            </ThemeIcon>
                            <Text className="font-semibold">
                                {status === 'connecting'
                                    ? 'Connecting…'
                                    : status === 'connected'
                                      ? 'Connected — no messages yet'
                                      : 'Messages will appear here'}
                            </Text>
                            <Text size="sm" className="text-dimmed">
                                {status === 'connected'
                                    ? 'Send a message, or wait for the server to push one.'
                                    : 'Enter a URL and select Connect.'}
                            </Text>
                        </Stack>
                    </div>
                ) : (
                    messages.map((message) => <MessageRow key={message.id} message={message} />)
                )}
            </div>
        </div>
    );
});
