import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { notifications } from '@mantine/notifications';
import { createVariableResolver } from '@httpreq/api-client';
import {
  createId,
  sshErrorOf,
  type HostKeyDecision,
  type HostKeyPrompt,
  type SshBridge,
  type SshErrorInfo,
  type SshProfile,
  type TerminalSize,
} from '@httpreq/shared';
import { useConnectionsStore } from '../connections';
import { activeEnvironment, useWorkbenchStore } from '../store';

/**
 * The renderer's view of SSH.
 *
 * Nothing here holds a credential: a password or passphrase is handed to the bridge once, on save,
 * and from then on the main process looks it up in the OS vault by the profile's `credentialId`.
 * Host and username may contain `{{variables}}`, which are resolved here, against the active
 * environment, before the profile crosses IPC.
 *
 * This hook also owns everything a terminal needs but cannot keep itself: the output that arrives
 * before the terminal has mounted, the size the shell was last laid out at, and the generation
 * that makes a reconnect build a fresh terminal rather than continue the previous one.
 */

export interface PendingHostKey {
  promptId: string;
  prompt: HostKeyPrompt;
}

export interface SshApi {
  /** Null in the browser, and in a desktop build whose SSH bridge failed to load. */
  readonly available: boolean;
  /**
   * Connects a profile in its terminal tab: the tab already open for it when there is one (which
   * is focused and reconnected if needed), a new one otherwise. Returns the session id, or null
   * when unavailable.
   */
  open: (profile: SshProfile) => Promise<string | null>;
  disconnect: (sessionId: string) => Promise<void>;
  /** Closes the session and its tab. */
  close: (sessionId: string) => Promise<void>;
  reconnect: (sessionId: string) => Promise<void>;
  write: (sessionId: string, data: string) => void;
  resize: (sessionId: string, size: TerminalSize) => void;
  test: (profile: SshProfile) => Promise<SshErrorInfo | null>;
  pickPrivateKey: () => Promise<string | null>;
  setCredential: (credentialId: string, secret: string) => Promise<boolean>;
  hasCredential: (credentialId: string) => Promise<boolean>;
  deleteCredential: (credentialId: string) => Promise<void>;
  /**
   * Subscribes to terminal output for one session. Output that arrived before the terminal was
   * mounted is replayed to the first listener, so a shell's banner and first prompt are not lost
   * in the gap between the session opening and xterm laying out. Returns an unsubscribe function.
   */
  onData: (sessionId: string, listener: (data: string) => void) => () => void;
  /** The host-key question currently awaiting an answer, if any. */
  pendingHostKey: PendingHostKey | null;
  answerHostKey: (decision: HostKeyDecision) => void;
  closeAll: () => Promise<void>;
}

export const SshContext = createContext<SshApi | null>(null);

export const useSsh = (): SshApi => {
  const api = useContext(SshContext);
  if (!api) throw new Error('useSsh must be used inside the HttpReq application.');
  return api;
};

/** Substitutes `{{variables}}` in the fields a connection actually uses. */
export const resolveSshProfile = (profile: SshProfile): SshProfile => {
  const resolver = createVariableResolver(
    activeEnvironment(useWorkbenchStore.getState().workspace),
  );
  return {
    ...profile,
    host: resolver.resolve(profile.host).trim(),
    username: resolver.resolve(profile.username).trim(),
  };
};

/** Used until the terminal reports the size it actually laid out at. */
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24, width: 640, height: 384 };

/** Enough to hold a login banner and a prompt; a terminal that never mounts cannot grow a leak. */
const MAX_BUFFERED_CHARS = 64 * 1024;

const UNAVAILABLE: SshApi = {
  available: false,
  open: async () => null,
  disconnect: async () => undefined,
  close: async () => undefined,
  reconnect: async () => undefined,
  write: () => undefined,
  resize: () => undefined,
  test: async () => sshErrorOf('SSH_UNAVAILABLE'),
  pickPrivateKey: async () => null,
  setCredential: async () => false,
  hasCredential: async () => false,
  deleteCredential: async () => undefined,
  onData: () => () => undefined,
  pendingHostKey: null,
  answerHostKey: () => undefined,
  closeAll: async () => undefined,
};

