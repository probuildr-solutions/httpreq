/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconAlertTriangle, IconShieldQuestion } from '@tabler/icons-react';
import { AppModal } from '../AppModal';
import { Z_LAYERS } from '../zLayers';
import { useSsh } from './useSsh';
import { Alert, Button, Code, Stack, Text } from '../kit';

/**
 * Host-key verification.
 *
 * A first connection shows the fingerprint and asks. A fingerprint that has *changed* is the case
 * that matters: it means the host is presenting a different identity than the one that was
 * trusted, which is what a man-in-the-middle looks like. Nothing is accepted automatically, and
 * the dialog cannot be dismissed by clicking away — the user has to choose.
 *
 * It is raised from inside another dialog, so it takes its own stacking layer and the focus with
 * it; `yieldToHostKeyPrompt` is the other half of that arrangement.
 */
export function HostKeyDialog() {
    const ssh = useSsh();
    const pending = ssh.pendingHostKey;
    const prompt = pending?.prompt;
    const changed = !!prompt?.storedFingerprint;

    return (
        <AppModal
            opened={!!pending}
            onClose={() => ssh.answerHostKey('reject')}
            title={changed ? 'Host identification has changed' : 'Unknown host'}
            closeOnClickOutside={false}
            closeOnEscape={false}
            withCloseButton={false}
            zIndex={Z_LAYERS.hostKey}
            trapFocus
            returnFocus
            centered
            size="lg"
            footer={
                prompt && (
                    <>
                        {/* The safe answer holds the initial focus, so Enter can never trust a host. */}
                        <Button
                            variant="default"
                            data-autofocus
                            onClick={() => ssh.answerHostKey('reject')}
                        >
                            Cancel connection
                        </Button>
                        <Button
                            color={changed ? 'red' : undefined}
                            onClick={() => ssh.answerHostKey('trust')}
                        >
                            {changed ? 'Accept the new key' : 'Trust this host'}
                        </Button>
                    </>
                )
            }
        >
            {prompt && (
                <Stack gap="md">
                    {changed ? (
                        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
                            <Text size="sm" className="font-semibold">
                                WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED
                            </Text>
                            <Text size="sm" className="mt-1">
                                The key offered by this host is not the one HttpReq trusted before.
                                Someone may be intercepting the connection. It can also happen
                                legitimately after the server was rebuilt or its host key was
                                rotated — confirm the new fingerprint with whoever administers it
                                before you continue.
                            </Text>
                        </Alert>
                    ) : (
                        <Alert color="blue" variant="light" icon={<IconShieldQuestion size={18} />}>
                            HttpReq has not connected to this host before. Check the fingerprint
                            against one you trust, then decide.
                        </Alert>
                    )}

                    <Stack gap={6}>
                        <Text size="xs" className="text-dimmed">
                            Host
                        </Text>
                        <Code>
                            {prompt.host}:{prompt.port}
                        </Code>
                    </Stack>

                    {changed && (
                        <Stack gap={6}>
                            <Text size="xs" className="text-dimmed">
                                Stored fingerprint ({prompt.keyType})
                            </Text>
                            <Text className="font-mono text-xs break-all select-all">
                                {prompt.storedFingerprint}
                            </Text>
                        </Stack>
                    )}

                    <Stack gap={6}>
                        <Text size="xs" className="text-dimmed">
                            {changed ? 'Received fingerprint' : 'Fingerprint'} ({prompt.keyType})
                        </Text>
                        <Text className="font-mono text-xs break-all select-all">
                            {prompt.fingerprint}
                        </Text>
                    </Stack>
                </Stack>
            )}
        </AppModal>
    );
}
