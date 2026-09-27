import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSshProfile,
  type SshBridge,
  type SshConnectOptions,
  type SshSessionEvent,
  type TerminalSize,
} from '@httpreq/shared';
import { resetConnections, useConnectionsStore } from '../connections';
import { useWorkbenchStore } from '../store';
import { useSshManager } from './useSsh';

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

/** A bridge that records what crossed IPC and can push session events back. */
const createBridge = () => {
  const connects: SshConnectOptions[] = [];
  const disconnects: string[] = [];
  const resizes: { sessionId: string; size: TerminalSize }[] = [];
  let emit: ((sessionId: string, event: SshSessionEvent) => void) | null = null;
  let offEventCalls = 0;

  const bridge: SshBridge = {
    listSessions: async () => [],
    connect: async (options) => {
      connects.push(options);
      return { ok: true, value: undefined };
    },
    testConnection: async () => ({ ok: true, value: { banner: '' } }),
    disconnect: async (sessionId) => {
      disconnects.push(sessionId);
    },
    write: () => undefined,
    resize: (sessionId, size) => resizes.push({ sessionId, size }),
    pickPrivateKey: async () => null,
    setCredential: async () => true,
    hasCredential: async () => false,
    deleteCredential: async () => undefined,
    listKnownHosts: async () => [],
    forgetKnownHost: async () => undefined,
    resolveHostKey: () => undefined,
    onSessionEvent: (listener) => {
      emit = listener;
      return () => {
        emit = null;
        offEventCalls += 1;
      };
    },
    onHostKeyPrompt: () => () => undefined,
  };

  return {
    bridge,
    connects,
    disconnects,
    resizes,
    emit: (sessionId: string, event: SshSessionEvent) => emit?.(sessionId, event),
    get offEventCalls() {
      return offEventCalls;
    },
  };
};

const sessionState = (sessionId: string) => useConnectionsStore.getState().sessions[sessionId];

beforeEach(() => resetConnections());

describe('useSshManager', () => {
  it('replays output that arrived before the terminal mounted', async () => {
    const harness = createBridge();
    const { result } = renderHook(() => useSshManager(harness.bridge));

    let sessionId!: string;
    await act(async () => {
      sessionId = (await result.current.open(createSshProfile('Prod')))!;
    });
    // The shell greets before xterm has laid out; that output must not be dropped.
    act(() => harness.emit(sessionId, { type: 'data', data: 'Welcome\r\n$ ' }));

    const written: string[] = [];
    act(() => {
      result.current.onData(sessionId, (data) => written.push(data));
    });
    expect(written).toEqual(['Welcome\r\n$ ']);

    // Once a terminal is listening, output goes straight to it.
    act(() => harness.emit(sessionId, { type: 'data', data: 'ls\r\n' }));
    expect(written).toEqual(['Welcome\r\n$ ', 'ls\r\n']);
  });

  it('clears buffered output and the session state on disconnect', async () => {
    const harness = createBridge();
    const { result } = renderHook(() => useSshManager(harness.bridge));

    let sessionId!: string;
    await act(async () => {
      sessionId = (await result.current.open(createSshProfile('Prod')))!;
    });
    act(() => harness.emit(sessionId, { type: 'status', status: 'connected' }));
    act(() => harness.emit(sessionId, { type: 'data', data: 'secret output' }));

    await act(async () => {
      await result.current.disconnect(sessionId);
    });
    expect(harness.disconnects).toEqual([sessionId]);
    expect(sessionState(sessionId)).toMatchObject({ status: 'disconnected', startedAt: null });

    // A terminal opened afterwards must not be handed the previous session's output.
    const written: string[] = [];
    act(() => {
      result.current.onData(sessionId, (data) => written.push(data));
    });
    expect(written).toEqual([]);
  });

  it('reconnects into a new terminal generation, at the size the terminal reported', async () => {
    const harness = createBridge();
    const { result } = renderHook(() => useSshManager(harness.bridge));

    let sessionId!: string;
    await act(async () => {
      sessionId = (await result.current.open(createSshProfile('Prod')))!;
    });
    expect(sessionState(sessionId)?.generation).toBe(1);

    const size: TerminalSize = { cols: 132, rows: 43, width: 1100, height: 700 };
    act(() => result.current.resize(sessionId, size));
    act(() => harness.emit(sessionId, { type: 'data', data: 'old shell' }));

    await act(async () => {
      await result.current.reconnect(sessionId);
    });

    expect(harness.disconnects).toEqual([sessionId]);
    expect(harness.connects).toHaveLength(2);
    // The new shell starts at the size the terminal is actually laid out at, not a default.
    expect(harness.connects[1]!.size).toEqual(size);
    expect(sessionState(sessionId)).toMatchObject({ status: 'connecting', generation: 2 });

    const written: string[] = [];
    act(() => {
      result.current.onData(sessionId, (data) => written.push(data));
    });
    expect(written).toEqual([]);
  });

  it('reuses the open tab for a profile instead of opening another', async () => {
    const harness = createBridge();
    const { result } = renderHook(() => useSshManager(harness.bridge));
    const profile = createSshProfile('Prod');

    let first!: string;
    await act(async () => {
      first = (await result.current.open(profile))!;
    });
    act(() => harness.emit(first, { type: 'status', status: 'connected' }));
    const tabs = useWorkbenchStore.getState().openSshSessionIds.length;

    // Connected: the tab is focused, and the live shell is left alone.
    useWorkbenchStore.getState().setActiveSshSession(null);
    let second!: string | null;
    await act(async () => {
      second = await result.current.open(profile);
    });
    expect(second).toBe(first);
    expect(useWorkbenchStore.getState().openSshSessionIds).toHaveLength(tabs);
    expect(useWorkbenchStore.getState().activeSshSessionId).toBe(first);
    expect(harness.connects).toHaveLength(1);

    // Disconnected: the same tab connects again, in place.
    await act(async () => {
      await result.current.disconnect(first);
    });
    await act(async () => {
      second = await result.current.open(profile);
    });
    expect(second).toBe(first);
    expect(useWorkbenchStore.getState().openSshSessionIds).toHaveLength(tabs);
    expect(harness.connects).toHaveLength(2);
    expect(sessionState(first)).toMatchObject({ status: 'connecting', generation: 2 });
  });

  it('forgets everything a closed session owned', async () => {
    const harness = createBridge();
    const { result } = renderHook(() => useSshManager(harness.bridge));

    let sessionId!: string;
    await act(async () => {
      sessionId = (await result.current.open(createSshProfile('Prod')))!;
    });
    await act(async () => {
      await result.current.close(sessionId);
    });

    expect(sessionState(sessionId)).toBeUndefined();
    // With the profile forgotten there is nothing to reconnect, so no second connect is made.
    await act(async () => {
      await result.current.reconnect(sessionId);
    });
    expect(harness.connects).toHaveLength(1);
  });

  it('drops its IPC subscription when the app unmounts', () => {
    const harness = createBridge();
    const { unmount } = renderHook(() => useSshManager(harness.bridge));
    expect(harness.offEventCalls).toBe(0);
    unmount();
    expect(harness.offEventCalls).toBe(1);
  });

  it('does nothing at all without a bridge, as in the browser', async () => {
    const { result } = renderHook(() => useSshManager(undefined));
    expect(result.current.available).toBe(false);
    await act(async () => {
      expect(await result.current.open(createSshProfile('Prod'))).toBeNull();
    });
    expect(useConnectionsStore.getState().sessions).toEqual({});
    expect((await result.current.test(createSshProfile('Prod')))?.code).toBe('SSH_UNAVAILABLE');
  });
});
