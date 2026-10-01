/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useCallback, type RefObject } from 'react';
import {
    ElectronGrpcRuntime,
    executeProtocolRequest,
    UnavailableGrpcRuntime,
} from '@httpreq/api-client';
import {
    createId,
    protocolOf,
    type ExecutionHooks,
    type HistoryEntry,
    type GrpcRuntime,
    type HttpRuntime,
    type SseEvent,
} from '@httpreq/shared';
import { reportRequestConnectivity } from '../connectivity';
import { notifications } from '../kit';
import { createScriptSession } from '../scripts/session';
import { activeEnvironment, editableRequest, useWorkbenchStore } from '../store';
import type { useRequestExecution } from '../useRequestExecution';
import { pipelineContext } from './pipelineContext';

const electronGrpc = new ElectronGrpcRuntime();
const unavailableGrpc = new UnavailableGrpcRuntime();
/** gRPC runs through the desktop bridge when there is one; a browser says so on use. */
const grpcRuntime = (): GrpcRuntime => (window.httpreq?.grpc ? electronGrpc : unavailableGrpc);

/** Failures that mean the machine, not the server, could not be reached. */
const NETWORK_ERRORS = new Set(['NETWORK_ERROR', 'DNS_ERROR', 'CONNECTION_TIMEOUT']);

interface Options {
    runtime: HttpRuntime;
    runExecution: ReturnType<typeof useRequestExecution>['send'];
    recordHistory: (entry: HistoryEntry) => void;
    /** The response pane, focused when a request is sent with "Send and focus response". */
    responseRef: RefObject<HTMLElement | null>;
}

/**
 * Sends the active request and reports what happened: the response lands in the store, the
 * history gains an entry (with the unresolved URL, so secrets never reach it), connectivity is
 * updated, and warnings or failures are surfaced as notifications.
 */
export function useSendRequest({ runtime, runExecution, recordHistory, responseRef }: Options) {
    const setResponse = useWorkbenchStore((state) => state.setResponse);
    return useCallback(
        async (focusResponse = false) => {
            const state = useWorkbenchStore.getState();
            const request = editableRequest(state, state.activeRequestId);
            if (!request) return;
            if (protocolOf(request) === 'mqtt') {
                notifications.show({
                    color: 'yellow',
                    message: 'An MQTT request connects to a broker: use Connect, then Publish.',
                });
                return;
            }
            if (focusResponse) responseRef.current?.focus();
            const session = createScriptSession(request, activeEnvironment(state.workspace));
            const context = { ...pipelineContext(), ...(session ? { scripts: session } : {}) };
            // Events of an open stream are shown as they arrive, batched so a fast stream cannot make
            // the window re-render on every message.
            const queued: SseEvent[] = [];
            let flushTimer: ReturnType<typeof setTimeout> | undefined;
            const flush = () => {
                flushTimer = undefined;
                if (queued.length) state.appendStreamEvents(request.id, queued.splice(0));
            };
            const hooks: ExecutionHooks = {
                onStreamStart: (head) => state.startStream(request.id, head),
                onStreamEvents: (events) => {
                    queued.push(...events);
                    flushTimer ??= setTimeout(flush, 60);
                },
            };
            const outcome = await runExecution(request.id, (signal) =>
                executeProtocolRequest(
                    request,
                    context,
                    { http: runtime, grpc: grpcRuntime() },
                    signal,
                    hooks,
                ),
            );
            // What the scripts did is kept even when the send failed (a failing script is why).
            if (session) {
                const report = session.report();
                state.setScriptReport(request.id, report);
                state.applyScriptEnvironment(report.environmentChanges);
            } else state.setScriptReport(request.id, undefined);
            clearTimeout(flushTimer);
            const entry: HistoryEntry = {
                id: createId(),
                requestId: request.id,
                name: request.name,
                method: request.method,
                // The unresolved template, so resolved secrets never reach history.
                url: request.url,
                status: null,
                statusText: '',
                durationMs: null,
                sizeBytes: null,
                timestamp: new Date().toISOString(),
            };
            if (outcome.kind === 'success') {
                const { response, warnings } = outcome.value;
                setResponse(request.id, response);
                state.endStream(request.id);
                reportRequestConnectivity('success');
                recordHistory({
                    ...entry,
                    status: response.status,
                    statusText: response.statusText,
                    durationMs: response.durationMs,
                    sizeBytes: response.sizeBytes,
                });
                const notes = [...warnings];
                if (response.truncated) {
                    notes.push(
                        `The response was cut at ${request.settings.responseSizeLimitMb} MB (Settings › Response size limit).`,
                    );
                }
                if (notes.length)
                    notifications.show({
                        color: 'yellow',
                        title: 'Sent with warnings',
                        message: notes.join(' '),
                    });
            } else if (outcome.kind === 'cancelled') {
                state.endStream(request.id);
                notifications.show({ color: 'yellow', message: 'Request cancelled.' });
            } else {
                state.endStream(request.id);
                if (outcome.code && NETWORK_ERRORS.has(outcome.code))
                    reportRequestConnectivity('network-error');
                recordHistory({ ...entry, error: outcome.message });
                notifications.show({
                    color: 'red',
                    title: 'Request failed',
                    message: outcome.message,
                });
            }
        },
        [runExecution, runtime, setResponse, recordHistory, responseRef],
    );
}
