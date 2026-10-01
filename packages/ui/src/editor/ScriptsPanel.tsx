/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconShieldLock } from '@tabler/icons-react';
import { useState } from 'react';
import {
    SCRIPT_STAGES,
    SCRIPT_STAGE_LABELS,
    type HttpRequest,
    type ScriptStage,
} from '@httpreq/shared';
import { CodeEditor } from './CodeEditor';
import { Alert, Button, SegmentedControl, Stack, Text } from '../kit';

const HINTS: Record<ScriptStage, string> = {
    preRequest:
        'Runs after variables and authorization are applied, before the request is sent: sign it, add a header, change the body.',
    postResponse:
        'Runs after the response arrives: store a token from the body in the environment.',
    tests: 'Assertions about the response. Each test passes or fails on its own.',
};

const EXAMPLES: Record<ScriptStage, string> = {
    preRequest: `// httpreq.request: method, url, body, headers.get/set/remove
httpreq.request.headers.set('X-Request-Id', httpreq.utils.uuid());
httpreq.request.headers.set('X-Timestamp', String(httpreq.utils.timestamp()));
`,
    postResponse: `// httpreq.response: status, headers.get, text(), json(), responseTime
const body = httpreq.response.json();
httpreq.environment.set('token', body.token);
`,
    tests: `test('responds with 200', () => {
    expect(httpreq.response.status).to.equal(200);
});

test('returns JSON with an id', () => {
    expect(httpreq.response.json()).to.have.property('id');
});
`,
};

interface Props {
    request: HttpRequest;
    onChange: (patch: Partial<HttpRequest>) => void;
}

/**
 * Script editing for the request lifecycle. Scripts run in an isolated interpreter that has no
 * access to the network, files, the application or the operating system; they only see the
 * request, the response, the environment and a small set of helpers.
 */
export function ScriptsPanel({ request, onChange }: Props) {
    const [stage, setStage] = useState<ScriptStage>('preRequest');
    const code = request.scripts[stage];
    return (
        <Stack gap="xs" className="min-h-0 flex-1">
            <Alert variant="light" color="gray" icon={<IconShieldLock size={16} />} className="p-2">
                <Text size="xs">
                    Scripts run in a sandbox: no network, files or application access, a time limit
                    of a few seconds and a memory cap. Use <code>httpreq.request</code>,{' '}
                    <code>httpreq.response</code>, <code>httpreq.environment</code>,{' '}
                    <code>httpreq.variables</code>, <code>test()</code>, <code>expect()</code> and{' '}
                    <code>httpreq.utils</code>.
                </Text>
            </Alert>
            <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                    size="xs"
                    aria-label="Script stage"
                    value={stage}
                    onChange={(value) => setStage(value as ScriptStage)}
                    data={SCRIPT_STAGES.map((value) => ({
                        value,
                        label: request.scripts[value].trim()
                            ? `${SCRIPT_STAGE_LABELS[value]} ●`
                            : SCRIPT_STAGE_LABELS[value],
                    }))}
                />
                {!code.trim() && (
                    <Button
                        size="xs"
                        variant="subtle"
                        onClick={() =>
                            onChange({ scripts: { ...request.scripts, [stage]: EXAMPLES[stage] } })
                        }
                    >
                        Insert example
                    </Button>
                )}
            </div>
            <Text size="xs" className="text-dimmed">
                {HINTS[stage]}
            </Text>
            <CodeEditor
                key={stage}
                className="min-h-40 flex-1"
                language="javascript"
                purpose={{ kind: 'script', stage }}
                ariaLabel={`${SCRIPT_STAGE_LABELS[stage]} script`}
                value={code}
                onChange={(value) => onChange({ scripts: { ...request.scripts, [stage]: value } })}
            />
        </Stack>
    );
}
