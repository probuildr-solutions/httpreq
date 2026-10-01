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
import { prettyXmlText } from '../prettyText';
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

/** The body types in the selector; `raw` covers the JSON and text modes of the stored body. */
type BodyType = Exclude<BodyMode, 'json' | 'text'> | 'raw';

const MODES: { value: BodyType; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'raw', label: 'Raw' },
    { value: 'form-urlencoded', label: 'Form URL Encoded' },
    { value: 'multipart', label: 'Multipart Form' },
    { value: 'binary', label: 'Binary' },
];

/** A raw body is JSON, or text with one of the content types below. */
type RawFormat = 'json' | TextContentType;

const RAW_FORMATS: Record<RawFormat, { label: string; language: string }> = {
    json: { label: 'JSON', language: 'json' },
    'text/plain': { label: 'Text', language: 'plaintext' },
    'application/xml': { label: 'XML', language: 'xml' },
    'text/html': { label: 'HTML', language: 'html' },
    'application/javascript': { label: 'JavaScript', language: 'javascript' },
};

const RAW_FORMAT_OPTIONS = (['json', ...TEXT_CONTENT_TYPES] as RawFormat[]).map((value) => ({
    value,
    label: RAW_FORMATS[value].label,
}));

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
    const rawEditor = useRef<editor.IStandaloneCodeEditor | null>(null);
    const raw = body.mode === 'json' || body.mode === 'text';
    const rawFormat: RawFormat = body.mode === 'json' ? 'json' : body.textContentType;
    const rawContent = body.mode === 'json' ? body.json : body.text;
    const error = useMemo(
        () => (body.mode === 'json' ? jsonError(body.json) : null),
        [body.mode, body.json],
    );

    const selectType = (type: BodyType) => {
        if (type !== 'raw') return setBody({ mode: type });
        if (raw) return;
        // Return to whichever raw format was used last.
        setBody({ mode: body.text.trim() && !body.json.trim() ? 'text' : 'json' });
    };
    // JSON and the text formats keep their content in different fields; the editor shows one
    // body, so switching format between them carries what is typed across.
    const selectFormat = (format: RawFormat) => {
        if (format === 'json') {
            setBody({ mode: 'json', json: body.mode === 'text' ? body.text : body.json });
        } else {
            setBody({
                mode: 'text',
                textContentType: format,
                text: body.mode === 'json' ? body.json : body.text,
            });
        }
    };
    const format = () => {
        const instance = rawEditor.current;
        if (!instance) return;
        if (rawFormat === 'application/xml') {
            const pretty = prettyXmlText(instance.getValue());
            if (pretty.ok) {
                instance.executeEdits('format', [
                    { range: instance.getModel()!.getFullModelRange(), text: pretty.text },
                ]);
            }
        } else {
            void instance.getAction('editor.action.formatDocument')?.run();
        }
    };
    const canFormat = rawFormat === 'json' || rawFormat === 'application/xml';
    const noBodyMethod = request.method === 'GET' || request.method === 'HEAD';

    return (
        <Stack gap="xs" className="min-h-0 flex-1">
            <Group gap="xs" justify="space-between" className="flex-none">
                <div className="no-scrollbar max-w-full min-w-0 overflow-x-auto">
                    <SegmentedControl
                        size="xs"
                        aria-label="Body type"
                        value={raw ? 'raw' : body.mode}
                        onChange={(type) => selectType(type as BodyType)}
                        data={MODES}
                    />
                </div>
                {raw && (
                    <Group gap={6} wrap="nowrap" className="flex-none">
                        {rawFormat === 'json' &&
                            (error ? (
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
                            ))}
                        {canFormat && (
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                color="gray"
                                leftSection={<IconWand size={13} />}
                                onClick={format}
                                title="Format (Shift+Alt+F)"
                            >
                                Format
                            </Button>
                        )}
                        <Select
                            size="xs"
                            aria-label="Raw body format"
                            value={rawFormat}
                            data={RAW_FORMAT_OPTIONS}
                            onChange={(value) => value && selectFormat(value as RawFormat)}
                            className="w-[130px]"
                        />
                    </Group>
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
            {raw && (
                <CodeEditor
                    className="min-h-40 flex-1"
                    language={RAW_FORMATS[rawFormat].language}
                    ariaLabel={`${RAW_FORMATS[rawFormat].label} body`}
                    value={rawContent}
                    onChange={(content) =>
                        setBody(body.mode === 'json' ? { json: content } : { text: content })
                    }
                    onEditor={(instance) => (rawEditor.current = instance)}
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
