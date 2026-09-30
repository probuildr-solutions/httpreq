import {
  Badge,
  Button,
  FileButton,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconFile, IconUpload, IconWand } from '@tabler/icons-react';
import type { editor } from 'monaco-editor';
import { useMemo, useRef } from 'react';
import {
  createId,
  TEXT_CONTENT_TYPES,
  type BodyMode,
  type FileReference,
  type HttpRequest,
  type MultipartField,
  type RequestBody,
  type TextContentType,
} from '@httpreq/shared';
import { formatBytes, hasAttachment, rememberFile } from '../attachments';
import { CodeEditor } from './CodeEditor';
import { KeyValueTable } from './KeyValueTable';
import classes from './RequestEditor.module.css';

const MODES: { value: BodyMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'form-urlencoded', label: 'Form URL Encoded' },
  { value: 'multipart', label: 'Multipart Form' },
  { value: 'binary', label: 'Binary' },
];

const TEXT_TYPES: Record<TextContentType, { label: string; language: string }> = {
  'text/plain': { label: 'Plain text', language: 'plaintext' },
  'application/xml': { label: 'XML', language: 'xml' },
  'text/html': { label: 'HTML', language: 'html' },
  'application/javascript': { label: 'JavaScript', language: 'javascript' },
};

/** JSON validity ignoring `{{variables}}`, which are substituted before sending. */
const jsonError = (text: string): string | null => {
  if (!text.trim()) return null;
  try {
    JSON.parse(text.replace(/\{\{[^{}]+\}\}/g, '0'));
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

interface Props {
  request: HttpRequest;
  onChange: (patch: Partial<HttpRequest>) => void;
}

export function BodyPanel({ request, onChange }: Props) {
  const { body } = request;
  const setBody = (patch: Partial<RequestBody>) => onChange({ body: { ...body, ...patch } });
  const jsonEditor = useRef<editor.IStandaloneCodeEditor | null>(null);
  const error = useMemo(
    () => (body.mode === 'json' ? jsonError(body.json) : null),
    [body.mode, body.json],
  );
  const noBodyMethod = request.method === 'GET' || request.method === 'HEAD';

  return (
    <Stack gap="xs" className={classes.bodyPanel}>
      <Group gap="xs" justify="space-between" wrap="nowrap" className={classes.bodyToolbar}>
        <div className={classes.scrollX}>
          <SegmentedControl
            size="xs"
            aria-label="Body type"
            value={body.mode}
            onChange={(mode) => setBody({ mode: mode as BodyMode })}
            data={MODES}
          />
        </div>
        {body.mode === 'json' && (
          <Group gap={6} wrap="nowrap">
            {error ? (
              <Tooltip label={error} multiline maw={320}>
                <Badge color="red" variant="light" radius="xs">
                  Invalid JSON
                </Badge>
              </Tooltip>
            ) : (
              body.json.trim() && (
                <Badge color="teal" variant="light" radius="xs">
                  Valid JSON
                </Badge>
              )
            )}
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={<IconWand size={13} />}
              onClick={() =>
                void jsonEditor.current?.getAction('editor.action.formatDocument')?.run()
              }
              title="Format (Shift+Alt+F)"
            >
              Format
            </Button>
          </Group>
        )}
        {body.mode === 'text' && (
          <Select
            size="xs"
            w={140}
            aria-label="Text content type"
            value={body.textContentType}
            allowDeselect={false}
            data={TEXT_CONTENT_TYPES.map((value) => ({ value, label: TEXT_TYPES[value].label }))}
            onChange={(value) => value && setBody({ textContentType: value as TextContentType })}
            comboboxProps={{ withinPortal: true }}
          />
        )}
      </Group>

      {noBodyMethod && body.mode !== 'none' && (
        <Text size="xs" c="yellow.8">
          {request.method} requests are sent without a body. Choose another method to send it.
        </Text>
      )}

      {body.mode === 'none' && (
        <Text size="sm" c="dimmed" py="md" ta="center">
          This request has no body.
        </Text>
      )}
      {body.mode === 'json' && (
        <CodeEditor
          className={classes.editor}
          language="json"
          ariaLabel="JSON body"
          value={body.json}
          onChange={(json) => setBody({ json })}
          onEditor={(instance) => (jsonEditor.current = instance)}
        />
      )}
      {body.mode === 'text' && (
        <CodeEditor
          className={classes.editor}
          language={TEXT_TYPES[body.textContentType].language}
          ariaLabel="Text body"
          value={body.text}
          onChange={(text) => setBody({ text })}
        />
      )}
      {body.mode === 'form-urlencoded' && (
        <KeyValueTable
          label="Form fields"
          items={body.formUrlEncoded}
          onChange={(formUrlEncoded) => setBody({ formUrlEncoded })}
        />
      )}
      {body.mode === 'multipart' && (
        <KeyValueTable<MultipartField>
          label="Multipart fields"
          items={body.multipart}
          onChange={(multipart) => setBody({ multipart })}
          createRow={(patch) => ({
            id: createId(),
            key: '',
            value: '',
            enabled: true,
            kind: 'text',
            file: null,
            ...patch,
          })}
          // Files cannot be written as `key: value` lines, so the bulk editor is not offered.
          allowBulkEdit={false}
          renderType={(item, update) => (
            <Select
              size="xs"
              variant="unstyled"
              aria-label={`Type of ${item.key || 'field'}`}
              value={item.kind}
              allowDeselect={false}
              data={[
                { value: 'text', label: 'Text' },
                { value: 'file', label: 'File' },
              ]}
              onChange={(kind) => kind && update({ kind: kind as MultipartField['kind'] })}
              comboboxProps={{ withinPortal: true }}
              styles={{ input: { paddingInline: 8, cursor: 'pointer', fontSize: 12.5 } }}
            />
          )}
          renderValue={(item, update) =>
            item.kind === 'file' ? (
              <FilePicker file={item.file ?? null} onChange={(file) => update({ file })} compact />
            ) : undefined
          }
        />
      )}
      {body.mode === 'binary' && (
        <FilePicker file={body.binary} onChange={(binary) => setBody({ binary })} />
      )}
    </Stack>
  );
}

function FilePicker({
  file,
  onChange,
  compact,
}: {
  file: FileReference | null;
  onChange: (file: FileReference | null) => void;
  compact?: boolean;
}) {
  const available = hasAttachment(file);
  return (
    <Group gap="xs" wrap="nowrap" px={compact ? 6 : 0} className={classes.filePicker}>
      <FileButton onChange={(chosen) => chosen && onChange(rememberFile(chosen))}>
        {(props) => (
          <Button
            {...props}
            size="compact-xs"
            variant="default"
            leftSection={<IconUpload size={13} />}
          >
            {file ? 'Replace' : 'Select file'}
          </Button>
        )}
      </FileButton>
      {file && (
        <Group gap={6} wrap="nowrap" miw={0}>
          <IconFile size={14} aria-hidden />
          <Text size="xs" truncate>
            {file.name}
          </Text>
          <Text size="xs" c="dimmed">
            {formatBytes(file.size)}
          </Text>
          {!available && (
            <Tooltip label="Files are kept only for this session. Select it again to send.">
              <Badge size="xs" color="yellow" variant="light">
                Reselect
              </Badge>
            </Tooltip>
          )}
        </Group>
      )}
      {!compact && !file && (
        <Text size="xs" c="dimmed">
          The file is read when the request is sent and is not saved with the request.
        </Text>
      )}
    </Group>
  );
}
