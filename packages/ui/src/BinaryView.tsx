import { Button, Center, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconDeviceFloppy, IconFileDownload } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { describeResponse } from '@httpreq/api-client';
import type { HttpResponse } from '@httpreq/shared';
import { formatBytes } from './attachments';
import classes from './ResponsePanel.module.css';

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
    <Center className={classes.binary}>
      <Stack align="center" gap="xs" maw={420}>
        {preview ? (
          <img src={preview} alt={fileName} className={classes.preview} />
        ) : (
          <ThemeIcon variant="light" size={44} radius="xl">
            <IconFileDownload size={22} />
          </ThemeIcon>
        )}
        <Text fw={600} ta="center" style={{ wordBreak: 'break-all' }}>
          {fileName}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {info.mimeType || 'unknown type'} · {formatBytes(info.sizeBytes)}
          {info.contentLength !== null && info.contentLength !== info.sizeBytes
            ? ` (Content-Length ${formatBytes(info.contentLength)})`
            : ''}
        </Text>
        <Text size="xs" c="dimmed" ta="center">
          This response is binary content, so it is not shown as text.
          {response.truncated ? ' It was cut at the response size limit.' : ''}
        </Text>
        <Button leftSection={<IconDeviceFloppy size={15} />} onClick={onSave}>
          Save to file…
        </Button>
      </Stack>
    </Center>
  );
}
