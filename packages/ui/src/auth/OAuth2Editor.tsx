/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconExternalLink, IconKey, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import {
    buildAuthorizationUrl,
    createOAuthState,
    createPkcePair,
    isTokenExpired,
    OAUTH2_GRANT_LABELS,
    parseAuthorizationResponse,
    type OAuthTokens,
} from '@httpreq/api-client';
import { OAUTH2_GRANT_TYPES, type OAuth2Auth, type OAuth2GrantType } from '@httpreq/shared';
import { AppModal } from '../AppModal';
import { useAuthServices, type AuthEditorProps } from './authServices';
import { Field } from './Field';
import {
    Alert,
    Badge,
    Button,
    CopyButton,
    Divider,
    Group,
    notifications,
    Select,
    SimpleGrid,
    Stack,
    Text,
    Textarea,
} from '../kit';

const usesCode = (grant: OAuth2GrantType) =>
    grant === 'authorization_code' || grant === 'authorization_code_pkce';

interface PendingAuthorization {
    url: string;
    state: string;
    verifier?: string;
}

/**
 * OAuth 2.0 configuration and token retrieval. Code grants open the authorization page in the
 * browser; the user pastes the redirect URL back, and HttpReq checks the state and exchanges the
 * code (with the PKCE verifier) through the platform runtime.
 */
