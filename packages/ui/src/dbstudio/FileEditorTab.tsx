/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconChevronDown,
    IconChevronUp,
    IconDeviceFloppy,
    IconListDetails,
    IconSearch,
    IconX,
} from '@tabler/icons-react';
import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { selectionBounds, selectionSize } from '@httpreq/editor-core';
import type { DbItemText } from '@httpreq/shared';
import { CodeEditor } from '../editor/CodeEditor';
import { handlingFor } from './largeFile';
import { formatSize } from '../format';
import {
    ActionIcon,
    Alert,
    Button,
    Progress,
    SegmentedControl,
    Text,
    TextInput,
    Tooltip,
    cx,
} from '../kit';
import { copyText } from '../clipboard';
import {
    ITEMS_PAGE,
    isDirty,
    languageOf,
    monacoLanguage,
    useStudioStore,
    type FileTab,
} from './studioStore';
import { useDbStudio } from './useDbStudio';
import { VirtualViewer } from './VirtualViewer';

const COUNT = new Intl.NumberFormat('en-US');
const percentOf = (done: number, total: number) =>
    total > 0 ? Math.min(100, (done / total) * 100) : 0;

function Toggle({
    label,
    title,
    on,
    onClick,
}: {
    label: string;
    title: string;
    on: boolean;
    onClick: () => void;
}) {
    return (
        <Tooltip label={title}>
            <Button
                size="xs"
                variant={on ? 'light' : 'subtle'}
                aria-label={title}
                aria-pressed={on}
                onClick={onClick}
                className="font-mono"
            >
                {label}
            </Button>
        </Tooltip>
    );
}

/** The find and replace bar. Searching runs in the file host and streams its results. */
function FindBar({ tab }: { tab: FileTab }) {
    const api = useDbStudio();
    const [needle, setNeedle] = useState(tab.search?.query.text ?? '');
    const [replacement, setReplacement] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(tab.search?.query.caseSensitive ?? false);
    const [wholeWord, setWholeWord] = useState(tab.search?.query.wholeWord ?? false);
    const [regex, setRegex] = useState(tab.search?.query.regex ?? false);
    const [replaceOpen, setReplaceOpen] = useState(false);
    const search = tab.search;
    const searching = search?.state === 'running' || search?.state === 'starting';
    const query = { text: needle, caseSensitive, wholeWord, regex };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!needle) return;
        // Enter on a finished search steps to the next hit, as in any editor.
        if (search && !searching && search.query.text === needle && search.hits.length > 0) {
            api.stepHit(tab.id, 1);
            return;
        }
        void api.search(tab.id, query);
    };

    return (
        <div className="flex flex-none flex-col gap-1.5 border-b border-line bg-chrome px-3 py-2">
            <form onSubmit={submit} className="flex flex-wrap items-center gap-1.5">
                <TextInput
                    size="xs"
                    autoFocus
                    className="min-w-[14rem] flex-1"
                    aria-label="Find in file"
                    placeholder="Find in file…"
                    leftSection={<IconSearch size={14} />}
                    value={needle}
                    onChange={(event) => setNeedle(event.currentTarget.value)}
                />
                <Toggle
                    label="Aa"
                    title="Match case"
                    on={caseSensitive}
                    onClick={() => setCaseSensitive((v) => !v)}
                />
                <Toggle
                    label="W"
                    title="Whole word"
                    on={wholeWord}
                    onClick={() => setWholeWord((v) => !v)}
                />
                <Toggle
                    label=".*"
                    title="Regular expression"
                    on={regex}
                    onClick={() => setRegex((v) => !v)}
                />
                {searching ? (
                    <Button
                        size="xs"
                        variant="light"
                        color="red"
                        onClick={() => void api.cancelSearch(tab.id)}
                    >
                        Stop
                    </Button>
                ) : (
                    <Button size="xs" variant="light" type="submit" disabled={!needle}>
                        Find
                    </Button>
                )}
                <ActionIcon
                    size="sm"
                    aria-label="Previous match"
                    disabled={!search?.hits.length}
                    onClick={() => api.stepHit(tab.id, -1)}
                >
                    <IconChevronUp size={15} />
                </ActionIcon>
                <ActionIcon
                    size="sm"
                    aria-label="Next match"
                    disabled={!search?.hits.length}
                    onClick={() => api.stepHit(tab.id, 1)}
                >
                    <IconChevronDown size={15} />
                </ActionIcon>
                <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setReplaceOpen((v) => !v)}
                    aria-expanded={replaceOpen}
                >
                    Replace…
                </Button>
                <ActionIcon
                    size="sm"
                    aria-label="Close find"
                    onClick={() => api.setFindOpen(tab.id, false)}
                >
                    <IconX size={15} />
                </ActionIcon>
            </form>
            {search && (
                <div className="flex items-center gap-3">
                    <Text size="xs" className="text-dimmed">
                        {search.error
                            ? search.error
                            : `${COUNT.format(search.total)}${search.truncated ? '+' : ''} ${search.total === 1 ? 'match' : 'matches'}${
                                  searching
                                      ? ` · searching ${Math.floor(percentOf(search.bytesRead, search.totalBytes))}%`
                                      : search.state === 'cancelled'
                                        ? ' · stopped'
                                        : ''
                              }`}
                    </Text>
                    {searching && (
                        <Progress
                            className="w-40"
                            value={percentOf(search.bytesRead, search.totalBytes)}
                            aria-label="Search progress"
                        />
                    )}
                </div>
            )}
            {isDirty(tab) && search && (
                <Text size="xs" className="text-dimmed">
                    Search reads the saved file, so line numbers here may differ from your edited
                    document. Save to search your changes.
                </Text>
            )}
            {replaceOpen && (
                <form
                    className="flex flex-wrap items-center gap-1.5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (needle) void api.replaceAll(tab.id, query, replacement);
                    }}
                >
                    <TextInput
                        size="xs"
                        className="min-w-[14rem] flex-1"
                        aria-label="Replace with"
                        placeholder="Replace with…"
                        value={replacement}
                        onChange={(event) => setReplacement(event.currentTarget.value)}
                    />
                    <Button
                        size="xs"
                        variant="light"
                        color="red"
                        type="submit"
                        disabled={!needle || !!tab.working}
                    >
                        Replace all in file
                    </Button>
                    <Text size="xs" className="text-dimmed">
                        Works line by line and saves the file.
                    </Text>
                </form>
            )}
        </div>
    );
}

