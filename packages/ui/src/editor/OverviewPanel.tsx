/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { authProviders, type EffectiveAuth } from '@httpreq/api-client';
import type { HistoryEntry, HttpRequest } from '@httpreq/shared';
import { methodText } from '../methods';
import { Badge, cx, SimpleGrid, Stack, Text, Textarea } from '../kit';

const BODY_LABELS: Record<HttpRequest['body']['mode'], string> = {
    none: 'None',
    json: 'JSON',
    text: 'Text',
    'form-urlencoded': 'Form URL Encoded',
    multipart: 'Multipart Form',
    binary: 'Binary file',
};

interface Props {
    request: HttpRequest;
    location: string;
    environmentName: string | null;
    effectiveAuth: EffectiveAuth;
    lastRun?: HistoryEntry;
    paramCount: number;
    headerCount: number;
    onChange: (patch: Partial<HttpRequest>) => void;
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0 rounded-sm border border-line px-2.5 py-2">
            <Text size="xs" className="text-dimmed">
                {label}
            </Text>
            <div className="mt-0.5 min-w-0">{children}</div>
        </div>
    );
}

/** A compact summary of the request, not a second editor. */
export function OverviewPanel({
    request,
    location,
    environmentName,
    effectiveAuth,
    lastRun,
    paramCount,
    headerCount,
    onChange,
}: Props) {
    const authLabel =
        request.auth.type === 'inherit'
            ? `${authProviders[effectiveAuth.auth.type].label} (inherited${
                  effectiveAuth.source.kind === 'none' ? '' : ` from ${effectiveAuth.source.name}`
              })`
            : authProviders[request.auth.type].label;

    return (
        <Stack gap="md" className="max-w-[820px]">
            <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} gap="sm">
                <Item label="Name">
                    <Text size="sm" className="font-semibold truncate">
                        {request.name}
                    </Text>
                </Item>
                <Item label="Method">
                    <Text size="sm" className={cx('font-bold', methodText[request.method])}>
                        {request.method}
                    </Text>
                </Item>
                <Item label="Location">
                    <Text size="sm" title={location} className="truncate">
                        {location}
                    </Text>
                </Item>
                <Item label="URL">
                    <Text size="sm" className="font-mono break-all">
                        {request.url || '—'}
                    </Text>
                </Item>
                <Item label="Environment">
                    <Text size="sm">{environmentName ?? 'No environment'}</Text>
                </Item>
                <Item label="Authorization">
                    <Text size="sm">{authLabel}</Text>
                </Item>
                <Item label="Query parameters">
                    <Text size="sm">{paramCount}</Text>
                </Item>
                <Item label="Headers">
                    <Text size="sm">{headerCount}</Text>
                </Item>
                <Item label="Body">
                    <Text size="sm">{BODY_LABELS[request.body.mode]}</Text>
                </Item>
                <Item label="Last sent">
                    <Text size="sm">
                        {lastRun ? new Date(lastRun.timestamp).toLocaleString() : 'Never'}
                    </Text>
                </Item>
                <Item label="Last response">
                    {lastRun ? (
                        lastRun.status !== null ? (
                            <Badge
                                variant="light"
                                radius="xs"
                                color={lastRun.status < 400 ? 'teal' : 'red'}
                            >
                                {lastRun.status} {lastRun.statusText} · {lastRun.durationMs} ms
                            </Badge>
                        ) : (
                            <Text
                                size="sm"
                                title={lastRun.error}
                                className="text-danger-text truncate"
                            >
                                Failed: {lastRun.error}
                            </Text>
                        )
                    ) : (
                        <Text size="sm">—</Text>
                    )}
                </Item>
            </SimpleGrid>
            <Textarea
                label="Description"
                placeholder="What this request does, expected inputs, notes for teammates…"
                value={request.description}
                onChange={(event) => onChange({ description: event.currentTarget.value })}
                autosize
                minRows={2}
                maxRows={8}
            />
        </Stack>
    );
}
