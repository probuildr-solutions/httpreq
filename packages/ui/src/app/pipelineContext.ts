/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { PipelineContext } from '@httpreq/api-client';
import { readAttachment } from '../attachments';
import { activeEnvironment, useWorkbenchStore } from '../store';

/**
 * What the request pipeline needs from the workspace at the moment a request is built: the
 * workspace itself, the active environment and a way to read attached files. Read on demand from
 * the store (not captured) so a request always sees the state at the time it is sent.
 */
export const pipelineContext = (): PipelineContext => {
    const { workspace } = useWorkbenchStore.getState();
    return { workspace, environment: activeEnvironment(workspace), readFile: readAttachment };
};
