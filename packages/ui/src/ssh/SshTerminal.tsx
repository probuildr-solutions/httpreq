/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconAlertTriangle,
    IconPlugConnected,
    IconPlugConnectedX,
    IconRefresh,
    IconTerminal2,
} from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { SshStatus } from '@httpreq/shared';
import { useConnectionsStore } from '../connections';
import { useSsh } from './useSsh';
import { Alert, Button, Group, STATUS_ROW, StatusDot, Text, useComputedColorScheme } from '../kit';

const STATUS_LABEL: Record<SshStatus, string> = {
    disconnected: 'Disconnected',
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnecting: 'Disconnecting…',
    error: 'Error',
};

/** Statuses that have — or are about to have — a live shell behind them. */
const HAS_SHELL = new Set<SshStatus>(['connecting', 'connected', 'disconnecting']);

const THEMES = {
    dark: {
        background: '#141414',
        foreground: '#e6e6e6',
        cursor: '#e6e6e6',
        selectionBackground: '#3a3a3a',
    },
    light: {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#1f2328',
        selectionBackground: '#cfe2ff',
    },
};

/**
 * A concrete stack rather than a CSS variable: xterm measures a character cell by rendering with
 * this exact value, and a font it cannot resolve puts every glyph out of step with the grid.
 */
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;

interface SurfaceProps {
    sessionId: string;
    /** Becomes true when the remote shell exists and can be told what size to be. */
    connected: boolean;
}

/**
 * The xterm instance itself.
 *
 * It is mounted per shell — the parent keys it on the session's generation — so a reconnect gets
 * a new terminal with an empty scrollback rather than appending a second shell to the previous
 * one's output. The effect deliberately depends on nothing but the session: the SSH API object
 * changes identity whenever a host-key prompt appears, and rebuilding the terminal for that would
 * throw away the user's scrollback mid-session.
 */
function TerminalSurface({ sessionId, connected }: SurfaceProps) {
    const ssh = useSsh();
    const colorScheme = useComputedColorScheme();
    const host = useRef<HTMLDivElement>(null);
    const terminal = useRef<Terminal | null>(null);
    // Read through a ref, so a new API object never restarts the terminal.
    const sshRef = useRef(ssh);
    sshRef.current = ssh;
    const schemeRef = useRef(colorScheme);
    schemeRef.current = colorScheme;
    /** The live terminal's size reporter, so the connect effect can call it without rebuilding. */
    const reportRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        const element = host.current;
        if (!element) return;

        const instance = new Terminal({
            fontFamily: FONT_FAMILY,
            fontSize: FONT_SIZE,
            lineHeight: LINE_HEIGHT,
            theme: THEMES[schemeRef.current],
            // Deep enough to hold a long build log without holding a session's worth of memory.
            scrollback: 5000,
            cursorBlink: true,
            allowProposedApi: true,
        });
        const fit = new FitAddon();
        instance.loadAddon(fit);
        instance.open(element);
        terminal.current = instance;

        /**
         * Tells the remote pty the size the terminal actually laid out at. Both the cell grid and
         * the pixel box are sent: `cols`/`rows` are what a shell wraps and redraws against, and the
         * pixel size is what a program drawing images or sixels asks the pty for.
         */
        const report = () =>
            sshRef.current.resize(sessionId, {
                cols: instance.cols,
                rows: instance.rows,
                width: element.clientWidth,
                height: element.clientHeight,
            });
        reportRef.current = report;

        let frame = 0;
        const applyFit = () => {
            // A hidden tab measures as zero, and fitting to that would collapse the grid to 1×1.
            if (element.clientWidth <= 0 || element.clientHeight <= 0) return;
            try {
                fit.fit();
            } catch {
                // xterm could not measure a character cell yet; the next resize tries again.
                return;
            }
            report();
        };
        /** Coalesces the bursts a ResizeObserver delivers while a window is being dragged. */
        const scheduleFit = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                applyFit();
            });
        };

        // The first fit waits a frame: fonts and the flex layout settle after `open`, and measuring
        // before that produces a grid that does not match the element it is drawn in.
        scheduleFit();

        const offData = sshRef.current.onData(sessionId, (data) => instance.write(data));
        const onInput = instance.onData((data) => sshRef.current.write(sessionId, data));
        // Covers the window being resized, the sidebar being toggled and the split being dragged.
        const observer = new ResizeObserver(scheduleFit);
        observer.observe(element);

        // Ctrl+C must stay SIGINT, so copy and paste use the terminal convention with Shift.
        instance.attachCustomKeyEventHandler((event) => {
            const modifier = event.ctrlKey || event.metaKey;
            if (event.type !== 'keydown' || !modifier || !event.shiftKey) return true;
            if (event.key.toLowerCase() === 'c' && instance.hasSelection()) {
                void navigator.clipboard.writeText(instance.getSelection());
                return false;
            }
            if (event.key.toLowerCase() === 'v') {
                void navigator.clipboard
                    .readText()
                    .then((text) => sshRef.current.write(sessionId, text));
                return false;
            }
            return true;
        });

        return () => {
            if (frame) cancelAnimationFrame(frame);
            observer.disconnect();
            offData();
            onInput.dispose();
            reportRef.current = null;
            // Disposing the terminal also disposes the addons it loaded and removes its DOM.
            instance.dispose();
            terminal.current = null;
        };
    }, [sessionId]);

    /*
     * The terminal lays out while the handshake is still running, so the size it first reported
     * was measured before there was a shell to tell. Reporting again on connect is what stops a
     * remote pty from staying at its default 80x24 under a wider xterm — the mismatch that makes a
     * remote shell wrap early and redraw its prompt over its own output.
     */
    useEffect(() => {
        if (connected) reportRef.current?.();
    }, [connected]);

    // Only the palette changes with the theme; the terminal itself is never rebuilt for it.
    useEffect(() => {
        if (terminal.current) terminal.current.options.theme = THEMES[colorScheme];
    }, [colorScheme]);

    return (
        // The padding lives here so the element xterm measures has none: the fit addon derives the
        // grid from its host's content box, and padding on that host is what makes the last column
        // and row overflow. `overflow-hidden` keeps the scrolling inside xterm's own viewport.
        <div className="min-h-0 flex-1 overflow-hidden bg-white px-2 py-1.5 dark:bg-[#141414]">
            {/* A fitted grid rarely divides the host exactly; filling the host keeps the leftover strip
          in the terminal's own background. A thin scrollbar would not cover the last column. */}
            <div
                ref={host}
                className="size-full [&_.xterm]:h-full [&_.xterm-viewport]:overflow-y-auto [&_.xterm-viewport]:[scrollbar-width:thin]"
            />
        </div>
    );
}

