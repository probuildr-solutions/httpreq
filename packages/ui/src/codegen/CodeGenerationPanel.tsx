/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconCheck, IconCopy, IconDownload, IconLock, IconLockOpen } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { PROTOCOLS, type HttpRequest } from '@httpreq/shared';
import { downloadText } from '../exchange';
import { CodeEditor } from '../editor/CodeEditor';
import { ActionIcon, Button, CopyButton, Select, Text, Tooltip, cx, notifications } from '../kit';
import { useCodeGeneration } from './useCodeGeneration';

interface Props {
    request: HttpRequest;
    className?: string;
}

/**
 * The contents of the code generation popover: a language selector, the generated code in a
 * read-only editor, and the actions on it (copy, save as a file, include credentials). Choosing
 * and generating is `useCodeGeneration`'s job and the code itself comes from the codegen package,
 * so this component only lays them out.
 *
 * Credentials are placeholders unless the user switches them on, and that choice is never
 * remembered: it applies to this opening of the popover only.
 */
export function CodeGenerationPanel({ request, className }: Props) {
    const [includeSecrets, setIncludeSecrets] = useState(false);
    const { protocol, generators, generator, select, result, code } = useCodeGeneration(
        request,
        includeSecrets,
    );
    const options = useMemo(
        () => generators.map((item) => ({ value: item.id, label: item.label })),
        [generators],
    );

    if (!generator) {
        return (
            <Text size="xs" className={cx('text-dimmed p-1', className)} role="status">
                Code generation is not available for {PROTOCOLS[protocol].label} requests.
            </Text>
        );
    }

    const save = () => {
        // A trailing newline is conventional in a source file; the editor does not show one.
        downloadText(`request.${generator.fileExtension}`, `${code}\n`, 'text/plain');
    };

    return (
        <div className={cx('flex min-h-0 flex-col gap-1.5', className)}>
            <div className="flex items-center gap-1">
                <Select
                    size="xs"
                    aria-label="Code generation language"
                    value={generator.id}
                    data={options}
                    onChange={(value) => value && select(value)}
                    menuWidth={240}
                    className="w-[210px] min-w-0 flex-none"
                />
                <span className="flex-1" />
                <Tooltip
                    label={
                        includeSecrets
                            ? 'Credentials are included. Select to hide them'
                            : 'Credentials are hidden. Select to include them'
                    }
                >
                    <ActionIcon
                        variant={includeSecrets ? 'light' : 'default'}
                        color={includeSecrets ? 'yellow' : undefined}
                        size={30}
                        aria-label="Include credentials"
                        aria-pressed={includeSecrets}
                        onClick={() => setIncludeSecrets((current) => !current)}
                    >
                        {includeSecrets ? <IconLockOpen size={15} /> : <IconLock size={15} />}
                    </ActionIcon>
                </Tooltip>
                <Tooltip label={`Save as request.${generator.fileExtension}`}>
                    <ActionIcon
                        variant="default"
                        size={30}
                        aria-label="Save code as a file"
                        disabled={!code}
                        onClick={save}
                    >
                        <IconDownload size={15} />
                    </ActionIcon>
                </Tooltip>
                <CopyButton value={code}>
                    {({ copied, copy }) => (
                        <Button
                            size="xs"
                            variant={copied ? 'light' : 'filled'}
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
                            className="w-[84px]"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </Button>
                    )}
                </CopyButton>
            </div>

            {result && !result.supported ? (
                <Text
                    size="xs"
                    role="status"
                    className="text-dimmed h-[300px] rounded-sm border border-line bg-chrome p-3"
                >
                    {result.reason}
                </Text>
            ) : (
                <CodeEditor
                    className="h-[min(300px,45vh)] min-h-32"
                    language={generator.editorLanguage}
                    ariaLabel={`${generator.label} code`}
                    readOnly
                    value={code}
                />
            )}

            <Text
                size="xs"
                className={cx('truncate', includeSecrets ? 'text-warning-text' : 'text-dimmed')}
            >
                {includeSecrets
                    ? 'Contains your real credentials. Do not paste it into shared places.'
                    : [generator.requirements, 'Credentials are replaced by <SECRET>.']
                          .filter(Boolean)
                          .join(' · ')}
            </Text>
        </div>
    );
}
