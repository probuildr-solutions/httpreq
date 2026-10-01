/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconCopy, IconDownload, IconTerminal2 } from '@tabler/icons-react';
import { useState } from 'react';
import { Badge, Button, Code, Group, notifications, Stack, Text, Title } from '../kit';

interface Props {
    /** Builds a cURL command (variables resolved, secrets kept as references). */
    buildCurl: () => Promise<string>;
    onExportRequest: () => void;
    onExportCollection?: () => void;
    collectionName?: string;
}

const UPCOMING = ['Workspace sharing', 'Team synchronization', 'Shareable links'];

/**
 * Sharing is export-based and entirely local: HttpReq has no backend. Nothing here changes how
 * requests are stored.
 */
export function SharingPanel({
    buildCurl,
    onExportRequest,
    onExportCollection,
    collectionName,
}: Props) {
    const [curl, setCurl] = useState<string | null>(null);
    const [building, setBuilding] = useState(false);

    const copyCurl = async () => {
        setBuilding(true);
        try {
            const command = await buildCurl();
            setCurl(command);
            await navigator.clipboard.writeText(command);
            notifications.show({ color: 'teal', message: 'cURL command copied to the clipboard.' });
        } catch (error) {
            notifications.show({
                color: 'red',
                title: 'Cannot build cURL',
                message: (error as Error).message,
            });
        } finally {
            setBuilding(false);
        }
    };

    return (
        <Stack gap="lg" className="max-w-[760px]">
            <Stack gap="xs">
                <Title order={4} className="text-[13px]">
                    Copy as cURL
                </Title>
                <Text size="xs" className="text-dimmed">
                    Uses the active environment. Secret variables stay as <Code>{'{{name}}'}</Code>{' '}
                    references.
                </Text>
                <Group>
                    <Button
                        size="xs"
                        variant="default"
                        leftSection={<IconTerminal2 size={14} />}
                        loading={building}
                        onClick={() => void copyCurl()}
                    >
                        Copy as cURL
                    </Button>
                </Group>
                {curl && (
                    <Code block className="max-h-[220px] text-xs whitespace-pre">
                        {curl}
                    </Code>
                )}
            </Stack>

            <Stack gap="xs">
                <Title order={4} className="text-[13px]">
                    Export
                </Title>
                <Text size="xs" className="text-dimmed">
                    Saves a file you can share or keep in version control: HttpReq, Postman
                    Collection v2.1 or OpenAPI 3.1. Literal secrets are removed.
                </Text>
                <Group gap="xs">
                    <Button
                        size="xs"
                        variant="default"
                        leftSection={<IconDownload size={14} />}
                        onClick={onExportRequest}
                    >
                        Export request…
                    </Button>
                    {onExportCollection && (
                        <Button
                            size="xs"
                            variant="default"
                            leftSection={<IconCopy size={14} />}
                            onClick={onExportCollection}
                        >
                            Export collection “{collectionName}”…
                        </Button>
                    )}
                </Group>
            </Stack>

            <Stack gap="xs">
                <Title order={4} className="text-[13px]">
                    Collaboration
                </Title>
                {UPCOMING.map((label) => (
                    <Group key={label} gap="xs">
                        <Text size="sm" className="text-dimmed">
                            {label}
                        </Text>
                        <Badge size="xs" variant="light" color="gray">
                            Soon
                        </Badge>
                    </Group>
                ))}
            </Stack>
        </Stack>
    );
}
