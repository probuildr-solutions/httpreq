/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    memo,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { tokenizeJsonLine, type JsonTokenType } from '@httpreq/document-engine';
import {
    INITIAL_LEX_STATE,
    tokenizeLine,
    type LexState,
    type SqlDialect,
    type TokenType,
} from '@httpreq/sql-parser';
import {
    isLineSelected,
    linesPerViewport,
    maxTopLine,
    positionFromScroll,
    scrollFromLine,
    spacerHeight,
    visibleRange,
    type LineSelection,
    type ScrollGeometry,
} from '@httpreq/editor-core';
import { cx } from '../kit';
import type { ViewRow } from './useDbStudio';
import type { FileLanguage } from './studioStore';

/** Pixels per line; the geometry of the scroll bar depends on it. */
export const LINE_HEIGHT = 20;
/** Lines above the screen that are lexed to get the right state at its top. */
const LEX_PAD = 64;
/** Rows are fetched in blocks of this many lines, so scrolling by one line does not refetch. */
const BLOCK = 32;
/** Used until the element has been measured (and in tests, where nothing has a size). */
const DEFAULT_VIEWPORT = 480;

const TOKEN_CLASS: Record<string, string> = {
    keyword: 'text-violet-5 font-medium',
    string: 'text-teal-6',
    quotedIdentifier: 'text-teal-7',
    number: 'text-yellow-7',
    comment: 'text-dimmed italic',
    parameter: 'text-yellow-7',
    key: 'text-primary-text',
    invalid: 'text-red-6',
    operator: 'text-dimmed',
    punctuation: 'text-dimmed',
};

interface Piece {
    text: string;
    type: TokenType | JsonTokenType | 'plain';
}

/** Splits a line into coloured pieces; for plain text it is one piece. */
const piecesFor = (
    language: FileLanguage,
    text: string,
    state: LexState,
): { pieces: Piece[]; state: LexState } => {
    if (language === 'json') {
        return {
            pieces: tokenizeJsonLine(text).map((token) => ({
                text: text.slice(token.start, token.end),
                type: token.type,
            })),
            state,
        };
    }
    if (language === 'sql-mysql' || language === 'sql-postgresql') {
        const dialect: SqlDialect = language === 'sql-mysql' ? 'mysql' : 'postgresql';
        const result = tokenizeLine(text, state, dialect);
        return {
            pieces: result.tokens.map((token) => ({
                text: text.slice(token.start, token.end),
                type: token.type,
            })),
            state: result.state,
        };
    }
    return { pieces: [{ text, type: 'plain' }], state };
};

interface RowProps {
    index: number;
    row: ViewRow | undefined;
    pieces: Piece[] | undefined;
    gutter: number;
    selected: boolean;
    hit: boolean;
    editing: string | null;
    editable: boolean;
    onGutter: (index: number, extend: boolean) => void;
    onEdit: (index: number) => void;
    onCommit: (index: number, value: string, then: 'none' | 'insert') => void;
    onCancel: () => void;
}

const Row = memo(function Row({
    index,
    row,
    pieces,
    gutter,
    selected,
    hit,
    editing,
    editable,
    onGutter,
    onEdit,
    onCommit,
    onCancel,
}: RowProps) {
    const canEdit = editable && row && !row.truncated;
    let content: ReactNode;
    if (editing !== null) {
        content = (
            <input
                autoFocus
                aria-label={`Edit line ${index + 1}`}
                defaultValue={editing}
                spellCheck={false}
                className="h-full min-w-[60ch] flex-1 border-0 bg-transparent p-0 font-mono text-[12px] text-fg outline-none"
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        onCommit(
                            index,
                            event.currentTarget.value,
                            event.ctrlKey || event.metaKey ? 'insert' : 'none',
                        );
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        onCancel();
                    }
                }}
                onBlur={(event) => onCommit(index, event.currentTarget.value, 'none')}
            />
        );
    } else if (!row) {
        content = <span className="text-dimmed">…</span>;
    } else if (pieces) {
        content = pieces.map((piece, i) => (
            <span key={i} className={TOKEN_CLASS[piece.type]}>
                {piece.text}
            </span>
        ));
    } else {
        content = row.text;
    }

    return (
        <div
            data-line={index}
            className={cx(
                'flex w-max min-w-full items-center whitespace-pre font-mono text-[12px] leading-5',
                selected ? 'bg-primary-soft' : hit ? 'bg-yellow-0/10' : 'hover:bg-hover',
            )}
            style={{ height: LINE_HEIGHT }}
            onDoubleClick={() => canEdit && onEdit(index)}
        >
            <button
                type="button"
                tabIndex={-1}
                aria-label={`Select line ${index + 1}`}
                title="Click to select · Shift+click to extend"
                className={cx(
                    'sticky left-0 z-[1] box-content flex-none cursor-pointer select-none border-0 border-r border-line bg-surface px-2 text-right font-mono text-[11px] text-dimmed',
                    row?.edited && 'border-r-2 border-r-primary',
                    selected && 'bg-primary-soft text-fg',
                )}
                style={{ width: `${gutter}ch`, height: LINE_HEIGHT }}
                onClick={(event) => onGutter(index, event.shiftKey)}
            >
                {index + 1}
            </button>
            <span className="pl-3 pr-6">
                {content}
                {row?.truncated && editing === null && (
                    <span
                        className="ml-1 text-dimmed"
                        title="This line is longer than the viewer shows"
                    >
                        …
                    </span>
                )}
            </span>
        </div>
    );
});