function ResultsPanel({ tab }: { tab: FileTab }) {
    const api = useDbStudio();
    const search = tab.search;
    if (!search)
        return (
            <Text size="xs" className="p-3 text-dimmed">
                Search the file to see matches here.
            </Text>
        );
    return (
        <ul aria-label="Search results" className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
            {search.hits.slice(0, 1_000).map((hit, index) => (
                <li key={hit.offset}>
                    <button
                        type="button"
                        className={cx(
                            'flex w-full cursor-pointer gap-3 border-0 bg-transparent px-3 py-0.5 text-left text-[12px] hover:bg-hover',
                            index === search.current && 'bg-primary-soft',
                        )}
                        onClick={() => api.gotoHit(tab.id, index)}
                    >
                        <span className="w-16 flex-none text-right font-mono text-dimmed">
                            {COUNT.format(hit.line + 1)}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono">
                            {hit.preview.slice(0, hit.previewStart)}
                            <mark className="rounded-[2px] bg-primary-soft text-inherit">
                                {hit.preview.slice(
                                    hit.previewStart,
                                    hit.previewStart + Math.max(1, hit.length),
                                )}
                            </mark>
                            {hit.preview.slice(hit.previewStart + Math.max(1, hit.length))}
                        </span>
                    </button>
                </li>
            ))}
            {search.hits.length > 1_000 && (
                <li className="px-3 py-1 text-xs text-dimmed">
                    Showing the first 1,000 of {COUNT.format(search.hits.length)} received. Next and
                    previous reach them all.
                </li>
            )}
        </ul>
    );
}

