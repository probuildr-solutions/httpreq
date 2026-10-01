/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconAlertTriangle,
    IconArrowUpRight,
    IconShieldLock,
    IconSitemap,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';
import {
    AUTH_TYPES,
    authProviders,
    getAuthProvider,
    type EffectiveAuth,
} from '@httpreq/api-client';
import type { AuthConfig, AuthType } from '@httpreq/shared';
import type { AuthEditorProps } from './authServices';
import { authEditors } from './editorRegistry';
import {
    Alert,
    Anchor,
    Button,
    FORM_DENSITY,
    Group,
    Select,
    Stack,
    Text,
    ThemeIcon,
    cx,
} from '../kit';

interface Props {
    auth: AuthConfig;
    onChange: (auth: AuthConfig) => void;
    /** What children of this node's parent inherit (shown for "Inherit from Parent"). */
    inherited: EffectiveAuth;
    /** Collections have no parent to inherit from. */
    canInherit: boolean;
    /** Owner noun for copy, e.g. "request" or "folder". */
    owner: string;
    /** Enabled manual headers that this authorization replaces. */
    conflicts?: string[];
    /** Selects the node an inherited configuration comes from. */
    onShowSource?: (id: string) => void;
}

const sourceKind = {
    request: 'Request',
    folder: 'Folder',
    collection: 'Collection',
    none: '',
} as const;

/**
 * Authorization type selector plus the selected provider's editor. The panel knows nothing about
 * individual schemes: labels come from the provider registry and fields from the editor registry.
 */
export function AuthorizationPanel({
    auth,
    onChange,
    inherited,
    canInherit,
    owner,
    conflicts = [],
    onShowSource,
}: Props) {
    const provider = getAuthProvider(auth);
    const Editor = authEditors[auth.type] as ComponentType<AuthEditorProps<AuthConfig>> | null;
    const warnings = provider.validate(auth).filter((issue) => issue.severity === 'warning');
    const options = AUTH_TYPES.filter((type) => canInherit || type !== 'inherit').map((type) => ({
        value: type,
        label: authProviders[type].label,
    }));

    return (
        <Stack gap="md" className={cx(FORM_DENSITY, 'max-w-[760px]')}>
            <Stack gap={4}>
                <Select
                    label="Authorization type"
                    value={auth.type}
                    data={options}
                    onChange={(type) =>
                        type &&
                        type !== auth.type &&
                        onChange(authProviders[type as AuthType].create())
                    }
                />
                {/* Always one line of description, so switching schemes never moves what follows. */}
                <Text size="xs" className="min-h-[1.114rem] text-dimmed">
                    {provider.description}
                </Text>
            </Stack>

            {auth.type === 'none' && (
                <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-line px-4 py-9">
                    <ThemeIcon variant="light" color="gray" size={40} round>
                        <IconShieldLock size={20} />
                    </ThemeIcon>
                    <Text size="sm" className="font-semibold">
                        No authorization selected
                    </Text>
                    <Text size="xs" className="max-w-[300px] text-center text-dimmed">
                        Select an authorization type above to configure authentication for this{' '}
                        {owner}.
                    </Text>
                </div>
            )}

            {auth.type === 'inherit' && (
                <div className="rounded-md border border-line bg-chrome p-3">
                    <Group gap="xs" wrap="nowrap" align="flex-start">
                        <ThemeIcon variant="light" size={30}>
                            <IconSitemap size={16} />
                        </ThemeIcon>
                        <Stack gap={6} className="min-w-0">
                            {inherited.source.kind === 'none' ? (
                                <Text size="sm">
                                    No parent folder or collection configures authorization, so this{' '}
                                    {owner} is sent without it.
                                </Text>
                            ) : (
                                <>
                                    <div>
                                        <Text size="xs" className="text-dimmed">
                                            Inherited from
                                        </Text>
                                        <Group gap={6} wrap="nowrap">
                                            <Text size="sm" className="font-semibold truncate">
                                                {inherited.source.name}
                                            </Text>
                                            <Text size="xs" className="text-dimmed">
                                                {sourceKind[inherited.source.kind]}
                                            </Text>
                                            {onShowSource && inherited.source.id && (
                                                <Anchor
                                                    component="button"
                                                    size="xs"
                                                    onClick={() =>
                                                        onShowSource(inherited.source.id!)
                                                    }
                                                    className="inline-flex items-center gap-0.5"
                                                >
                                                    Show <IconArrowUpRight size={12} />
                                                </Anchor>
                                            )}
                                        </Group>
                                    </div>
                                    <div>
                                        <Text size="xs" className="text-dimmed">
                                            Type
                                        </Text>
                                        <Text size="sm">
                                            {authProviders[inherited.auth.type].label}
                                        </Text>
                                    </div>
                                </>
                            )}
                            <Group>
                                <Button
                                    size="xs"
                                    variant="default"
                                    onClick={() =>
                                        onChange(
                                            inherited.auth.type === 'none'
                                                ? authProviders.bearer.create()
                                                : structuredClone(inherited.auth),
                                        )
                                    }
                                >
                                    Override authorization
                                </Button>
                            </Group>
                        </Stack>
                    </Group>
                </div>
            )}

            {conflicts.length > 0 && auth.type !== 'none' && (
                <Alert
                    color="yellow"
                    variant="light"
                    icon={<IconAlertTriangle size={16} />}
                    className="p-2"
                >
                    <Text size="xs">
                        The {conflicts.join(', ')} header configured in Headers is replaced by this
                        authorization, so it is sent only once.
                    </Text>
                </Alert>
            )}

            {Editor && <Editor config={auth} onChange={onChange} />}

            {warnings.length > 0 && (
                <Stack gap={2}>
                    {warnings.map((issue) => (
                        <Text key={issue.message} size="xs" className="text-warning-text">
                            {issue.message}
                        </Text>
                    ))}
                </Stack>
            )}
        </Stack>
    );
}
