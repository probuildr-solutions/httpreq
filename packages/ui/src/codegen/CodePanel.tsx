/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconAlertTriangle, IconCheck, IconCopy } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { defaultCodegen, generateCodeForRequest } from '@httpreq/codegen';
import { PROTOCOLS, protocolOf, type CodegenResult, type HttpRequest } from '@httpreq/shared';
import { pipelineContext } from '../app/pipelineContext';
import { CodeEditor } from '../editor/CodeEditor';
import { Alert, Button, CopyButton, Select, Stack, Switch, Text, notifications } from '../kit';
import { useWorkbenchStore } from '../store';

interface Props {
    request: HttpRequest;
}

/** The last target chosen, so the next request opens on it. Per-viewer convenience only. */
let lastGeneratorId = 'curl';

/**
 * Generated client code for the request as currently edited. Generation is the Code Generation
 * module's job; this panel only picks a target, shows the result in a read-only Monaco editor
 * and offers copy. Credentials are placeholders unless the user switches them on, and that
 * choice is not remembered.
 */
export function CodePanel({ request }: Props) {
    const protocol = protocolOf(request);
    const generators = useMemo(() => defaultCodegen.forProtocol(protocol), [protocol]);
    const [preferred, setPreferred] = useState(lastGeneratorId);
    const [includeSecrets, setIncludeSecrets] = useState(false);
    const [result, setResult] = useState<CodegenResult | null>(null);
    // Re-generate when the workspace changes too (an environment variable the request uses).
    const workspace = useWorkbenchStore((state) => state.workspace);

    // A target that does not exist for this protocol falls back to the protocol's first one.
    const generator = generators.find((item) => item.id === preferred) ?? generators[0];

    useEffect(() => {
        if (!generator) return;
        let live = true;
        // Typing in the editor is frequent and building a request is not free: wait for a pause.
        const timer = setTimeout(() => {
            void generateCodeForRequest(request, pipelineContext(), generator.id, {
                includeSecrets,
            }).then((next) => {
                if (live) setResult(next);
            });
        }, 200);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [request, generator, includeSecrets, workspace]);

    if (!generator) {
        return (
            <Alert color="yellow" variant="light" className="p-2">
                <Text size="xs">
                    Code generation is not available for {PROTOCOLS[protocol].label} requests.
                </Text>
            </Alert>
        );
    }

    const code = result?.supported ? result.code : '';

    return (
        <Stack gap="xs" className="min-h-0 flex-1">
            <div className="flex flex-wrap items-end gap-3">
                <Select
                    size="xs"
                    label="Language / framework"
                    aria-label="Code generation language"
                    value={generator.id}
                    data={generators.map((item) => ({ value: item.id, label: item.label }))}
                    onChange={(value) => {
                        if (!value) return;
                        lastGeneratorId = value;
                        setPreferred(value);
                    }}
                    className="w-[260px]"
                />
                <Switch
                    label="Include credentials"
                    checked={includeSecrets}
                    onChange={(event) => setIncludeSecrets(event.currentTarget.checked)}
                />
                <CopyButton value={code}>
                    {({ copied, copy }) => (
                        <Button
                            size="xs"
                            variant={copied ? 'light' : 'default'}
                            color={copied ? 'teal' : undefined}
                            leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                            disabled={!code}
                            onClick={() => {
                                copy();
                                notifications.show({
                                    color: 'teal',
                                    message: `${generator.label} code copied.`,
                                });
                            }}
                            className="ml-auto"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </Button>
                    )}
                </CopyButton>
            </div>

            {includeSecrets && (
                <Alert
                    color="yellow"
                    variant="light"
                    icon={<IconAlertTriangle size={16} />}
                    className="p-2"
                >
                    <Text size="xs">
                        The code below contains your real credentials. Do not paste it into shared
                        places.
                    </Text>
                </Alert>
            )}
            {result && !result.supported ? (
                <Alert color="gray" variant="light" className="p-2" role="status">
                    <Text size="xs">{result.reason}</Text>
                </Alert>
            ) : (
                <CodeEditor
                    className="min-h-48 flex-1"
                    language={generator.editorLanguage}
                    ariaLabel={`${generator.label} code`}
                    readOnly
                    value={code}
                />
            )}
            <Text size="xs" className="text-dimmed">
                {generators.length} target{generators.length === 1 ? '' : 's'} available for{' '}
                {PROTOCOLS[protocol].label}. Credentials are replaced by <code>{'<SECRET>'}</code>{' '}
                unless included.
            </Text>
        </Stack>
    );
}