export function useSshManager(bridge: SshBridge | undefined): SshApi {
  const [pendingHostKey, setPendingHostKey] = useState<PendingHostKey | null>(null);
  /** Terminal output listeners, one per mounted terminal. */
  const dataListeners = useRef(new Map<string, Set<(data: string) => void>>());
  /** Output for sessions whose terminal has not mounted (or has been unmounted) yet. */
  const pendingOutput = useRef(new Map<string, string>());
  /** The profile each session was opened with, so "Reconnect" needs no lookup. */
  const sessionProfiles = useRef(new Map<string, SshProfile>());
  /** The size each terminal last laid out at, so a reconnect starts the shell at it. */
  const sessionSizes = useRef(new Map<string, TerminalSize>());

  /** Everything a session owns in this hook, dropped in one place. */
  const forgetSessionResources = useCallback((sessionId: string) => {
    pendingOutput.current.delete(sessionId);
    sessionSizes.current.delete(sessionId);
    sessionProfiles.current.delete(sessionId);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    const offEvent = bridge.onSessionEvent((sessionId, event) => {
      const connections = useConnectionsStore.getState();
      switch (event.type) {
        case 'status':
          connections.patchSession(sessionId, {
            status: event.status,
            ...(event.status === 'connected'
              ? { error: null, startedAt: new Date().toISOString() }
              : {}),
          });
          break;
        case 'data': {
          const listeners = dataListeners.current.get(sessionId);
          if (listeners?.size) {
            for (const listener of listeners) listener(event.data);
          } else {
            // No terminal is mounted yet; keep the tail of the output for the one that will be.
            const buffered = (pendingOutput.current.get(sessionId) ?? '') + event.data;
            pendingOutput.current.set(
              sessionId,
              buffered.length > MAX_BUFFERED_CHARS
                ? buffered.slice(buffered.length - MAX_BUFFERED_CHARS)
                : buffered,
            );
          }
          break;
        }
        case 'error':
          connections.patchSession(sessionId, { status: 'error', error: event.error });
          break;
        case 'closed':
          connections.patchSession(sessionId, { status: 'disconnected' });
          break;
      }
    });
    const offPrompt = bridge.onHostKeyPrompt((promptId, prompt) =>
      setPendingHostKey({ promptId, prompt }),
    );
    return () => {
      offEvent();
      offPrompt();
    };
  }, [bridge]);

  const answerHostKey = useCallback(
    (decision: HostKeyDecision) => {
      setPendingHostKey((current) => {
        if (current && bridge) bridge.resolveHostKey(current.promptId, decision);
        return null;
      });
    },
    [bridge],
  );

  /** Starts a shell for a session that is already registered, at the size it was last laid out. */
  const start = useCallback(
    async (sessionId: string, profile: SshProfile) => {
      if (!bridge) return;
      const result = await bridge.connect({
        sessionId,
        profile: resolveSshProfile(profile),
        size: sessionSizes.current.get(sessionId) ?? DEFAULT_SIZE,
      });
      if (!result.ok) {
        useConnectionsStore
          .getState()
          .patchSession(sessionId, { status: 'error', error: result.error });
      }
    },
    [bridge],
  );

  /**
   * Ends the shell and clears everything that belonged to it, so the view falls back to its
   * disconnected state and the next connection cannot inherit this one's output.
   */
  const disconnect = useCallback(
    async (sessionId: string) => {
      await bridge?.disconnect(sessionId);
      pendingOutput.current.delete(sessionId);
      useConnectionsStore
        .getState()
        .patchSession(sessionId, { status: 'disconnected', startedAt: null });
    },
    [bridge],
  );

  const close = useCallback(
    async (sessionId: string) => {
      await disconnect(sessionId);
      forgetSessionResources(sessionId);
      useConnectionsStore.getState().forgetSession(sessionId);
      useWorkbenchStore.getState().closeSshSession(sessionId);
    },
    [disconnect, forgetSessionResources],
  );

  const reconnect = useCallback(
    async (sessionId: string) => {
      const profile = sessionProfiles.current.get(sessionId);
      if (!bridge || !profile) return;
      await bridge.disconnect(sessionId);
      // The generation retires the previous terminal: the new shell starts on a clean screen.
      const connections = useConnectionsStore.getState();
      const previous = connections.sessions[sessionId];
      pendingOutput.current.delete(sessionId);
      connections.patchSession(sessionId, {
        status: 'connecting',
        error: null,
        startedAt: null,
        generation: (previous?.generation ?? 0) + 1,
      });
      await start(sessionId, profile);
    },
    [bridge, start],
  );

  /**
   * One tab per connection: when the profile already has a terminal tab, that tab is brought to
   * the front and, unless it is live or on its way there, reconnected in place. A new tab is
   * only created for a profile that has none open.
   */
  const open = useCallback(
    async (profile: SshProfile) => {
      if (!bridge) return null;
      const store = useWorkbenchStore.getState();
      const sessions = useConnectionsStore.getState().sessions;
      const existing = store.openSshSessionIds.find((id) => sessions[id]?.profileId === profile.id);
      if (existing) {
        store.openSshSession(existing);
        // The profile may have been edited since the tab opened; reconnect with the latest.
        sessionProfiles.current.set(existing, profile);
        const status = sessions[existing]?.status;
        if (status !== 'connected' && status !== 'connecting') await reconnect(existing);
        return existing;
      }

      const sessionId = createId();
      useConnectionsStore.getState().setSession({
        sessionId,
        profileId: profile.id,
        name: profile.name,
        status: 'connecting',
        error: null,
        startedAt: null,
        generation: 1,
      });
      store.openSshSession(sessionId);
      sessionProfiles.current.set(sessionId, profile);
      pendingOutput.current.delete(sessionId);

      await start(sessionId, profile);
      return sessionId;
    },
    [bridge, start, reconnect],
  );

  const test = useCallback(
    async (profile: SshProfile): Promise<SshErrorInfo | null> => {
      if (!bridge) return sshErrorOf('SSH_UNAVAILABLE');
      const result = await bridge.testConnection(resolveSshProfile(profile));
      if (result.ok) {
        notifications.show({
          color: 'teal',
          title: 'Connection succeeded',
          message: result.value.banner.trim() || `Authenticated as ${profile.username}.`,
        });
        return null;
      }
      return result.error;
    },
    [bridge],
  );

  const resize = useCallback(
    (sessionId: string, size: TerminalSize) => {
      sessionSizes.current.set(sessionId, size);
      bridge?.resize(sessionId, size);
    },
    [bridge],
  );

  const onData = useCallback((sessionId: string, listener: (data: string) => void) => {
    const listeners = dataListeners.current.get(sessionId) ?? new Set();
    listeners.add(listener);
    dataListeners.current.set(sessionId, listeners);
    const buffered = pendingOutput.current.get(sessionId);
    if (buffered) {
      pendingOutput.current.delete(sessionId);
      listener(buffered);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) dataListeners.current.delete(sessionId);
    };
  }, []);

  const closeAll = useCallback(async () => {
    if (!bridge) return;
    const ids = [...sessionProfiles.current.keys()];
    sessionProfiles.current.clear();
    sessionSizes.current.clear();
    pendingOutput.current.clear();
    await Promise.all(ids.map((id) => bridge.disconnect(id).catch(() => undefined)));
  }, [bridge]);

  return useMemo<SshApi>(() => {
    if (!bridge) return UNAVAILABLE;
    return {
      available: true,
      open,
      disconnect,
      close,
      reconnect,
      write: (sessionId, data) => bridge.write(sessionId, data),
      resize,
      test,
      pickPrivateKey: () => bridge.pickPrivateKey(),
      setCredential: (credentialId, secret) => bridge.setCredential({ credentialId, secret }),
      hasCredential: (credentialId) => bridge.hasCredential(credentialId),
      deleteCredential: (credentialId) => bridge.deleteCredential(credentialId),
      onData,
      pendingHostKey,
      answerHostKey,
      closeAll,
    };
  }, [
    bridge,
    open,
    disconnect,
    close,
    reconnect,
    resize,
    test,
    onData,
    pendingHostKey,
    answerHostKey,
    closeAll,
  ]);
}