export interface VirtualViewerProps {
    lineCount: number;
    /** Changes whenever the document changes, so visible lines are read again. */
    version: number;
    language: FileLanguage;
    readRows: (first: number, end: number) => Promise<ViewRow[]>;
    /** A request to scroll to a (zero-based) line. */
    reveal: { line: number; nonce: number } | null;
    onTopLine: (line: number) => void;
    selection: LineSelection | null;
    onSelect: (line: number, extend: boolean) => void;
    editable: boolean;
    onEditLine: (index: number, text: string) => void;
    onInsertBelow: (index: number) => void;
    /** Receives key presses the viewer does not handle itself (copy, delete, undo…). */
    onCommand: (event: KeyboardEvent<HTMLDivElement>) => void;
    /** A line to mark as the current search hit. */
    hitLine?: number;
    /** Fixed viewport height, for tests where nothing has a layout. */
    viewportHeight?: number;
}

/**
 * A scrolling view of a document of any length.
 *
 * Only about a screenful of lines exists as DOM nodes: the rest of the file is a tall empty
 * spacer. The spacer is capped (browsers cannot scroll an element tens of millions of pixels
 * high), so beyond that height a pixel of scrolling moves more than one line and the position is
 * mapped by ratio; the mouse wheel is handled separately in that case so it still moves a few
 * lines at a time. Lines are fetched as the view moves, in blocks, through the document model, so
 * unsaved edits show immediately and the file is only read where it is looked at.
 *
 * Highlighting lexes the visible lines starting a short way above the screen. That is exact
 * unless a multi-line comment or string is longer than that, and it keeps the cost proportional
 * to the screen, not to the file.
 */