interface Props {
    sessionId: string;
}

/**
 * An interactive shell rendered with xterm.js.
 *
 * The terminal owns no connection: it writes what the session emits and forwards what the user
 * types. Scrollback, selection, copy/paste and the standard key handling come from xterm; the only
 * addition is Ctrl/Cmd+Shift+C/V, because a bare Ctrl+C has to reach the remote shell as an
 * interrupt rather than copying.
 *
 * Disconnecting takes the terminal off the screen entirely rather than leaving a dead shell to
 * read: the session is over, and the next connection starts from a clean one.
 */
export function SshTerminal({ sessionId }: Props) {
    const ssh = useSsh();
    const session = useConnectionsStore((state) => state.sessions[sessionId]);
    const status = session?.status ?? 'disconnected';
    const live = HAS_SHELL.has(status);

    return (
        // The panel is a flex item in the workspace row, so it has to claim that row: without
        // `flex-1` it would size to its own toolbar and leave the terminal in a narrow column.
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1">
                <Group gap="xs">
                    <span className={STATUS_ROW}>
                        <StatusDot status={status} />
                        <span aria-live="polite">{STATUS_LABEL[status]}</span>
                    </span>
                    <Text size="xs" className="text-dimmed">
                        {session?.name}
                    </Text>
                </Group>
                <Group gap={6}>
                    <Button
                        variant="subtle"
                        color="gray"
                        size="compact-xs"
                        leftSection={<IconRefresh size={14} />}
                        onClick={() => void ssh.reconnect(sessionId)}
                    >
                        Reconnect
                    </Button>
                    <Button
                        variant="subtle"
                        color="gray"
                        size="compact-xs"
                        leftSection={<IconPlugConnectedX size={14} />}
                        disabled={!live}
                        onClick={() => void ssh.disconnect(sessionId)}
                    >
                        Disconnect
                    </Button>
                </Group>
            </div>

            {session?.error && (
                <Alert
                    color="red"
                    variant="light"
                    icon={<IconAlertTriangle size={16} />}
                    title={session.error.message}
                >
                    {session.error.detail && (
                        <Text
                            size="xs"
                            component="pre"
                            className="mt-1 mb-0 font-mono break-words whitespace-pre-wrap"
                        >
                            {session.error.detail}
                        </Text>
                    )}
                </Alert>
            )}

            {live ? (
                // Keyed on the generation: a reconnect disposes this terminal and builds a new one.
                <TerminalSurface
                    key={`${sessionId}:${session?.generation ?? 0}`}
                    sessionId={sessionId}
                    connected={status === 'connected'}
                />
            ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 p-6 text-center text-dimmed">
                    <IconTerminal2 size={26} aria-hidden />
                    <Text size="sm" className="text-dimmed">
                        {status === 'error'
                            ? 'The session ended. Connect again to start a new terminal.'
                            : 'This session is disconnected.'}
                    </Text>
                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlugConnected size={14} />}
                        onClick={() => void ssh.reconnect(sessionId)}
                    >
                        Connect again
                    </Button>
                </div>
            )}
        </div>
    );
}
