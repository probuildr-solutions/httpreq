/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

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
    cx,
} from '../kit';

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
        <Stack gap="xs" className="min-h-0 flex-1">
            <Group gap="xs" justify="space-between" wrap="nowrap" className="flex-none">
                <div className="no-scrollbar min-w-0 overflow-x-auto">
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
                            <Tooltip label={error} w={320}>
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
                                void jsonEditor.current
                                    ?.getAction('editor.action.formatDocument')
                                    ?.run()
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
                        aria-label="Text content type"
                        value={body.textContentType}
                        data={TEXT_CONTENT_TYPES.map((value) => ({
                            value,
                            label: TEXT_TYPES[value].label,
                        }))}
                        onChange={(value) =>
                            value && setBody({ textContentType: value as TextContentType })
                        }
                        className="w-[140px]"
                    />
                )}
            </Group>

            {noBodyMethod && body.mode !== 'none' && (
                <Text size="xs" className="text-warning-text">
                    {request.method} requests are sent without a body. Choose another method to send
                    it.
                </Text>
            )}

            {body.mode === 'none' && (
                <Text size="sm" className="text-dimmed py-3.5 text-center">
                    This request has no body.
                </Text>
            )}
            {body.mode === 'json' && (
                <CodeEditor
                    className="min-h-40 flex-1"
                    language="json"
                    ariaLabel="JSON body"
                    value={body.json}
                    onChange={(json) => setBody({ json })}
                    onEditor={(instance) => (jsonEditor.current = instance)}
                />
            )}
            {body.mode === 'text' && (
                <CodeEditor
                    className="min-h-40 flex-1"
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
                            data={[
                                { value: 'text', label: 'Text' },
                                { value: 'file', label: 'File' },
                            ]}
                            onChange={(kind) =>
                                kind && update({ kind: kind as MultipartField['kind'] })
                            }
                            inputClassName="cursor-pointer text-[12.5px]"
                        />
                    )}
                    renderValue={(item, update) =>
                        item.kind === 'file' ? (
                            <FilePicker
                                file={item.file ?? null}
                                onChange={(file) => update({ file })}
                                compact
                            />
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
        <Group gap="xs" wrap="nowrap" className={cx('h-7 min-w-0', compact && 'px-1.5')}>
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
                <Group gap={6} wrap="nowrap" className="min-w-[0px]">
                    <IconFile size={14} aria-hidden />
                    <Text size="xs" className="truncate">
                        {file.name}
                    </Text>
                    <Text size="xs" className="text-dimmed">
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
                <Text size="xs" className="text-dimmed">
                    The file is read when the request is sent and is not saved with the request.
                </Text>
            )}
        </Group>
    );
}
