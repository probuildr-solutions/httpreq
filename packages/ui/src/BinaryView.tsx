/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { IconDeviceFloppy, IconFileDownload } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { describeResponse } from '@httpreq/api-client';
import type { HttpResponse } from '@httpreq/shared';
import { formatBytes } from './attachments';
import { Button, Stack, Text, ThemeIcon } from './kit';

/** Image types a browser can draw from bytes; SVG is left out, it is shown as text. */
const PREVIEWABLE = /^image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon)$/;

/**
 * What the body area shows for a binary response instead of corrupted text: the file name, type
 * and size, a preview for common image types, and the button to save it.
 */
export function BinaryView({
    response,
    fileName,
    onSave,
}: {
    response: HttpResponse;
    fileName: string;
    onSave: () => void;
}) {
    const info = describeResponse(response);
    const previewable = PREVIEWABLE.test(info.mimeType) && !!response.bytes?.length;
    const [preview, setPreview] = useState<string | null>(null);

    useEffect(() => {
        if (!previewable || !response.bytes) return;
        const url = URL.createObjectURL(
            new Blob([response.bytes as BlobPart], { type: info.mimeType }),
        );
        setPreview(url);
        return () => {
            URL.revokeObjectURL(url);
            setPreview(null);
        };
    }, [previewable, response.bytes, info.mimeType]);

    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
            <Stack align="center" gap="xs" className="max-w-[420px]">
                {preview ? (
                    <img
                        src={preview}
                        alt={fileName}
                        // A chequerboard behind the image makes transparent areas visible.
                        className="max-h-[220px] max-w-full rounded-sm border border-line object-contain bg-[repeating-conic-gradient(#eee_0%_25%,#fff_0%_50%)] bg-[length:12px_12px] bg-center dark:bg-[repeating-conic-gradient(#333_0%_25%,#2a2a2a_0%_50%)]"
                    />
                ) : (
                    <ThemeIcon variant="light" size={44} round>
                        <IconFileDownload size={22} />
                    </ThemeIcon>
                )}
                <Text className="text-center font-semibold break-all">{fileName}</Text>
                <Text size="sm" className="text-center text-dimmed">
                    {info.mimeType || 'unknown type'} · {formatBytes(info.sizeBytes)}
                    {info.contentLength !== null && info.contentLength !== info.sizeBytes
                        ? ` (Content-Length ${formatBytes(info.contentLength)})`
                        : ''}
                </Text>
                <Text size="xs" className="text-center text-dimmed">
                    This response is binary content, so it is not shown as text.
                    {response.truncated ? ' It was cut at the response size limit.' : ''}
                </Text>
                <Button leftSection={<IconDeviceFloppy size={15} />} onClick={onSave}>
                    Save to file…
                </Button>
            </Stack>
        </div>
    );
}
