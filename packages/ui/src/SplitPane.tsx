/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    useCallback,
    useLayoutEffect,
    useRef,
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
} from 'react';
import { clampRatio, type ResponsePosition } from './preferences';

interface Props {
    layout: ResponsePosition;
    ratio: number;
    defaultRatio: number;
    /** Called once per completed drag or keyboard step, never on every pointer move. */
    onRatioChange: (ratio: number) => void;
    first: ReactNode;
    second: ReactNode;
    firstId: string;
    label: string;
}

const KEYBOARD_STEP = 0.02;
const KEYBOARD_LARGE_STEP = 0.1;

/*
 * The first pane honours the ratio but never shrinks below its minimum. When the window is too
 * small for both minimums, the panes fall back to sharing the space evenly.
 */
const FIRST_PANE =
    'flex min-h-0 min-w-0 basis-[clamp(min(var(--min-first),50%),calc(var(--split-ratio)*100%),max(calc(100%-var(--min-second)),50%))] flex-none flex-col overflow-hidden group-data-[dragging]/split:pointer-events-none';
const SECOND_PANE =
    'flex min-h-0 min-w-0 flex-[1_1_0] flex-col overflow-hidden group-data-[dragging]/split:pointer-events-none';

/**
 * The splitter is a 1px line with a wider invisible hit area (`before`) and an accent line
 * (`after`) shown on hover, drag and keyboard focus.
 */
const SPLITTER = [
    'relative z-[5] flex-none touch-none bg-line outline-none',
    'before:absolute before:content-[""] after:absolute after:bg-primary after:opacity-0 after:transition-opacity after:duration-120 after:content-[""]',
    'hover:after:opacity-70 hover:after:delay-250',
    'focus-visible:after:opacity-100 focus-visible:after:delay-0 group-data-[dragging]/split:after:opacity-100 group-data-[dragging]/split:after:delay-0',
    // Side by side: a vertical bar.
    'group-data-[layout=right]/split:basis-px group-data-[layout=right]/split:cursor-col-resize',
    'group-data-[layout=right]/split:before:-inset-x-[5px] group-data-[layout=right]/split:before:inset-y-0',
    'group-data-[layout=right]/split:after:-inset-x-px group-data-[layout=right]/split:after:inset-y-0',
    // Stacked: a horizontal bar.
    'group-data-[layout=bottom]/split:basis-px group-data-[layout=bottom]/split:cursor-row-resize',
    'group-data-[layout=bottom]/split:before:-inset-y-[5px] group-data-[layout=bottom]/split:before:inset-x-0',
    'group-data-[layout=bottom]/split:after:-inset-y-px group-data-[layout=bottom]/split:after:inset-x-0',
].join(' ');

/**
 * Two panes separated by a draggable splitter (WAI-ARIA window splitter pattern). Switching the
 * layout only changes CSS, so pane contents such as code editors are never remounted. While
 * dragging, the ratio is written straight to a CSS variable; React state (and persistence) is
 * updated once when the drag ends.
 */
export function SplitPane({
    layout,
    ratio,
    defaultRatio,
    onRatioChange,
    first,
    second,
    firstId,
    label,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const splitterRef = useRef<HTMLDivElement>(null);
    const liveRatio = useRef(ratio);
    const drag = useRef<{ rect: DOMRect; frame: number; pending: number } | null>(null);
    const horizontal = layout === 'right';

    const apply = useCallback((value: number) => {
        liveRatio.current = value;
        containerRef.current?.style.setProperty('--split-ratio', String(value));
        splitterRef.current?.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    }, []);

    useLayoutEffect(() => apply(ratio), [apply, ratio]);

    /** Effective ratio after the panes' CSS minimum sizes are applied. */
    const measuredRatio = () => {
        const container = containerRef.current;
        const firstPane = container?.firstElementChild as HTMLElement | null;
        if (!container || !firstPane) return liveRatio.current;
        const total = horizontal ? container.clientWidth : container.clientHeight;
        const size = horizontal ? firstPane.offsetWidth : firstPane.offsetHeight;
        return total > 0 ? size / total : liveRatio.current;
    };

    const commit = (value: number) => {
        const next = clampRatio(value);
        apply(next);
        onRatioChange(next);
    };

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !containerRef.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        drag.current = {
            rect: containerRef.current.getBoundingClientRect(),
            frame: 0,
            pending: liveRatio.current,
        };
        containerRef.current.dataset.dragging = 'true';
    };

    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const state = drag.current;
        if (!state) return;
        const { rect } = state;
        state.pending = clampRatio(
            horizontal
                ? (event.clientX - rect.left) / rect.width
                : (event.clientY - rect.top) / rect.height,
        );
        if (!state.frame) {
            state.frame = requestAnimationFrame(() => {
                state.frame = 0;
                apply(state.pending);
            });
        }
    };

    const endDrag = () => {
        const state = drag.current;
        if (!state) return;
        cancelAnimationFrame(state.frame);
        drag.current = null;
        delete containerRef.current?.dataset.dragging;
        apply(state.pending);
        // Persist what the user actually sees, so a clamped pane does not "jump" on restore.
        commit(measuredRatio());
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
        const decrease = horizontal ? 'ArrowLeft' : 'ArrowUp';
        const increase = horizontal ? 'ArrowRight' : 'ArrowDown';
        let next: number | undefined;
        if (event.key === decrease) next = measuredRatio() - step;
        else if (event.key === increase) next = measuredRatio() + step;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = 1;
        else if (event.key === 'Enter') next = defaultRatio;
        if (next === undefined) return;
        event.preventDefault();
        commit(next);
    };

    return (
        <div
            ref={containerRef}
            // While dragging, the whole workspace keeps the resize cursor, stops selecting text
            // and ignores the panes' pointer events so the drag is never swallowed by a child.
            className={[
                'group/split flex min-h-0 min-w-0 flex-1 overflow-hidden',
                'data-[layout=right]:flex-row data-[layout=right]:[--min-first:320px] data-[layout=right]:[--min-second:280px]',
                'data-[layout=bottom]:flex-col data-[layout=bottom]:[--min-first:150px] data-[layout=bottom]:[--min-second:130px]',
                'data-[dragging]:select-none data-[dragging]:data-[layout=right]:cursor-col-resize data-[dragging]:data-[layout=bottom]:cursor-row-resize',
            ].join(' ')}
            data-layout={layout}
            style={{ '--split-ratio': ratio } as CSSProperties}
        >
            <div className={FIRST_PANE}>{first}</div>
            <div
                ref={splitterRef}
                role="separator"
                tabIndex={0}
                className={SPLITTER}
                aria-label={label}
                aria-controls={firstId}
                // A vertical bar splits side-by-side panes; a horizontal bar splits stacked panes.
                aria-orientation={horizontal ? 'vertical' : 'horizontal'}
                aria-valuemin={10}
                aria-valuemax={90}
                aria-valuenow={Math.round(ratio * 100)}
                title="Drag to resize · double-click to reset"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
                onDoubleClick={() => commit(defaultRatio)}
                onKeyDown={onKeyDown}
            />
            <div className={SECOND_PANE}>{second}</div>
        </div>
    );
}
