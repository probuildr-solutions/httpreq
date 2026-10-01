/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { forwardRef, type ReactNode } from 'react';
import { cx } from './kit';
import { DEFAULT_SPLIT_RATIO, usePreferences } from './preferences';
import { SplitPane } from './SplitPane';

interface Props {
    /** The editing half: the URL bar, the parameters, whatever the request is configured in. */
    request: ReactNode;
    /** The reading half: an HTTP response, a WebSocket message log. */
    response: ReactNode;
    /** Accessible names for the two panes, e.g. "Request" and "Response". */
    labels: { request: string; response: string };
    /** Ids used by the splitter's `aria-controls` and by focus handling. */
    requestId: string;
    splitterLabel: string;
    /** Marks the reading pane busy while a request is in flight or a socket is connecting. */
    busy?: boolean;
}

/**
 * Both panes are plain flex columns that own their own scrolling, so a large response, or a long
 * message log, can never make the window itself overflow, whichever side of the splitter it is on.
 */
const PANE = 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden';

/**
 * The workspace layout every request kind shares: an editing pane, a splitter, and a reading pane.
 *
 * Position and ratio come from the application preferences rather than from the caller, so the
 * "response right"/"response bottom" toggle moves the WebSocket message log exactly as it moves
 * an HTTP response, and a ratio dragged in one kind of request is the one the other opens at.
 * Switching layout only changes CSS, so neither pane's contents are remounted.
 */
export const WorkbenchSplit = forwardRef<HTMLElement, Props>(function WorkbenchSplit(
    { request, response, labels, requestId, splitterLabel, busy },
    responseRef,
) {
    const position = usePreferences((state) => state.responsePosition);
    const ratio = usePreferences((state) => state.splitRatio[state.responsePosition]);
    const setSplitRatio = usePreferences((state) => state.setSplitRatio);

    return (
        <SplitPane
            layout={position}
            ratio={ratio}
            defaultRatio={DEFAULT_SPLIT_RATIO[position]}
            onRatioChange={(next) => setSplitRatio(position, next)}
            firstId={requestId}
            label={splitterLabel}
            first={
                <section id={requestId} aria-label={labels.request} className={PANE}>
                    {request}
                </section>
            }
            second={
                <section
                    ref={responseRef}
                    tabIndex={-1}
                    aria-label={labels.response}
                    aria-busy={busy}
                    // A size container, so what the reading pane shows can follow its own width as
                    // the splitter moves, not only the window's.
                    className={cx(
                        PANE,
                        '@container/workbench-pane outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-primary)]',
                    )}
                >
                    {response}
                </section>
            }
        />
    );
});

interface PaneHeaderProps {
    children: ReactNode;
    /** `bottom` puts the rule above the strip, for a header that sits under its content. */
    position?: 'top' | 'bottom';
    'aria-label'?: string;
}

/**
 * The heading strip a pane's title and controls sit in: one height, one rule, one set of
 * paddings, shared by the response panel, the WebSocket message log and the message composer so
 * the request kinds line up.
 */
export function PaneHeader({ children, position = 'top', ...rest }: PaneHeaderProps) {
    return (
        <div
            className={cx(
                'flex min-h-[38px] flex-none items-center justify-between gap-2 px-2.5',
                position === 'top' ? 'border-b border-line' : 'border-t border-line',
            )}
            {...rest}
        >
            {children}
        </div>
    );
}
