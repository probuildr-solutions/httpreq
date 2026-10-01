/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconFileImport, IconWorldDownload } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { parseWsdl, xmlProblem } from '@httpreq/api-client';
import {
    createSoapConfig,
    SOAP_VERSIONS,
    type HttpRequest,
    type SoapConfig,
    type WsdlDescription,
} from '@httpreq/shared';
import { CodeEditor } from '../editor/CodeEditor';
import {
    Alert,
    Button,
    FileButton,
    Select,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
    Tooltip,
} from '../kit';
import { useProtocolServices } from './services';

interface Props {
    request: HttpRequest;
    onChange: (patch: Partial<HttpRequest>) => void;
}

const SECTION_LABEL = 'text-xs font-semibold tracking-wide text-dimmed uppercase';

/**
 * SOAP configuration: version, action, header blocks, WSDL discovery and the XML body. The body
 * is the content of `<Body>`; a complete envelope pasted here is sent as it is.
 */
export function SoapPanel({ request, onChange }: Props) {
    const config = request.soap ?? createSoapConfig();
    const services = useProtocolServices();
    const [wsdlUrl, setWsdlUrl] = useState(config.wsdlUrl);
    const [loading, setLoading] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);

    const patchSoap = (patch: Partial<SoapConfig>) => onChange({ soap: { ...config, ...patch } });

    const description = useMemo<{ value: WsdlDescription | null; error: string | null }>(() => {
        if (!config.wsdl) return { value: null, error: null };
        try {
            return { value: parseWsdl(config.wsdl), error: null };
        } catch (error) {
            return { value: null, error: (error as Error).message };
        }
    }, [config.wsdl]);

    const bodyProblem = useMemo(() => xmlProblem(request.body.text), [request.body.text]);
    const headerProblem = useMemo(() => xmlProblem(config.headerXml), [config.headerXml]);

    const importWsdl = (text: string, source: string) => {
        try {
            parseWsdl(text);
        } catch (error) {
            setImportError((error as Error).message);
            return;
        }
        setImportError(null);
        patchSoap({ wsdl: text, wsdlUrl: source, operation: '' });
    };

    const fetchWsdl = async () => {
        setLoading(true);
        setImportError(null);
        try {
            importWsdl(await services.fetchText(wsdlUrl), wsdlUrl.trim());
        } catch (error) {
            setImportError((error as Error).message);
        } finally {
            setLoading(false);
        }
    };

    const readFile = async (file: File | null) => {
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            setImportError('The file is larger than 5 MB.');
            return;
        }
        importWsdl(await file.text(), '');
    };

    const chooseOperation = (id: string | null) => {
        const operation = description.value?.operations.find((item) => item.id === id);
        if (!operation) return;
        onChange({
            soap: {
                ...config,
                operation: operation.id,
                action: operation.soapAction,
                version: operation.version,
            },
            // The endpoint fills an empty URL; one the user already typed is left alone.
            ...(request.url.trim() === '' && operation.endpoint ? { url: operation.endpoint } : {}),
            body: {
                ...request.body,
                mode: 'text',
                textContentType: 'application/xml',
                text: request.body.text.trim() === '' ? operation.sampleBody : request.body.text,
            },
        });
    };

    const selected = description.value?.operations.find((item) => item.id === config.operation);

    return (
        <Stack gap="md" className="max-w-[900px]">
            <div className="grid grid-cols-1 gap-3 @lg/request-editor:grid-cols-[auto_1fr]">
                <div>
                    <Text className={SECTION_LABEL}>Version</Text>
                    <SegmentedControl
                        size="xs"
                        aria-label="SOAP version"
                        value={config.version}
                        onChange={(value) => patchSoap({ version: value as SoapConfig['version'] })}
                        data={SOAP_VERSIONS.map((version) => ({ value: version, label: version }))}
                    />
                </div>
                <TextInput
                    size="xs"
                    label="SOAP action"
                    description={
                        config.version === '1.2'
                            ? 'Sent as the action parameter of the Content-Type.'
                            : 'Sent as the SOAPAction header.'
                    }
                    placeholder="http://tempuri.org/Add"
                    value={config.action}
                    onChange={(event) => patchSoap({ action: event.currentTarget.value })}
                />
            </div>

            <div>
                <Text className={SECTION_LABEL}>WSDL</Text>
                <div className="mt-1 flex flex-wrap items-end gap-2">
                    <TextInput
                        size="xs"
                        aria-label="WSDL URL"
                        placeholder="https://example.com/service?wsdl"
                        value={wsdlUrl}
                        onChange={(event) => setWsdlUrl(event.currentTarget.value)}
                        className="min-w-[220px] flex-1"
                    />
                    <Button
                        size="xs"
                        variant="default"
                        leftSection={<IconWorldDownload size={14} />}
                        loading={loading}
                        disabled={!wsdlUrl.trim()}
                        onClick={() => void fetchWsdl()}
                    >
                        Fetch
                    </Button>
                    <FileButton
                        accept=".wsdl,.xml,text/xml,application/xml"
                        onChange={(f) => void readFile(f)}
                    >
                        {(props) => (
                            <Tooltip label="Load a WSDL file from disk">
                                <Button
                                    size="xs"
                                    variant="default"
                                    leftSection={<IconFileImport size={14} />}
                                    {...props}
                                >
                                    Open file
                                </Button>
                            </Tooltip>
                        )}
                    </FileButton>
                </div>
                {importError && (
                    <Alert color="red" variant="light" className="mt-2 p-2">
                        <Text size="xs">{importError}</Text>
                    </Alert>
                )}
                {description.error && !importError && (
                    <Alert color="yellow" variant="light" className="mt-2 p-2">
                        <Text size="xs">{description.error}</Text>
                    </Alert>
                )}
                {description.value && (
                    <div className="mt-2">
                        <Select
                            size="xs"
                            label="Operation"
                            placeholder="Choose an operation"
                            value={config.operation || null}
                            onChange={chooseOperation}
                            data={description.value.operations.map((operation) => ({
                                value: operation.id,
                                label: `${operation.name} (SOAP ${operation.version})`,
                            }))}
                        />
                        {selected?.documentation && (
                            <Text size="xs" className="text-dimmed mt-1">
                                {selected.documentation}
                            </Text>
                        )}
                        {selected && (
                            <Button
                                size="xs"
                                variant="subtle"
                                className="mt-1"
                                onClick={() =>
                                    onChange({
                                        body: { ...request.body, text: selected.sampleBody },
                                    })
                                }
                            >
                                Insert sample body
                            </Button>
                        )}
                    </div>
                )}
            </div>

            <div>
                <Text className={SECTION_LABEL}>Envelope header (optional)</Text>
                <Text size="xs" className="text-dimmed">
                    XML blocks placed inside &lt;Header&gt;, e.g. WS-Security.
                </Text>
                <CodeEditor
                    className="mt-1 h-28"
                    language="xml"
                    ariaLabel="SOAP header XML"
                    value={config.headerXml}
                    onChange={(headerXml) => patchSoap({ headerXml })}
                />
                {headerProblem && (
                    <Text size="xs" className="mt-1 text-red-6" role="alert">
                        {headerProblem}
                    </Text>
                )}
            </div>

            <div className="flex min-h-56 flex-col">
                <Text className={SECTION_LABEL}>Body</Text>
                <Text size="xs" className="text-dimmed">
                    The XML inside &lt;Body&gt;. Paste a complete &lt;Envelope&gt; to send it
                    unchanged.
                </Text>
                <CodeEditor
                    className="mt-1 min-h-44 flex-1"
                    language="xml"
                    ariaLabel="SOAP body XML"
                    value={request.body.text}
                    onChange={(text) =>
                        onChange({
                            body: {
                                ...request.body,
                                mode: 'text',
                                textContentType: 'application/xml',
                                text,
                            },
                        })
                    }
                />
                {bodyProblem && (
                    <Text size="xs" className="mt-1 text-red-6" role="alert">
                        {bodyProblem}
                    </Text>
                )}
            </div>
        </Stack>
    );
}