export function OAuth2Editor({ config, onChange }: AuthEditorProps<OAuth2Auth>) {
    const services = useAuthServices();
    const set = (patch: Partial<OAuth2Auth>) => onChange({ ...config, ...patch });
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<PendingAuthorization | null>(null);
    const [redirect, setRedirect] = useState('');
    const grant = config.grantType;

    const applyTokens = (tokens: OAuthTokens) => {
        onChange({
            ...config,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
        });
        const variable = config.tokenVariable.trim();
        const stored = variable ? services.setVariable(variable, tokens.accessToken) : false;
        notifications.show({
            color: 'teal',
            title: 'Access token received',
            message:
                variable && !stored
                    ? `Select an environment to also store it in {{${variable}}}.`
                    : variable
                      ? `Also stored in {{${variable}}}.`
                      : 'The token is used for requests with this authorization.',
        });
    };

    const run = async (task: () => Promise<OAuthTokens>) => {
        setBusy(true);
        try {
            applyTokens(await task());
            return true;
        } catch (error) {
            notifications.show({
                color: 'red',
                title: 'Token request failed',
                message: (error as Error).message,
            });
            return false;
        } finally {
            setBusy(false);
        }
    };

    const getToken = async () => {
        if (!usesCode(grant)) {
            await run(() => services.requestTokens(config));
            return;
        }
        try {
            const pkce = grant === 'authorization_code_pkce' ? await createPkcePair() : undefined;
            const state = createOAuthState();
            const resolved = {
                ...config,
                authUrl: services.resolve(config.authUrl),
                clientId: services.resolve(config.clientId),
                scope: services.resolve(config.scope),
                callbackUrl: services.resolve(config.callbackUrl),
            };
            const url = buildAuthorizationUrl(resolved, { state, codeChallenge: pkce?.challenge });
            setRedirect('');
            setPending({ url, state, verifier: pkce?.verifier });
        } catch (error) {
            notifications.show({
                color: 'red',
                title: 'Cannot start authorization',
                message: (error as Error).message,
            });
        }
    };

    const exchange = async () => {
        if (!pending) return;
        let code: string;
        try {
            code = parseAuthorizationResponse(redirect, pending.state);
        } catch (error) {
            notifications.show({ color: 'red', message: (error as Error).message });
            return;
        }
        if (
            await run(() =>
                services.requestTokens(config, { code, codeVerifier: pending.verifier }),
            )
        ) {
            setPending(null);
        }
    };

    const expired = config.accessToken && isTokenExpired(config);

    return (
        <Stack gap="sm">
            <Select
                label="Grant type"
                value={grant}
                data={OAUTH2_GRANT_TYPES.map((value) => ({
                    value,
                    label: OAUTH2_GRANT_LABELS[value],
                }))}
                onChange={(value) => value && set({ grantType: value as OAuth2GrantType })}
            />
            {usesCode(grant) && (
                <Field
                    label="Authorization URL"
                    placeholder="https://auth.example.com/authorize"
                    value={config.authUrl}
                    onChange={(authUrl) => set({ authUrl })}
                />
            )}
            <Field
                label="Access token URL"
                placeholder="https://auth.example.com/token"
                value={config.tokenUrl}
                onChange={(tokenUrl) => set({ tokenUrl })}
            />
            <SimpleGrid cols={{ base: 1, xs: 2 }} gap="sm">
                <Field
                    label="Client ID"
                    value={config.clientId}
                    onChange={(clientId) => set({ clientId })}
                />
                <Field
                    label="Client secret"
                    masked
                    value={config.clientSecret}
                    onChange={(clientSecret) => set({ clientSecret })}
                />
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, xs: 2 }} gap="sm">
                <Field
                    label="Scope"
                    placeholder="read write"
                    mono={false}
                    value={config.scope}
                    onChange={(scope) => set({ scope })}
                />
                {usesCode(grant) ? (
                    <Field
                        label="Callback URL"
                        description="Must match a redirect URI registered with the provider."
                        value={config.callbackUrl}
                        onChange={(callbackUrl) => set({ callbackUrl })}
                    />
                ) : (
                    <Select
                        label="Client authentication"
                        value={config.clientAuthentication}
                        data={[
                            { value: 'basic-header', label: 'Send as Basic Auth header' },
                            { value: 'body', label: 'Send in the request body' },
                        ]}
                        onChange={(value) =>
                            value &&
                            set({
                                clientAuthentication: value as OAuth2Auth['clientAuthentication'],
                            })
                        }
                    />
                )}
            </SimpleGrid>
            {grant === 'password' && (
                <SimpleGrid cols={{ base: 1, xs: 2 }} gap="sm">
                    <Field
                        label="Username"
                        value={config.username}
                        onChange={(username) => set({ username })}
                    />
                    <Field
                        label="Password"
                        masked
                        value={config.password}
                        onChange={(password) => set({ password })}
                    />
                </SimpleGrid>
            )}
            {grant === 'refresh_token' && (
                <Field
                    label="Refresh token"
                    masked
                    value={config.refreshToken}
                    onChange={(refreshToken) => set({ refreshToken })}
                />
            )}

            <Divider label="Current token" labelPosition="left" />
            <Field
                label="Access token"
                masked
                placeholder="Use “Get New Access Token”"
                value={config.accessToken}
                onChange={(accessToken) => set({ accessToken, expiresAt: null })}
                rightSection={
                    config.accessToken ? (
                        <Badge
                            size="xs"
                            color={expired ? 'red' : 'teal'}
                            variant="light"
                            className="mr-1.5"
                        >
                            {expired
                                ? 'Expired'
                                : config.expiresAt
                                  ? `Expires ${new Date(config.expiresAt).toLocaleTimeString()}`
                                  : 'Set'}
                        </Badge>
                    ) : undefined
                }
            />
            <SimpleGrid cols={{ base: 1, xs: 2 }} gap="sm">
                <Field
                    label="Header prefix"
                    mono={false}
                    completion={false}
                    value={config.headerPrefix}
                    onChange={(headerPrefix) => set({ headerPrefix })}
                />
                <Field
                    label="Also store token in variable"
                    description="Written to the active environment as a secret."
                    placeholder="accessToken"
                    completion={false}
                    value={config.tokenVariable}
                    onChange={(tokenVariable) =>
                        set({ tokenVariable: tokenVariable.replace(/[{}\s]/g, '') })
                    }
                />
            </SimpleGrid>
            <Group gap="xs">
                <Button
                    leftSection={<IconKey size={15} />}
                    loading={busy && !pending}
                    onClick={() => void getToken()}
                >
                    Get New Access Token
                </Button>
                {config.refreshToken && grant !== 'refresh_token' && (
                    <Button
                        variant="default"
                        leftSection={<IconRefresh size={15} />}
                        disabled={busy}
                        onClick={() =>
                            void run(() =>
                                services.requestTokens({ ...config, grantType: 'refresh_token' }),
                            )
                        }
                    >
                        Refresh
                    </Button>
                )}
                {(config.accessToken || config.refreshToken) && (
                    <Button
                        variant="subtle"
                        color="gray"
                        onClick={() => set({ accessToken: '', refreshToken: '', expiresAt: null })}
                    >
                        Clear tokens
                    </Button>
                )}
            </Group>

            <AppModal
                opened={!!pending}
                onClose={() => setPending(null)}
                title="Authorize HttpReq"
                size="lg"
                footer={
                    <>
                        <Button variant="default" onClick={() => setPending(null)}>
                            Cancel
                        </Button>
                        <Button
                            loading={busy}
                            disabled={!redirect.trim()}
                            onClick={() => void exchange()}
                        >
                            Exchange code
                        </Button>
                    </>
                }
            >
                {pending && (
                    <Stack gap="sm">
                        <Text size="sm">
                            1. Open the authorization page, sign in and approve access.
                        </Text>
                        <Group gap="xs">
                            <Button
                                leftSection={<IconExternalLink size={15} />}
                                onClick={() => services.openUrl(pending.url)}
                            >
                                Open authorization page
                            </Button>
                            <CopyButton value={pending.url}>
                                {({ copied, copy }) => (
                                    <Button variant="default" onClick={copy}>
                                        {copied ? 'Copied' : 'Copy URL'}
                                    </Button>
                                )}
                            </CopyButton>
                        </Group>
                        <Text size="sm">
                            2. After approving, the provider redirects to your callback URL. Paste
                            that full URL (or the code) here.
                        </Text>
                        <Textarea
                            aria-label="Redirect URL"
                            placeholder="https://your-callback/…?code=…&state=…"
                            value={redirect}
                            onChange={(event) => setRedirect(event.currentTarget.value)}
                            autosize
                            minRows={2}
                            className="hr-mono"
                        />
                        {grant === 'authorization_code_pkce' && (
                            <Alert color="gray" variant="light" className="p-2">
                                <Text size="xs">
                                    PKCE (S256) protects this exchange; the verifier never leaves
                                    HttpReq until the code is exchanged.
                                </Text>
                            </Alert>
                        )}
                    </Stack>
                )}
            </AppModal>
        </Stack>
    );
}
