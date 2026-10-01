/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { IconBolt, IconBox, IconPlus, IconSend } from '@tabler/icons-react';
import { Button, Group, Stack, Text, ThemeIcon } from '../kit';

interface Props {
    onNewRequest: () => void;
    onNewWebSocket: () => void;
    onNewCollection: () => void;
}

/** What the workspace shows when no tab is open: the three ways to start. */
export function EmptyWorkspace({ onNewRequest, onNewWebSocket, onNewCollection }: Props) {
    return (
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
            <Stack align="center" gap="xs">
                <ThemeIcon variant="light" size={44} round>
                    <IconSend size={22} />
                </ThemeIcon>
                <Text className="font-semibold">No request open</Text>
                <Text size="sm" className="text-dimmed">
                    Open a request from the explorer, or start a new one.
                </Text>
                <Group gap="xs" className="mt-2">
                    <Button leftSection={<IconPlus size={15} />} onClick={onNewRequest}>
                        New request
                    </Button>
                    <Button
                        variant="default"
                        leftSection={<IconBolt size={15} />}
                        onClick={onNewWebSocket}
                    >
                        New WebSocket
                    </Button>
                    <Button
                        variant="default"
                        leftSection={<IconBox size={15} />}
                        onClick={onNewCollection}
                    >
                        New collection
                    </Button>
                </Group>
            </Stack>
        </div>
    );
}
