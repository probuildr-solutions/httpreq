/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ApiKeyAuth, BasicAuth, BearerAuth, DigestAuth } from '@httpreq/shared';
import type { AuthEditorProps } from './authServices';
import { Field } from './Field';
import { Select, SimpleGrid, Stack, Text } from '../kit';

export function ApiKeyEditor({ config, onChange }: AuthEditorProps<ApiKeyAuth>) {
    return (
        <Stack gap="sm">
            <Field
                label="Key"
                placeholder="X-API-Key"
                value={config.key}
                onChange={(key) => onChange({ ...config, key })}
            />
            <Field
                label="Value"
                placeholder="{{apiKey}}"
                masked
                value={config.value}
                onChange={(value) => onChange({ ...config, value })}
            />
            <Select
                label="Add to"
                value={config.location}
                data={[
                    { value: 'header', label: 'Header' },
                    { value: 'query', label: 'Query Parameter' },
                ]}
                onChange={(location) =>
                    location &&
                    onChange({ ...config, location: location as ApiKeyAuth['location'] })
                }
            />
        </Stack>
    );
}

export function BearerEditor({ config, onChange }: AuthEditorProps<BearerAuth>) {
    return (
        <Stack gap="sm">
            <Field
                label="Token"
                placeholder="{{accessToken}}"
                masked
                value={config.token}
                onChange={(token) => onChange({ ...config, token })}
            />
            <Field
                label="Header prefix"
                description="Sent as “Authorization: <prefix> <token>”."
                mono={false}
                completion={false}
                value={config.prefix}
                onChange={(prefix) => onChange({ ...config, prefix })}
            />
        </Stack>
    );
}

export function BasicEditor<C extends BasicAuth | DigestAuth>({
    config,
    onChange,
}: AuthEditorProps<C>) {
    return (
        <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, xs: 2 }} gap="sm">
                <Field
                    label="Username"
                    placeholder="{{username}}"
                    value={config.username}
                    onChange={(username) => onChange({ ...config, username })}
                />
                <Field
                    label="Password"
                    placeholder="{{password}}"
                    masked
                    value={config.password}
                    onChange={(password) => onChange({ ...config, password })}
                />
            </SimpleGrid>
            {config.type === 'digest' && (
                <Text size="xs" className="text-dimmed">
                    The first request is sent without credentials; HttpReq answers the server’s 401
                    Digest challenge once. In the browser this requires the server to expose the
                    WWW-Authenticate header to scripts (CORS); the desktop app always can.
                </Text>
            )}
        </Stack>
    );
}
