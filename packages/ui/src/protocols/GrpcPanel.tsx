/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconFilePlus, IconTrash, IconWand } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { describeProto, sampleRequestJson } from '@httpreq/api-client';
import {
    createGrpcConfig,
    type GrpcConfig,
    type HttpRequest,
    type ProtoDescription,
    type ProtoFile,
} from '@httpreq/shared';
import { useCapabilities } from '../capabilities';
import { CodeEditor } from '../editor/CodeEditor';
import {
    ActionIcon,
    Alert,
    Button,
    FileButton,
    NumberInput,
    Select,
    Stack,
    Text,
    Tooltip,
    cx,
} from '../kit';

interface Props {
    request: HttpRequest;
    onChange: (patch: Partial<HttpRequest>) => void;
}

const SECTION_LABEL = 'text-xs font-semibold tracking-wide text-dimmed uppercase';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * gRPC configuration: the `.proto` definition (service and method discovery), the request message
 * and the deadline. Metadata are the request's headers and live in the Headers tab.
 */
export function GrpcPanel({ request, onChange }: Props) {
    const config = request.grpc ?? createGrpcConfig();
    const capabilities = useCapabilities();
    const [selectedFile, setSelectedFile] = useState(0);
    const [fileError, setFileError] = useState<string | null>(null);

    const patchGrpc = (patch: Partial<GrpcConfig>) => onChange({ grpc: { ...config, ...patch } });

    const parsed = useMemo<{ value: ProtoDescription | null; error: string | null }>(() => {
        if (config.protoFiles.length === 0) return { value: null, error: null };
        try {
            return { value: describeProto(config.protoFiles), error: null };
        } catch (error) {
            return { value: null, error: (error as Error).message };
        }
    }, [config.protoFiles]);

    const service = parsed.value?.services.find((item) => item.fullName === config.service);
    const method = service?.methods.find((item) => item.name === config.method);
    const file = config.protoFiles[Math.min(selectedFile, config.protoFiles.length - 1)];

    const setFiles = (protoFiles: ProtoFile[]) => {
        // A changed definition may remove the chosen service or method; keep the choice only if it survives.
        let next: ProtoDescription | null = null;
        try {
            next = protoFiles.length ? describeProto(protoFiles) : null;
        } catch {
            next = null;
        }
        const keepService = next?.services.find((item) => item.fullName === config.service);
        const keepMethod = keepService?.methods.find((item) => item.name === config.method);
        patchGrpc({
            protoFiles,
            service: next ? (keepService ? config.service : '') : config.service,
            method: next ? (keepMethod ? config.method : '') : config.method,
        });
    };

    const addFiles = async (picked: File | null) => {
        if (!picked) return;
        if (picked.size > MAX_FILE_BYTES) {
            setFileError(`“${picked.name}” is larger than 2 MB.`);
            return;
        }
        setFileError(null);
        const content = await picked.text();
        const others = config.protoFiles.filter((item) => item.name !== picked.name);
        setFiles([...others, { name: picked.name, content }]);
        setSelectedFile(others.length);
    };

    const chooseMethod = (serviceName: string, methodName: string) => {
        const patch: Partial<GrpcConfig> = { service: serviceName, method: methodName };
        // A message the user has not written yet is replaced by a skeleton of the new input type.
        const empty = request.body.json.trim() === '' || request.body.json.trim() === '{}';
        if (empty && methodName) {
            try {
                onChange({
                    grpc: { ...config, ...patch },
                    body: {
                        ...request.body,
                        mode: 'json',
                        json: sampleRequestJson(config.protoFiles, serviceName, methodName),
                    },
                });
                return;
            } catch {
                // Fall through: the skeleton is a convenience, not a requirement.
            }
        }
        patchGrpc(patch);
    };

    const insertSample = () => {
        try {
            onChange({
                body: {
                    ...request.body,
                    mode: 'json',
                    json: sampleRequestJson(config.protoFiles, config.service, config.method),
                },
            });
        } catch (error) {
            setFileError((error as Error).message);
        }
    };

    return (
        <Stack gap="md" className="max-w-[900px]">
            {!capabilities.grpc && (
                <Alert color="yellow" variant="light" className="p-2">
                    <Text size="xs">
                        gRPC calls run in the HttpReq desktop app; a browser cannot speak native
                        gRPC. You can still edit this request here.
                    </Text>
                </Alert>
            )}

            <div>
                <div className="flex items-center justify-between">
                    <Text className={SECTION_LABEL}>Definition (.proto)</Text>
                    <div className="flex gap-1">
                        <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconFilePlus size={14} />}
                            onClick={() => {
                                const name = `service${config.protoFiles.length + 1}.proto`;
                                setFiles([
                                    ...config.protoFiles,
                                    { name, content: 'syntax = "proto3";\n\n' },
                                ]);
                                setSelectedFile(config.protoFiles.length);
                            }}
                        >
                            New file
                        </Button>
                        <FileButton accept=".proto,text/plain" onChange={(f) => void addFiles(f)}>
                            {(props) => (
                                <Button size="xs" variant="default" {...props}>
                                    Import .proto
                                </Button>
                            )}
                        </FileButton>
                    </div>
                </div>

                {config.protoFiles.length > 0 && (
                    <div
                        className="mt-1 flex flex-wrap gap-1"
                        role="tablist"
                        aria-label="Proto files"
                    >
                        {config.protoFiles.map((item, index) => (
                            <span
                                key={item.name + index}
                                className={cx(
                                    'inline-flex items-center gap-1 rounded-sm border border-line px-2 py-0.5 text-xs',
                                    file === item &&
                                        'border-primary bg-primary-soft text-primary-text',
                                )}
                            >
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={file === item}
                                    onClick={() => setSelectedFile(index)}
                                >
                                    {item.name}
                                </button>
                                <ActionIcon
                                    size="xs"
                                    variant="subtle"
                                    color="gray"
                                    aria-label={`Remove ${item.name}`}
                                    onClick={() => {
                                        setFiles(config.protoFiles.filter((_, i) => i !== index));
                                        setSelectedFile(0);
                                    }}
                                >
                                    <IconTrash size={12} />
                                </ActionIcon>
                            </span>
                        ))}
                    </div>
                )}

                {file ? (
                    <CodeEditor
                        className="mt-1 h-52"
                        language="protobuf"
                        ariaLabel={`${file.name} definition`}
                        value={file.content}
                        onChange={(content) =>
                            setFiles(
                                config.protoFiles.map((item) =>
                                    item === file ? { ...item, content } : item,
                                ),
                            )
                        }
                    />
                ) : (
                    <Text size="xs" className="text-dimmed mt-1">
                        Import a .proto file, or add a new one and paste the definition. Files it
                        imports (other than Google’s well-known types) must be added too.
                    </Text>
                )}
                {(fileError || parsed.error) && (
                    <Alert color="red" variant="light" className="mt-2 p-2">
                        <Text size="xs">{fileError ?? parsed.error}</Text>
                    </Alert>
                )}
            </div>

            {parsed.value && (
                <div className="grid grid-cols-1 gap-3 @lg/request-editor:grid-cols-2">
                    <Select
                        size="xs"
                        label="Service"
                        placeholder="Choose a service"
                        value={config.service || null}
                        onChange={(value) => chooseMethod(value ?? '', '')}
                        data={parsed.value.services.map((item) => ({
                            value: item.fullName,
                            label: item.fullName,
                        }))}
                    />
                    <Select
                        size="xs"
                        label="Method"
                        placeholder={service ? 'Choose a method' : 'Choose a service first'}
                        disabled={!service}
                        value={config.method || null}
                        onChange={(value) => chooseMethod(config.service, value ?? '')}
                        data={(service?.methods ?? []).map((item) => ({
                            value: item.name,
                            label:
                                item.name +
                                (item.clientStreaming && item.serverStreaming
                                    ? ' (bidirectional streaming)'
                                    : item.clientStreaming
                                      ? ' (client streaming)'
                                      : item.serverStreaming
                                        ? ' (server streaming)'
                                        : ''),
                        }))}
                    />
                </div>
            )}
            {method?.clientStreaming && (
                <Alert color="yellow" variant="light" className="p-2">
                    <Text size="xs">
                        Requests that stream from the client cannot be sent yet. Unary and
                        server-streaming methods are supported.
                    </Text>
                </Alert>
            )}

            <div className="flex flex-wrap items-end gap-3">
                <NumberInput
                    size="xs"
                    label="Deadline"
                    description="0 sets no deadline."
                    min={0}
                    step={1000}
                    suffix=" ms"
                    value={config.deadlineMs}
                    onChange={(value) =>
                        patchGrpc({ deadlineMs: typeof value === 'number' ? value : 0 })
                    }
                    className="w-[150px]"
                />
            </div>

            <div className="flex min-h-56 flex-col">
                <div className="flex items-center justify-between">
                    <Text className={SECTION_LABEL}>Message (JSON)</Text>
                    <Tooltip label="Replace the message with a skeleton of the method’s input type">
                        <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconWand size={14} />}
                            disabled={!method}
                            onClick={insertSample}
                        >
                            Generate sample
                        </Button>
                    </Tooltip>
                </div>
                <CodeEditor
                    className="mt-1 min-h-44 flex-1"
                    language="json"
                    ariaLabel="gRPC request message"
                    value={request.body.json}
                    onChange={(json) => onChange({ body: { ...request.body, mode: 'json', json } })}
                />
                <Text size="xs" className="text-dimmed mt-1">
                    Field names as declared in the .proto or in camelCase; 64-bit integers as
                    strings. Metadata is sent from the Metadata tab.
                </Text>
            </div>
        </Stack>
    );
}
