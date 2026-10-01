/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultCodegen, generateCodeForRequest } from '@httpreq/codegen';
import {
    protocolOf,
    type CodeGenerator,
    type CodegenResult,
    type HttpRequest,
    type ProtocolId,
} from '@httpreq/shared';
import { pipelineContext } from '../app/pipelineContext';
import { usePreferences } from '../preferences';
import { useWorkbenchStore } from '../store';

/** How long typing must pause before the code is regenerated: building a request is not free. */
const REGENERATE_DELAY_MS = 200;

/**
 * The target to show for a request: the one the user last chose if this protocol has it, else one
 * in the same language (JavaScript for gRPC when `fetch` was chosen for HTTP), else the first.
 */
export const pickGenerator = (
    generators: readonly CodeGenerator[],
    preferredId: string,
): CodeGenerator | undefined => {
    const exact = generators.find((generator) => generator.id === preferredId);
    if (exact) return exact;
    const language = defaultCodegen.get(preferredId)?.language;
    return generators.find((generator) => generator.language === language) ?? generators[0];
};

export interface CodeGeneration {
    protocol: ProtocolId;
    generators: readonly CodeGenerator[];
    /** The selected target; undefined when the protocol has none. */
    generator: CodeGenerator | undefined;
    select: (id: string) => void;
    /** The latest result, or null before the first one arrives. */
    result: CodegenResult | null;
    /** The generated code, empty while there is none. */
    code: string;
}

/**
 * Generates code for a request as it is edited. Only the code generation popover uses it, and it
 * is mounted only while the popover is open, so nothing is generated for a closed one. Results
 * that arrive after the inputs changed again are dropped.
 */
export function useCodeGeneration(request: HttpRequest, includeSecrets: boolean): CodeGeneration {
    const protocol = protocolOf(request);
    const generators = useMemo(() => defaultCodegen.forProtocol(protocol), [protocol]);
    const preferred = usePreferences((state) => state.codeLanguage);
    const select = usePreferences((state) => state.setCodeLanguage);
    const generator = useMemo(() => pickGenerator(generators, preferred), [generators, preferred]);
    // An environment variable the request uses may change too.
    const workspace = useWorkbenchStore((state) => state.workspace);
    const [result, setResult] = useState<CodegenResult | null>(null);

    // Choosing another target or toggling credentials is a deliberate act and shows its result at
    // once; only edits to the request are debounced, since they arrive as fast as the user types.
    const shown = useRef<{ generator: typeof generator; includeSecrets: boolean } | null>(null);
    useEffect(() => {
        if (!generator) return;
        let live = true;
        const deliberate =
            !shown.current ||
            shown.current.generator !== generator ||
            shown.current.includeSecrets !== includeSecrets;
        shown.current = { generator, includeSecrets };
        const timer = setTimeout(
            () => {
                void generateCodeForRequest(request, pipelineContext(), generator.id, {
                    includeSecrets,
                }).then((next) => {
                    if (live) setResult(next);
                });
            },
            deliberate ? 0 : REGENERATE_DELAY_MS,
        );
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [request, generator, includeSecrets, workspace]);

    return {
        protocol,
        generators,
        generator,
        select,
        result,
        code: result?.supported ? result.code : '',
    };
}
