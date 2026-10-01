/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    IconArrowUpCircle,
    IconBolt,
    IconLayoutColumns,
    IconLayoutRows,
    IconLoader2,
    IconRouter,
    IconServer,
    IconZoomReset,
} from '@tabler/icons-react';
import { memo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCapabilities } from './capabilities';
import { activeConnectionCounts, useConnectionsStore } from './connections';
import { recheckConnectivity, useConnectivity, type ConnectivityStatus } from './connectivity';
import { Tooltip, cx } from './kit';
import { usePreferences } from './preferences';
import { describeUpdate, useUpdates, type UpdateInfo } from './updates';

const statusText: Record<ConnectivityStatus, string> = {
    online: 'Online',
    offline: 'Offline',
    checking: 'Checking…',
};

const statusHint: Record<ConnectivityStatus, string> = {
    online: 'The internet is reachable.',
    offline: 'No internet connection. You can keep editing; sending will fail until it returns.',
    checking: 'Checking the internet connection…',
};

/**
 * Connection state uses both a coloured dot and a label; the offline dot is hollow so the state
 * is distinguishable without colour.
 */
const statusDot: Record<ConnectivityStatus, string> = {
    online: 'bg-teal-6',
    offline: 'bg-transparent shadow-[inset_0_0_0_2px_var(--color-red-6)]',
    checking: 'animate-pulse-soft bg-yellow-6',
};

const SEGMENT = 'inline-flex items-center gap-[5px] px-[7px]';
const BUTTON_SEGMENT = cx(
    SEGMENT,
    'border-0 bg-transparent text-inherit hover:bg-chrome-hover hover:text-fg focus-visible:outline-offset-[-2px]',
);

interface Props {
    workspaceName: string;
    runtimeLabel: string;
    version?: string;
    sending: boolean;
    /** Restores the default zoom: the window's in the desktop app, the page's in the browser. */
    onResetZoom: () => void;
    /** The zoom is not the default; the reset control is only shown then. */
    zoomed: boolean;
    /** Installs or loads an available update (download page, or a reload for the web app). */
    onApplyUpdate?: (update: UpdateInfo) => void;
}

/** A passive piece of status text, truncated before it can push the bar's other end away. */
const Segment = ({
    children,
    ...props
}: {
    children: ReactNode;
    role?: string;
    'aria-label'?: string;
}) => (
    <span {...props} className={cx(SEGMENT, 'min-w-0 overflow-hidden text-ellipsis')}>
        {children}
    </span>
);

/** One live-connection counter. Hidden at zero, so the bar stays quiet when nothing is running. */
function ConnectionCount({
    count,
    icon: Icon,
    singular,
    plural,
}: {
    count: number;
    icon: typeof IconBolt;
    singular: string;
    plural: string;
}) {
    if (count === 0) return null;
    const label = `${count} ${count === 1 ? singular : plural}`;
    return (
        <Tooltip label={label} openDelay={300}>
            <Segment aria-label={label}>
                <Icon size={12} aria-hidden /> {count}
            </Segment>
        </Tooltip>
    );
}

/** Compact VS Code-style status bar. Only this component re-renders on connectivity changes. */
export const StatusBar = memo(function StatusBar({
    workspaceName,
    runtimeLabel,
    version,
    sending,
    onResetZoom,
    zoomed,
    onApplyUpdate,
}: Props) {
    const update = useUpdates((state) => state.update);
    const status = useConnectivity((state) => state.status);
    // Shallow-compared: the selector derives a fresh object, so it needs a stable comparison.
    const counts = useConnectionsStore(useShallow(activeConnectionCounts));
    const capabilities = useCapabilities();
    const layout = usePreferences((state) => state.responsePosition);
    const setLayout = usePreferences((state) => state.setResponsePosition);
    const nextLayout = layout === 'right' ? 'bottom' : 'right';

    return (
        <div className="flex h-full items-stretch justify-between gap-2 overflow-hidden border-t border-line bg-statusbar px-1.5 text-[11.5px] leading-none whitespace-nowrap text-dimmed">
            <div className="flex min-w-0 items-stretch overflow-hidden">
                <Tooltip label={`${statusHint[status]} Select to check again.`} openDelay={300}>
                    <button
                        type="button"
                        className={cx(
                            BUTTON_SEGMENT,
                            status === 'offline' && 'font-semibold text-danger-text',
                        )}
                        aria-label={`Connection: ${statusText[status]}. Select to check again.`}
                        onClick={() => void recheckConnectivity()}
                    >
                        <span
                            className={cx('size-2 rounded-full', statusDot[status])}
                            aria-hidden
                        />
                        <span aria-live="polite">{statusText[status]}</span>
                    </button>
                </Tooltip>
                <Segment>
                    <span className="opacity-80 max-sm:hidden">Workspace:</span> {workspaceName}
                </Segment>
                <Segment>{runtimeLabel}</Segment>
                <ConnectionCount
                    count={counts.webSockets}
                    icon={IconBolt}
                    singular="WebSocket connected"
                    plural="WebSockets connected"
                />
                {capabilities.ssh && (
                    <ConnectionCount
                        count={counts.sshSessions}
                        icon={IconServer}
                        singular="SSH session connected"
                        plural="SSH sessions connected"
                    />
                )}
                {capabilities.tunneling && (
                    <ConnectionCount
                        count={counts.tunnels}
                        icon={IconRouter}
                        singular="tunnel active"
                        plural="tunnels active"
                    />
                )}
                {sending && (
                    <Segment role="status">
                        <IconLoader2 size={12} className="animate-spin" aria-hidden /> Sending…
                    </Segment>
                )}
            </div>
            <div className="flex min-w-0 items-stretch">
                {zoomed && (
                    <button
                        type="button"
                        className={BUTTON_SEGMENT}
                        aria-label="Reset zoom to 100%"
                        title="Reset zoom to 100%"
                        onClick={onResetZoom}
                    >
                        {/* Keeps a colour of its own, so the glyph stays visible against the bar. */}
                        <IconZoomReset size={14} className="text-cyan-5" aria-hidden />
                        Reset Zoom
                    </button>
                )}
                <button
                    type="button"
                    className={BUTTON_SEGMENT}
                    aria-label={`Response panel: ${layout}. Select to move it to the ${nextLayout}.`}
                    title={`Move response to the ${nextLayout}`}
                    onClick={() => setLayout(nextLayout)}
                >
                    {layout === 'right' ? (
                        <IconLayoutColumns size={13} aria-hidden />
                    ) : (
                        <IconLayoutRows size={13} aria-hidden />
                    )}
                    Response {layout === 'right' ? 'Right' : 'Bottom'}
                </button>
                {update && onApplyUpdate && (
                    <Tooltip label={describeUpdate(update).hint} openDelay={300}>
                        {/* An available update: the one accent in the bar, noticed without being loud. */}
                        <button
                            type="button"
                            className={cx(BUTTON_SEGMENT, 'font-semibold text-primary-text')}
                            onClick={() => onApplyUpdate(update)}
                        >
                            <IconArrowUpCircle size={13} aria-hidden />
                            {describeUpdate(update).label}
                        </button>
                    </Tooltip>
                )}
                {version && <Segment>HttpReq v{version}</Segment>}
            </div>
        </div>
    );
});
