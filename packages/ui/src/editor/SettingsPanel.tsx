/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ReactNode } from 'react';
import type { HttpRequest, RequestSettings } from '@httpreq/shared';
import { Badge, Group, NumberInput, Stack, Switch, Text } from '../kit';

interface Props {
    request: HttpRequest;
    onChange: (patch: Partial<HttpRequest>) => void;
    desktop: boolean;
}

function Row({
    label,
    description,
    badge,
    control,
}: {
    label: string;
    description: ReactNode;
    badge?: ReactNode;
    control: ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-4 border-b border-line py-2.5">
            <div>
                <Group gap={6}>
                    <Text size="sm" className="font-medium">
                        {label}
                    </Text>
                    {badge}
                </Group>
                <Text size="xs" className="text-dimmed">
                    {description}
                </Text>
            </div>
            <div className="flex-none">{control}</div>
        </div>
    );
}

const DesktopOnly = () => (
    <Badge size="xs" variant="light" color="violet">
        Desktop only
    </Badge>
);
const Soon = () => (
    <Badge size="xs" variant="light" color="gray">
        Soon
    </Badge>
);

/** Per-request transport behaviour. Options a platform cannot honour are marked, not faked. */
export function SettingsPanel({ request, onChange, desktop }: Props) {
    const { settings } = request;
    const set = (patch: Partial<RequestSettings>) =>
        onChange({ settings: { ...settings, ...patch } });

    return (
        <Stack gap={0} className="max-w-[760px]">
            <Row
                label="Request timeout"
                description="Milliseconds to wait for a response. 0 waits indefinitely."
                control={
                    <NumberInput
                        aria-label="Request timeout in milliseconds"
                        size="xs"
                        min={0}
                        step={1000}
                        suffix=" ms"
                        value={settings.timeoutMs}
                        onChange={(value) =>
                            set({ timeoutMs: typeof value === 'number' ? value : 0 })
                        }
                        className="w-[130px]"
                    />
                }
            />
            <Row
                label="Follow redirects"
                description={
                    desktop
                        ? 'Follow 3xx responses automatically.'
                        : 'Follow 3xx responses automatically. When off, browsers only report that a redirect happened.'
                }
                control={
                    <Switch
                        aria-label="Follow redirects"
                        checked={settings.followRedirects}
                        onChange={(event) => set({ followRedirects: event.currentTarget.checked })}
                    />
                }
            />
            <Row
                label="Verify TLS certificates"
                badge={<DesktopOnly />}
                description={
                    desktop
                        ? 'Turn off only for development servers with self-signed certificates.'
                        : 'Browsers always verify certificates; this setting applies in the desktop app.'
                }
                control={
                    <Switch
                        aria-label="Verify TLS certificates"
                        checked={settings.verifyTls}
                        disabled={!desktop}
                        onChange={(event) => set({ verifyTls: event.currentTarget.checked })}
                    />
                }
            />
            <Row
                label="Send and store cookies"
                description={
                    desktop
                        ? 'Use HttpReq’s own cookie jar for this request.'
                        : 'Sends browser cookies (credentialed CORS). The server must allow credentials.'
                }
                control={
                    <Switch
                        aria-label="Send and store cookies"
                        checked={settings.sendCookies}
                        onChange={(event) => set({ sendCookies: event.currentTarget.checked })}
                    />
                }
            />
            <Row
                label="Response size limit"
                description="Stop reading larger responses and show what arrived. 0 reads everything."
                control={
                    <NumberInput
                        aria-label="Response size limit in megabytes"
                        size="xs"
                        min={0}
                        suffix=" MB"
                        value={settings.responseSizeLimitMb}
                        onChange={(value) =>
                            set({ responseSizeLimitMb: typeof value === 'number' ? value : 0 })
                        }
                        className="w-[130px]"
                    />
                }
            />
            <Row
                label="Maximum redirects"
                badge={<Soon />}
                description="Limit how many redirects are followed."
                control={null}
            />
            <Row
                label="Automatic Content-Length"
                badge={<Soon />}
                description="Currently always computed by the network stack."
                control={null}
            />
            <Row
                label="Request compression"
                badge={<Soon />}
                description="Compress request bodies (gzip, br)."
                control={null}
            />
        </Stack>
    );
}
