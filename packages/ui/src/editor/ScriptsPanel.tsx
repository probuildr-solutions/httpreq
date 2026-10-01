/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';
import type { HttpRequest, RequestScripts } from '@httpreq/shared';
import { CodeEditor } from './CodeEditor';
import { Alert, SegmentedControl, Stack, Text } from '../kit';

const STAGES: { value: keyof RequestScripts; label: string; hint: string }[] = [
    {
        value: 'preRequest',
        label: 'Pre-request',
        hint: 'Runs before the request is sent, e.g. to compute a signature or set a variable.',
    },
    {
        value: 'postResponse',
        label: 'Post-response',
        hint: 'Runs after the response arrives, e.g. to store a token from the body.',
    },
    {
        value: 'tests',
        label: 'Tests',
        hint: 'Assertions about the response, e.g. its status or JSON shape.',
    },
];

interface Props {
    request: HttpRequest;
    onChange: (patch: Partial<HttpRequest>) => void;
}

/**
 * Script editing for the three lifecycle stages. Execution is intentionally not available yet:
 * it will run in a sandbox behind the pipeline's `ScriptRunner` seam.
 */
export function ScriptsPanel({ request, onChange }: Props) {
    const [stage, setStage] = useState<keyof RequestScripts>('preRequest');
    const current = STAGES.find((item) => item.value === stage)!;
    return (
        <Stack gap="xs" className="min-h-0 flex-1">
            <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} className="p-2">
                <Text size="xs">
                    Script execution is coming soon. Scripts are saved with the request but are not
                    run when it is sent.
                </Text>
            </Alert>
            <SegmentedControl
                size="xs"
                aria-label="Script stage"
                value={stage}
                onChange={(value) => setStage(value as keyof RequestScripts)}
                data={STAGES.map(({ value, label }) => ({
                    value,
                    label: request.scripts[value].trim() ? `${label} ●` : label,
                }))}
                className="self-start"
            />
            <Text size="xs" className="text-dimmed">
                {current.hint}
            </Text>
            <CodeEditor
                key={stage}
                className="min-h-40 flex-1"
                language="javascript"
                ariaLabel={`${current.label} script`}
                value={request.scripts[stage]}
                onChange={(value) => onChange({ scripts: { ...request.scripts, [stage]: value } })}
            />
        </Stack>
    );
}