export function VirtualViewer({
    lineCount,
    version,
    language,
    readRows,
    reveal,
    onTopLine,
    selection,
    onSelect,
    editable,
    onEditLine,
    onInsertBelow,
    onCommand,
    hitLine,
    viewportHeight: fixedHeight,
}: VirtualViewerProps) {
    const scroller = useRef<HTMLDivElement>(null);
    const [measured, setMeasured] = useState(DEFAULT_VIEWPORT);
    const viewportHeight = fixedHeight ?? measured;
    const [top, setTop] = useState({ line: 0, offset: 0 });
    const [rows, setRows] = useState<{ from: number; byIndex: Map<number, ViewRow> }>({
        from: 0,
        byIndex: new Map(),
    });
    const [editing, setEditing] = useState<{ index: number; value: string } | null>(null);
    /** The edit in progress, readable synchronously so a blur after Enter does not commit twice. */
    const editingRef = useRef(editing);
    editingRef.current = editing;

    const geometry = useMemo<ScrollGeometry>(
        () => ({ lineCount, lineHeight: LINE_HEIGHT, viewportHeight }),
        [lineCount, viewportHeight],
    );
    const spacer = spacerHeight(geometry);

    /* Measure the visible height. */
    useLayoutEffect(() => {
        const element = scroller.current;
        if (!element || fixedHeight !== undefined) return;
        const update = () => {
            if (element.clientHeight > 0) setMeasured(element.clientHeight);
        };
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [fixedHeight]);

    const topRef = useRef(top);
    topRef.current = top;
    const geometryRef = useRef(geometry);
    geometryRef.current = geometry;

    const moveTo = (line: number) => {
        const element = scroller.current;
        const g = geometryRef.current;
        const target = Math.max(0, Math.min(maxTopLine(g), Math.round(line)));
        if (element) element.scrollTop = scrollFromLine(g, target);
        setTop({ line: target, offset: 0 });
        onTopLine(target);
    };

    /* Scrolling by the bar or the wheel. */
    const onScroll = () => {
        const element = scroller.current;
        if (!element) return;
        const next = positionFromScroll(geometryRef.current, element.scrollTop);
        if (next.line !== topRef.current.line || next.offset !== topRef.current.offset) {
            setTop(next);
            if (next.line !== topRef.current.line) onTopLine(next.line);
        }
    };

    /* When the spacer is scaled, the browser's wheel step would jump thousands of lines. */
    useEffect(() => {
        const element = scroller.current;
        if (!element) return;
        const onWheel = (event: WheelEvent) => {
            const g = geometryRef.current;
            if (g.lineCount * g.lineHeight <= spacerHeight(g)) return;
            event.preventDefault();
            const lines = event.deltaMode === 1 ? event.deltaY : event.deltaY / (LINE_HEIGHT * 0.8);
            moveTo(topRef.current.line + Math.round(lines));
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
        // `moveTo` reads everything it needs through refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* A request from outside to show a line. */
    useEffect(() => {
        if (!reveal) return;
        const g = geometryRef.current;
        const visible = linesPerViewport(g);
        const { line } = topRef.current;
        // Already on screen: leave the view alone; otherwise put the line a few rows below the top.
        if (reveal.line >= line && reveal.line < line + visible) return;
        moveTo(reveal.line - Math.min(4, Math.floor(visible / 4)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reveal?.nonce]);

    /* A document that got shorter must not leave the view past its end. */
    useEffect(() => {
        if (top.line > maxTopLine(geometry)) moveTo(maxTopLine(geometry));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lineCount]);

    /* Which lines to fetch: the visible ones, a pad above for lexing, in whole blocks. */
    const range = visibleRange(geometry, top.line, 8);
    const wantFrom = Math.max(0, Math.floor((range.first - LEX_PAD) / BLOCK) * BLOCK);
    const wantEnd = Math.min(lineCount, Math.ceil(range.end / BLOCK) * BLOCK + BLOCK);

    useEffect(() => {
        if (wantEnd <= wantFrom) {
            setRows({ from: wantFrom, byIndex: new Map() });
            return;
        }
        let cancelled = false;
        readRows(wantFrom, wantEnd)
            .then((fetched) => {
                if (cancelled) return;
                setRows({
                    from: wantFrom,
                    byIndex: new Map(fetched.map((row) => [row.index, row])),
                });
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [readRows, wantFrom, wantEnd, version]);

    /* Colours: lex from the pad down to the visible lines. */
    const highlighted = useMemo(() => {
        const result = new Map<number, Piece[]>();
        if (language === 'plain') return result;
        let state = INITIAL_LEX_STATE;
        for (let index = wantFrom; index < range.end; index++) {
            const row = rows.byIndex.get(index);
            if (!row) continue;
            const lexed = piecesFor(language, row.text, state);
            state = lexed.state;
            if (index >= range.first) result.set(index, lexed.pieces);
        }
        return result;
    }, [rows, language, wantFrom, range.first, range.end]);

    const gutter = String(Math.max(1, lineCount)).length + 1;

    const startEdit = (index: number) => {
        const row = rows.byIndex.get(index);
        if (!editable || !row || row.truncated) return;
        onSelect(index, false);
        const next = { index, value: row.text };
        editingRef.current = next;
        setEditing(next);
    };

    const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (editing) return;
        const g = geometryRef.current;
        const page = Math.max(1, linesPerViewport(g) - 1);
        const current = topRef.current.line;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                moveTo(current + 1);
                return;
            case 'ArrowUp':
                event.preventDefault();
                moveTo(current - 1);
                return;
            case 'PageDown':
                event.preventDefault();
                moveTo(current + page);
                return;
            case 'PageUp':
                event.preventDefault();
                moveTo(current - page);
                return;
            case 'Home':
                if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    moveTo(0);
                    return;
                }
                break;
            case 'End':
                if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    moveTo(maxTopLine(g));
                    return;
                }
                break;
            case 'F2':
            case 'Enter':
                if (selection && editable) {
                    event.preventDefault();
                    startEdit(Math.min(selection.anchor, selection.head));
                    return;
                }
                break;
        }
        onCommand(event);
    };

    const commit = (index: number, value: string, then: 'none' | 'insert') => {
        const current = editingRef.current;
        if (!current || current.index !== index) return;
        const row = rows.byIndex.get(index);
        const next = then === 'insert' ? { index: index + 1, value: '' } : null;
        editingRef.current = next;
        setEditing(next);
        if (row && row.text !== value) onEditLine(index, value);
        if (then === 'insert') onInsertBelow(index);
    };

    const indices: number[] = [];
    for (let index = range.first; index < range.end; index++) indices.push(index);

    return (
        <div
            ref={scroller}
            role="region"
            aria-label="File content"
            tabIndex={0}
            className="relative h-full min-h-0 overflow-y-scroll overflow-x-hidden bg-surface outline-none focus-visible:ring-1 focus-visible:ring-primary"
            onScroll={onScroll}
            onKeyDown={handleKey}
        >
            <div style={{ height: spacer }}>
                <div
                    className="sticky top-0 overflow-x-auto overflow-y-hidden"
                    style={{ height: viewportHeight }}
                >
                    <div
                        style={{
                            transform: top.offset ? `translateY(${-top.offset}px)` : undefined,
                        }}
                    >
                        {indices.map((index) => (
                            <Row
                                key={index}
                                index={index}
                                row={rows.byIndex.get(index)}
                                pieces={highlighted.get(index)}
                                gutter={gutter}
                                selected={isLineSelected(selection, index)}
                                hit={hitLine === index}
                                editing={editing?.index === index ? editing.value : null}
                                editable={editable}
                                onGutter={onSelect}
                                onEdit={startEdit}
                                onCommit={commit}
                                onCancel={() => setEditing(null)}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