function ItemsPanel({ tab }: { tab: FileTab }) {
    const api = useDbStudio();
    const [open, setOpen] = useState<DbItemText | null>(null);
    const view = tab.itemsView;
    const noun = tab.analyzed?.kind === 'document' ? 'document' : 'statement';
    const total = tab.itemsProgress?.count ?? view?.count ?? 0;
    const from = view?.from ?? 0;

    if (!tab.analyzed?.format) {
        return (
            <Text size="xs" className="p-3 text-dimmed">
                This file is not split into statements or documents.
            </Text>
        );
    }
    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex flex-none items-center gap-2 px-3 py-1">
                    <Text size="xs" className="text-dimmed">
                        {COUNT.format(total)} {noun}s
                        {tab.itemsProgress?.state === 'scanning' &&
                            ` · scanning ${Math.floor(percentOf(tab.itemsProgress.bytesRead, tab.itemsProgress.totalBytes))}%`}
                    </Text>
                    <div className="flex-1" />
                    <ActionIcon
                        size="sm"
                        aria-label="Previous page"
                        disabled={from === 0}
                        onClick={() => void api.loadItems(tab.id, Math.max(0, from - ITEMS_PAGE))}
                    >
                        <IconChevronUp size={15} />
                    </ActionIcon>
                    <ActionIcon
                        size="sm"
                        aria-label="Next page"
                        disabled={!view || from + ITEMS_PAGE >= view.count}
                        onClick={() => void api.loadItems(tab.id, from + ITEMS_PAGE)}
                    >
                        <IconChevronDown size={15} />
                    </ActionIcon>
                </div>
                <ul aria-label="Items" className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
                    {view?.items.map((item) => (
                        <li key={item.index}>
                            <button
                                type="button"
                                className={cx(
                                    'flex w-full cursor-pointer gap-3 border-0 bg-transparent px-3 py-0.5 text-left font-mono text-[12px] hover:bg-hover',
                                    open?.index === item.index && 'bg-primary-soft',
                                )}
                                onClick={() => void api.readItem(tab.id, item.index).then(setOpen)}
                            >
                                <span className="w-16 flex-none text-right text-dimmed">
                                    {COUNT.format(item.index + 1)}
                                </span>
                                <span
                                    className={cx(
                                        'w-20 flex-none truncate text-primary-text',
                                        item.problem && 'text-red-6',
                                    )}
                                    title={item.problem}
                                >
                                    {item.problem ? `${item.label}!` : item.label}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{item.preview}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
            {open && (
                <div className="flex min-h-0 w-[45%] flex-none flex-col border-l border-line">
                    <div className="flex flex-none items-center gap-2 px-3 py-1">
                        <Text size="xs" className="flex-1 text-dimmed">
                            {noun} {COUNT.format(open.index + 1)} · {formatSize(open.length)}
                            {open.truncated && ' · shown in part'}
                        </Text>
                        <Button size="xs" variant="subtle" onClick={() => void copyText(open.text)}>
                            Copy
                        </Button>
                        <ActionIcon
                            size="sm"
                            aria-label="Close preview"
                            onClick={() => setOpen(null)}
                        >
                            <IconX size={15} />
                        </ActionIcon>
                    </div>
                    <pre className="m-0 min-h-0 flex-1 overflow-auto bg-hover p-2 font-mono text-[12px] leading-5">
                        {open.text}
                    </pre>
                </div>
            )}
        </div>
    );
}

/**
 * One open file: a toolbar, an optional find bar, the editor (a virtualised line viewer for any
 * size of file, or the full text editor for small ones), a panel for search results or
 * statements, and a status line.
 */
export function FileEditorTab({ tab }: { tab: FileTab }) {
    const api = useDbStudio();
    const host = useStudioStore((state) => state.host);
    const [goto, setGoto] = useState('');
    const dirty = isDirty(tab);
    const language = languageOf(tab);
    const indexing = tab.progress?.state === 'indexing';
    const editable = tab.mode === 'viewer' && !!tab.table && !tab.working;
    const hitLine =
        tab.search && tab.search.current >= 0
            ? tab.search.hits[tab.search.current]?.line
            : undefined;
    const readRows = useMemo(
        () => (first: number, end: number) => api.readRows(tab.id, first, end),
        [api, tab.id],
    );
    const lineCount =
        tab.mode === 'text' && tab.text ? tab.text.current.split('\n').length : tab.lineCount;
    const noun = tab.analyzed?.kind === 'document' ? 'Documents' : 'Statements';

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const mod = event.ctrlKey || event.metaKey;
        if (!mod) return;
        const key = event.key.toLowerCase();
        if (key === 's') {
            event.preventDefault();
            void (event.shiftKey ? api.saveAs(tab.id) : api.save(tab.id));
        } else if (key === 'f' && tab.mode === 'viewer') {
            event.preventDefault();
            api.setFindOpen(tab.id, true);
        } else if (key === 'g' && tab.mode === 'viewer') {
            event.preventDefault();
            document.getElementById(`goto-${tab.id}`)?.focus();
        }
    };

    /** Keys the viewer passes on: copy, paste, delete and undo of whole lines. */
    const onCommand = (event: KeyboardEvent<HTMLDivElement>) => {
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (mod && key === 'c' && tab.selection) {
            event.preventDefault();
            void api.copySelection(tab.id);
        } else if (mod && key === 'v' && editable) {
            event.preventDefault();
            void api.pasteAfterSelection(tab.id);
        } else if (mod && key === 'z' && editable) {
            event.preventDefault();
            if (event.shiftKey) api.redo(tab.id);
            else api.undo(tab.id);
        } else if (mod && key === 'y' && editable) {
            event.preventDefault();
            api.redo(tab.id);
        } else if (
            (event.key === 'Delete' || event.key === 'Backspace') &&
            tab.selection &&
            editable
        ) {
            event.preventDefault();
            api.deleteSelection(tab.id);
        } else if (event.key === 'Escape') {
            api.select(tab.id, tab.selection?.head ?? 0, false);
        }
    };

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
            {/* Toolbar */}
            <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-line bg-chrome px-3 py-1.5">
                <Tooltip label="Save (Ctrl+S)">
                    <Button
                        size="xs"
                        variant={dirty ? 'filled' : 'light'}
                        leftSection={<IconDeviceFloppy size={14} />}
                        disabled={!dirty || !!tab.working || (tab.mode === 'viewer' && !tab.table)}
                        loading={tab.working?.op === 'save'}
                        onClick={() => void api.save(tab.id)}
                    >
                        Save
                    </Button>
                </Tooltip>
                <Button
                    size="xs"
                    variant="subtle"
                    disabled={!!tab.working || (tab.mode === 'viewer' && !tab.table)}
                    onClick={() => void api.saveAs(tab.id)}
                >
                    Save as…
                </Button>
                {tab.mode === 'viewer' && (
                    <>
                        <ActionIcon
                            aria-label="Undo"
                            size="sm"
                            disabled={!tab.table?.canUndo || !editable}
                            onClick={() => api.undo(tab.id)}
                        >
                            <IconArrowBackUp size={16} />
                        </ActionIcon>
                        <ActionIcon
                            aria-label="Redo"
                            size="sm"
                            disabled={!tab.table?.canRedo || !editable}
                            onClick={() => api.redo(tab.id)}
                        >
                            <IconArrowForwardUp size={16} />
                        </ActionIcon>
                    </>
                )}
                <Button
                    size="xs"
                    variant={tab.findOpen ? 'light' : 'subtle'}
                    leftSection={<IconSearch size={14} />}
                    onClick={() => api.setFindOpen(tab.id, !tab.findOpen)}
                >
                    Find
                </Button>
                {tab.analyzed?.format && (
                    <Button
                        size="xs"
                        variant={tab.panel === 'items' ? 'light' : 'subtle'}
                        leftSection={<IconListDetails size={14} />}
                        onClick={() =>
                            api.setPanel(tab.id, tab.panel === 'items' ? 'none' : 'items')
                        }
                    >
                        {noun}
                    </Button>
                )}
                {tab.mode === 'viewer' && (
                    <form
                        className="flex items-center gap-1"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const line = Number(goto);
                            if (Number.isFinite(line) && goto) api.goToLine(tab.id, line);
                        }}
                    >
                        <TextInput
                            id={`goto-${tab.id}`}
                            size="xs"
                            className="w-28"
                            aria-label="Go to line"
                            placeholder="Go to line…"
                            inputMode="numeric"
                            value={goto}
                            onChange={(event) =>
                                setGoto(event.currentTarget.value.replace(/[^0-9]/g, ''))
                            }
                        />
                    </form>
                )}
                <div className="flex-1" />
                {handlingFor(tab.file.size) !== 'stream' && (
                    <SegmentedControl
                        size="xs"
                        aria-label="Editor"
                        value={tab.mode}
                        onChange={(value) => void api.setMode(tab.id, value as 'viewer' | 'text')}
                        data={[
                            { value: 'text', label: 'Text editor' },
                            { value: 'viewer', label: 'Line viewer' },
                        ]}
                    />
                )}
            </div>

            {tab.journal && (
                <Alert color="yellow" className="m-2 flex-none">
                    <div className="flex items-center gap-3">
                        <span className="flex-1">
                            Unsaved changes from an earlier session were found for this file.
                        </span>
                        <Button
                            size="xs"
                            variant="light"
                            onClick={() => api.restoreJournal(tab.id)}
                        >
                            Restore
                        </Button>
                        <Button
                            size="xs"
                            variant="subtle"
                            onClick={() => api.discardJournal(tab.id)}
                        >
                            Discard
                        </Button>
                    </div>
                </Alert>
            )}
            {tab.error && (
                <Alert color="red" className="m-2 flex-none">
                    {tab.error}
                </Alert>
            )}
            {tab.notice && (
                <Alert color="blue" className="m-2 flex-none">
                    {tab.notice}
                </Alert>
            )}
            {indexing && tab.progress && (
                <div className="flex flex-none items-center gap-3 px-3 py-1">
                    <Text size="xs" className="text-dimmed">
                        Indexing…{' '}
                        {Math.floor(percentOf(tab.progress.bytesRead, tab.progress.totalBytes))}% —
                        you can read the file now; editing starts when it finishes.
                    </Text>
                    <Progress
                        className="w-40"
                        value={percentOf(tab.progress.bytesRead, tab.progress.totalBytes)}
                        aria-label="Indexing progress"
                    />
                </div>
            )}

            {tab.findOpen && <FindBar key={tab.id} tab={tab} />}

            {tab.mode === 'text' && handlingFor(tab.file.size) === 'large-file-mode' && (
                <div
                    role="status"
                    className="flex h-6 flex-none items-center gap-2 border-b border-line bg-warning-soft px-3 text-xs"
                >
                    <strong>Large File Mode</strong>
                    <span className="text-dimmed">
                        Prioritizing stability over advanced editor features: highlighting, folding
                        and suggestions are off.
                    </span>
                </div>
            )}

            {/* Editor */}
            <div className="relative flex min-h-0 flex-1">
                {tab.mode === 'text' && tab.text ? (
                    <CodeEditor
                        className="h-full w-full rounded-none border-0"
                        value={tab.text.current}
                        onChange={(value) => api.setText(tab.id, value)}
                        language={monacoLanguage(language)}
                        ariaLabel={`Editing ${tab.file.name}`}
                        purpose={{ kind: 'output' }}
                        largeFile={handlingFor(tab.file.size) === 'large-file-mode'}
                    />
                ) : (
                    <VirtualViewer
                        lineCount={tab.table?.lineCount ?? tab.lineCount}
                        version={tab.version}
                        language={language}
                        readRows={readRows}
                        reveal={tab.reveal}
                        onTopLine={(line) => api.setTopLine(tab.id, line)}
                        selection={tab.selection}
                        onSelect={(line, extend) => api.select(tab.id, line, extend)}
                        editable={editable}
                        onEditLine={(index, text) => api.setLine(tab.id, index, text)}
                        onInsertBelow={(index) => api.insertLines(tab.id, index + 1, [''])}
                        onCommand={onCommand}
                        hitLine={hitLine}
                    />
                )}
                {tab.working && (
                    <div className="absolute inset-x-0 top-0 z-10 bg-surface/90 px-3 py-2">
                        <Text size="xs" className="mb-1">
                            {tab.working.op === 'replace' ? 'Replacing' : 'Saving'}…{' '}
                            {Math.floor(percentOf(tab.working.bytes, tab.working.total))}%
                        </Text>
                        <Progress
                            value={percentOf(tab.working.bytes, tab.working.total)}
                            aria-label="Save progress"
                        />
                    </div>
                )}
            </div>

            {/* Results and statements */}
            {tab.panel !== 'none' && (
                <div className="flex h-56 flex-none flex-col border-t border-line bg-surface">
                    <div className="flex flex-none items-center gap-1 border-b border-line px-2 py-1">
                        <Button
                            size="xs"
                            variant={tab.panel === 'results' ? 'light' : 'subtle'}
                            onClick={() => api.setPanel(tab.id, 'results')}
                        >
                            Results
                        </Button>
                        {tab.analyzed?.format && (
                            <Button
                                size="xs"
                                variant={tab.panel === 'items' ? 'light' : 'subtle'}
                                onClick={() => api.setPanel(tab.id, 'items')}
                            >
                                {noun}
                            </Button>
                        )}
                        <div className="flex-1" />
                        <ActionIcon
                            size="sm"
                            aria-label="Close panel"
                            onClick={() => api.setPanel(tab.id, 'none')}
                        >
                            <IconX size={15} />
                        </ActionIcon>
                    </div>
                    {tab.panel === 'results' ? (
                        <ResultsPanel tab={tab} />
                    ) : (
                        <ItemsPanel tab={tab} />
                    )}
                </div>
            )}

            {/* Status */}
            <div className="flex flex-none items-center gap-4 border-t border-line bg-chrome px-3 py-0.5 text-[11px] text-dimmed">
                <span>{formatSize(tab.file.size)}</span>
                <span>{COUNT.format(lineCount)} lines</span>
                {tab.selection && tab.mode === 'viewer' && (
                    <span>
                        {selectionSize(tab.selection) === 1
                            ? `Line ${COUNT.format(selectionBounds(tab.selection).first + 1)}`
                            : `${COUNT.format(selectionSize(tab.selection))} lines selected`}
                    </span>
                )}
                <span>{tab.file.eol === '\r\n' ? 'CRLF' : 'LF'}</span>
                <span>{tab.mode === 'text' ? 'Text editor' : 'Line viewer'}</span>
                <div className="flex-1" />
                {host.state !== 'running' && host.state !== 'idle' && (
                    <span>File reader: {host.state}</span>
                )}
                {dirty && <span className="text-primary-text">Unsaved changes</span>}
            </div>
        </div>
    );
}
