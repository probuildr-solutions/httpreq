/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
    DbEditProgress,
    DbFileProgress,
    DbHostStatus,
    DbItemsAnalyzed,
    DbItemsProgress,
    DbSearchHits,
    DbSearchProgress,
    DbStudioBridge,
} from '@httpreq/shared';
import { settleConfirm, useConfirmStore } from '../confirm';
import { DbStudioPanel } from './DbStudioPanel';
import { resetStudio } from './studioStore';
import { StudioWorkspace } from './StudioWorkspace';
import { DbStudioContext, useDbStudioManager } from './useDbStudio';

// Monaco needs workers and a layout engine that jsdom does not have; a textarea stands in for it.
vi.mock('../editor/CodeEditor', () => ({
    CodeEditor: ({
        value,
        onChange,
        ariaLabel,
    }: {
        value: string;
        onChange?: (value: string) => void;
        ariaLabel: string;
    }) => (
        <textarea
            aria-label={ariaLabel}
            value={value}
            onChange={(event) => onChange?.(event.currentTarget.value)}
        />
    ),
}));

const LINES = 5_000;
const BIG = 100 * 1024 * 1024;

/** A bridge over a file of 5,000 lines "row N", with hooks to push events and inspect calls. */
const makeBridge = (options: { size?: number; name?: string } = {}) => {
    const size = options.size ?? BIG;
    const name = options.name ?? 'dump.sql';
    const listeners: Record<string, ((value: never) => void) | undefined> = {};
    const file = { fileId: 'f1', name, size, eol: '\n' as const, fileKey: 'key1', mtimeMs: 7 };
    const bridge: DbStudioBridge = {
        getStatus: vi.fn(async () => ({ state: 'idle' as const, restarts: 0 })),
        dbRequest: vi.fn(async () => ({ ok: true as const, value: undefined })),
        onDbEvent: () => () => undefined,
        setDbPassword: vi.fn(async () => true),
        hasDbPassword: vi.fn(async () => false),
        deleteDbPassword: vi.fn(async () => undefined),
        pickFile: vi.fn(async () => ({ ok: true as const, value: { token: 't', name, size } })),
        openFile: vi.fn(async () => ({ ok: true as const, value: file })),
        readLines: vi.fn(async (_id, from, count) => ({
            ok: true as const,
            value: {
                lines: Array.from(
                    { length: Math.max(0, Math.min(count, LINES - from)) },
                    (_, i) => ({ line: from + i, text: `row ${from + i}`, truncated: false }),
                ),
                lineCount: LINES,
                complete: true,
            },
        })),
        closeFile: vi.fn(async () => ({ ok: true as const, value: undefined })),
        analyzeFile: vi.fn(async () => ({
            ok: true as const,
            value: { format: null, kind: null } as DbItemsAnalyzed,
        })),
        listItems: vi.fn(async (_id, from) => ({
            ok: true as const,
            value: {
                items: [0, 1, 2].map((i) => ({
                    index: from + i,
                    start: (from + i) * 40,
                    length: 40,
                    label: 'INSERT',
                    preview: `INSERT INTO t VALUES (${from + i});`,
                })),
                count: 3_000,
                complete: true,
            },
        })),
        readItem: vi.fn(async (_id, index) => ({
            ok: true as const,
            value: {
                index,
                start: 0,
                length: 40,
                text: `INSERT INTO t VALUES (${index});`,
                truncated: false,
            },
        })),
        itemAt: vi.fn(async () => ({ ok: true as const, value: { index: 0 } })),
        startSearch: vi.fn(async (_id, searchId) => ({ ok: true as const, value: { searchId } })),
        cancelSearch: vi.fn(async () => ({ ok: true as const, value: undefined })),
        readText: vi.fn(async () => ({
            ok: true as const,
            value: { text: 'select 1;\nselect 2;\n', eol: '\n' as const, lossy: false },
        })),
        saveFile: vi.fn(async () => ({
            ok: true as const,
            value: {
                fileId: 'f1',
                name,
                size: 123,
                eol: '\n' as const,
                fileKey: 'key1',
                mtimeMs: 8,
            },
        })),
        saveFileAs: vi.fn(async () => ({ ok: true as const, value: null })),
        saveText: vi.fn(async () => ({ ok: true as const, value: null })),
        replaceAll: vi.fn(async () => ({
            ok: true as const,
            value: {
                fileId: 'f1',
                name,
                size: 99,
                eol: '\n' as const,
                fileKey: 'key1',
                mtimeMs: 9,
                replacements: 4,
            },
        })),
        onFileProgress: (l) => ((listeners.file = l as never), () => undefined),
        onItemsProgress: (l) => ((listeners.items = l as never), () => undefined),
        onSearchHits: (l) => ((listeners.hits = l as never), () => undefined),
        onSearchProgress: (l) => ((listeners.search = l as never), () => undefined),
        onEditProgress: (l) => ((listeners.edit = l as never), () => undefined),
        onHostStatus: (l) => ((listeners.host = l as never), () => undefined),
    };
    const push = {
        file: (p: DbFileProgress) => act(() => listeners.file?.(p as never)),
        items: (p: DbItemsProgress) => act(() => listeners.items?.(p as never)),
        hits: (b: DbSearchHits) => act(() => listeners.hits?.(b as never)),
        search: (p: DbSearchProgress) => act(() => listeners.search?.(p as never)),
        edit: (p: DbEditProgress) => act(() => listeners.edit?.(p as never)),
        host: (s: DbHostStatus) => act(() => listeners.host?.(s as never)),
    };
    const ready = () =>
        push.file({
            fileId: 'f1',
            state: 'ready',
            bytesRead: size,
            totalBytes: size,
            lines: LINES,
        });
    return { bridge, push, ready };
};

function Harness({ bridge, children }: { bridge: DbStudioBridge; children?: ReactNode }) {
    const api = useDbStudioManager(bridge);
    return (
        <DbStudioContext.Provider value={api}>
            <DbStudioPanel />
            <StudioWorkspace />
            {children}
        </DbStudioContext.Provider>
    );
}

const rowText = (index: number) =>
    document.querySelector(`[data-line="${index}"]`)?.textContent ?? null;

/** Picks a file and chooses to open it in the file editor from the Open file dialog. */
const openFile = async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /Open file/ })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in file editor' }));
    await screen.findByRole('tab', { selected: true });
};

const editLine = async (index: number, value: string) => {
    fireEvent.doubleClick(document.querySelector(`[data-line="${index}"]`)!);
    const input = await screen.findByLabelText(`Edit line ${index + 1}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(rowText(index)).toContain(value));
};

beforeEach(() => {
    resetStudio();
    localStorage.clear();
});
afterEach(() => {
    useConfirmStore.setState({ request: null });
});

describe('without the desktop bridge', () => {
    it('says Database Studio is part of the desktop app', () => {
        render(
            <DbStudioContext.Provider value={{ available: false } as never}>
                <DbStudioPanel />
            </DbStudioContext.Provider>,
        );
        expect(screen.getByText(/part of the desktop app/)).toBeTruthy();
    });
});

describe('opening files', () => {
    it('opens a large file by token in the line viewer, and shows its first lines', async () => {
        const fake = makeBridge();
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        expect(fake.bridge.openFile).toHaveBeenCalledWith('t'); // a token, never a path
        expect(fake.bridge.readText).not.toHaveBeenCalled(); // too large for the full editor

        fake.push.file({
            fileId: 'f1',
            state: 'indexing',
            bytesRead: 10,
            totalBytes: 100,
            lines: 40,
        });
        // Lines can be read while the index is still running.
        await waitFor(() => expect(rowText(0)).toContain('row 0'));
        expect(screen.getByRole('progressbar', { name: 'Indexing progress' })).toBeTruthy();

        fake.ready();
        await waitFor(() =>
            expect(screen.queryByRole('progressbar', { name: 'Indexing progress' })).toBeNull(),
        );
        expect(screen.getByText(/5,000 lines/)).toBeTruthy();
        // Only a screenful of rows exists in the DOM, not 5,000.
        expect(document.querySelectorAll('[data-line]').length).toBeLessThan(100);
        expect(rowText(0)).toContain('row 0');
    });

    it('opens a small file in the text editor, and lists it in the sidebar', async () => {
        const fake = makeBridge({ size: 2_000, name: 'small.sql' });
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        const editor = (await screen.findByLabelText('Editing small.sql')) as HTMLTextAreaElement;
        expect(editor.value).toBe('select 1;\nselect 2;\n');
        expect(screen.getByRole('list', { name: 'Open files' })).toBeTruthy();
    });

    it('shows a failed open as a message', async () => {
        const fake = makeBridge();
        fake.bridge.openFile = vi.fn(async () => ({
            ok: false as const,
            error: { code: 'NOT_FOUND', message: 'The file does not exist.' },
        }));
        render(<Harness bridge={fake.bridge} />);
        fireEvent.click(screen.getAllByRole('button', { name: /Open file/ })[0]!);
        fireEvent.click(await screen.findByRole('button', { name: 'Open in file editor' }));
        expect((await screen.findAllByText('The file does not exist.')).length).toBeGreaterThan(0);
    });

    it('asks what to do with the file before opening it', async () => {
        const fake = makeBridge();
        render(<Harness bridge={fake.bridge} />);
        fireEvent.click(screen.getAllByRole('button', { name: /Open file/ })[0]!);
        await screen.findByRole('button', { name: 'Open in file editor' });
        expect(fake.bridge.pickFile).toHaveBeenCalled();
        expect(fake.bridge.openFile).not.toHaveBeenCalled();
        expect(screen.queryByRole('tab')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Open in file editor' })).toBeNull(),
        );
        expect(fake.bridge.openFile).not.toHaveBeenCalled();
    });

    it('does nothing when the user cancels the file dialog', async () => {
        const fake = makeBridge();
        fake.bridge.pickFile = vi.fn(async () => ({ ok: true as const, value: null }));
        render(<Harness bridge={fake.bridge} />);
        fireEvent.click(screen.getAllByRole('button', { name: /Open file/ })[0]!);
        await waitFor(() => expect(fake.bridge.pickFile).toHaveBeenCalled());
        expect(fake.bridge.openFile).not.toHaveBeenCalled();
        expect(screen.queryByRole('tab')).toBeNull();
    });

    it('keeps several files open as tabs and closes one', async () => {
        const fake = makeBridge();
        let n = 0;
        fake.bridge.openFile = vi.fn(async () => ({
            ok: true as const,
            value: {
                fileId: `f${++n}`,
                name: `file${n}.sql`,
                size: BIG,
                eol: '\n' as const,
                fileKey: `k${n}`,
                mtimeMs: 1,
            },
        }));
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        fireEvent.click(screen.getByRole('button', { name: 'Open a file' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Open in file editor' }));
        await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
        fireEvent.click(screen.getByRole('button', { name: 'Close file2.sql' }));
        await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
        expect(fake.bridge.closeFile).toHaveBeenCalledWith('f2');
        expect(screen.getByRole('tab', { selected: true }).textContent).toContain('file1.sql');
    });

    it('tells the user when the reader process died', async () => {
        const fake = makeBridge();
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        fake.push.host({ state: 'crashed', restarts: 0 });
        expect(await screen.findByText(/file reader stopped unexpectedly/)).toBeTruthy();
        expect(screen.queryByRole('tab')).toBeNull();
    });
});

describe('line editing in the viewer', () => {
    const open = async (fake: ReturnType<typeof makeBridge>) => {
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        fake.ready();
        await waitFor(() => expect(rowText(2)).toContain('row 2'));
    };

    it('cannot save an unedited file, and shows an edit as unsaved with a marker', async () => {
        const fake = makeBridge();
        await open(fake);
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
            true,
        );

        await editLine(2, 'changed line');
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
        expect(screen.getByLabelText('Unsaved changes')).toBeTruthy(); // the dot on the tab
        expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
            false,
        );
    });

    it('selects lines, deletes them, and undoes it', async () => {
        const fake = makeBridge();
        await open(fake);
        fireEvent.click(screen.getByRole('button', { name: 'Select line 2' }));
        fireEvent.click(screen.getByRole('button', { name: 'Select line 4' }), { shiftKey: true });
        expect(screen.getByText('3 lines selected')).toBeTruthy();

        fireEvent.keyDown(screen.getByRole('region', { name: 'File content' }), { key: 'Delete' });
        await waitFor(() => expect(rowText(1)).toContain('row 4'));
        expect(screen.getByText(/4,997 lines/)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(rowText(1)).toContain('row 1'));
        expect(screen.getByText(/5,000 lines/)).toBeTruthy();
    });

    it('saves the edited document as pieces over the file, not as its text', async () => {
        const fake = makeBridge();
        await open(fake);
        await editLine(0, 'first');

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(fake.bridge.saveFile).toHaveBeenCalled());
        const [fileId, pieces, eol] = vi.mocked(fake.bridge.saveFile).mock.calls[0]!;
        expect(fileId).toBe('f1');
        expect(eol).toBe('\n');
        expect(pieces).toEqual([
            { kind: 'added', lines: ['first'] },
            { kind: 'original', from: 1, count: LINES - 1 },
        ]);
        // After the save the file is re-indexed and the document starts clean again.
        await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    });

    it('shows save progress while a save runs', async () => {
        const fake = makeBridge();
        let finish: () => void = () => undefined;
        fake.bridge.saveFile = vi.fn(
            () =>
                new Promise<Awaited<ReturnType<DbStudioBridge['saveFile']>>>((resolve) => {
                    finish = () =>
                        resolve({
                            ok: true as const,
                            value: {
                                fileId: 'f1',
                                name: 'dump.sql',
                                size: 1,
                                eol: '\n' as const,
                                fileKey: 'key1',
                                mtimeMs: 8,
                            },
                        });
                }),
        );
        await open(fake);
        await editLine(0, 'x');
        fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
        fake.push.edit({ fileId: 'f1', op: 'save', bytes: 50, totalBytes: 100 });
        expect(await screen.findByRole('progressbar', { name: 'Save progress' })).toBeTruthy();
        expect(screen.getByText(/Saving… 50%/)).toBeTruthy();
        await act(async () => finish());
        await waitFor(() =>
            expect(screen.queryByRole('progressbar', { name: 'Save progress' })).toBeNull(),
        );
    });

    it('reports a failed save and keeps the edits', async () => {
        const fake = makeBridge();
        fake.bridge.saveFile = vi.fn(async () => ({
            ok: false as const,
            error: {
                code: 'CONFLICT',
                message: 'The file was changed on disk after it was opened.',
            },
        }));
        await open(fake);
        await editLine(0, 'x');
        fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
        expect(await screen.findByText(/changed on disk/)).toBeTruthy();
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    it('asks before closing a tab with unsaved changes, and keeps a recovery copy', async () => {
        const fake = makeBridge();
        await open(fake);
        await editLine(0, 'precious');

        fireEvent.click(screen.getByRole('button', { name: 'Close dump.sql' }));
        await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
        expect(useConfirmStore.getState().request?.title).toMatch(/Close dump\.sql/);
        act(() => settleConfirm('cancel'));
        expect(screen.getByRole('tab')).toBeTruthy();
        expect(fake.bridge.closeFile).not.toHaveBeenCalled();

        // The edit is written to the journal shortly after it is made.
        await waitFor(
            () =>
                expect(localStorage.getItem('httpreq.dbstudio.journal.key1') ?? '').toContain(
                    'precious',
                ),
            { timeout: 2000 },
        );
    });

    it('offers to restore unsaved work from an earlier session', async () => {
        localStorage.setItem(
            'httpreq.dbstudio.journal.key1',
            JSON.stringify({
                version: 1,
                kind: 'pieces',
                size: BIG,
                mtimeMs: 7,
                eol: '\n',
                pieces: [
                    { kind: 'original', from: 0, count: 1 },
                    { kind: 'added', lines: ['recovered'] },
                    { kind: 'original', from: 2, count: LINES - 2 },
                ],
            }),
        );
        const fake = makeBridge();
        await open(fake);
        expect(await screen.findByText(/Unsaved changes from an earlier session/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
        await waitFor(() => expect(rowText(1)).toContain('recovered'));
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });
});

describe('the text editor for small files', () => {
    it('saves its content as one block of lines', async () => {
        const fake = makeBridge({ size: 2_000, name: 'small.sql' });
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        const editor = await screen.findByLabelText('Editing small.sql');
        fireEvent.change(editor, { target: { value: 'select 3;\nselect 4;' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(fake.bridge.saveFile).toHaveBeenCalled());
        expect(vi.mocked(fake.bridge.saveFile).mock.calls[0]![1]).toEqual([
            { kind: 'added', lines: ['select 3;', 'select 4;'] },
        ]);
    });

    it('can be switched to the line viewer when nothing is unsaved', async () => {
        const fake = makeBridge({ size: 2_000, name: 'small.sql' });
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        await screen.findByLabelText('Editing small.sql');
        fireEvent.click(screen.getByRole('radio', { name: 'Line viewer' }));
        await waitFor(() => expect(screen.queryByLabelText('Editing small.sql')).toBeNull());
        expect(screen.getByRole('region', { name: 'File content' })).toBeTruthy();
    });
});

describe('find, replace and statements', () => {
    const open = async (fake: ReturnType<typeof makeBridge>) => {
        render(<Harness bridge={fake.bridge} />);
        await openFile();
        fake.ready();
        await waitFor(() => expect(rowText(0)).toContain('row 0'));
    };

    it('searches the file on disk, streams hits and jumps to the one clicked', async () => {
        const fake = makeBridge();
        await open(fake);
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));
        fireEvent.change(await screen.findByLabelText('Find in file'), {
            target: { value: 'needle' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
        fireEvent.click(screen.getAllByRole('button', { name: 'Find' }).at(-1)!);
        await waitFor(() => expect(fake.bridge.startSearch).toHaveBeenCalled());
        const [fileId, searchId, query] = vi.mocked(fake.bridge.startSearch).mock.calls[0]!;
        expect(fileId).toBe('f1');
        expect(searchId).toMatch(/^[0-9a-f]{16}$/);
        expect(query).toEqual({
            text: 'needle',
            caseSensitive: true,
            wholeWord: false,
            regex: false,
        });

        // Hits can arrive before the start call has replied.
        fake.push.hits({
            searchId,
            fileId: 'f1',
            hits: [
                { offset: 100, line: 41, length: 6, preview: 'a needle b', previewStart: 2 },
                { offset: 900, line: 3_999, length: 6, preview: 'needle again', previewStart: 0 },
            ],
        });
        fake.push.search({
            searchId,
            fileId: 'f1',
            state: 'running',
            bytesRead: 50,
            totalBytes: 100,
            hits: 2,
            truncated: false,
        });
        expect(await screen.findByText(/2 matches · searching 50%/)).toBeTruthy();

        fireEvent.click(screen.getByText('again', { exact: false }).closest('button')!);
        await waitFor(() => expect(rowText(3_999)).toContain('row 3999'));
        fake.push.search({
            searchId,
            fileId: 'f1',
            state: 'done',
            bytesRead: 100,
            totalBytes: 100,
            hits: 2,
            truncated: false,
        });
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    });

    it('stops a running search', async () => {
        const fake = makeBridge();
        await open(fake);
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));
        fireEvent.change(await screen.findByLabelText('Find in file'), { target: { value: 'x' } });
        fireEvent.click(screen.getAllByRole('button', { name: 'Find' }).at(-1)!);
        fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
        await waitFor(() => expect(fake.bridge.cancelSearch).toHaveBeenCalled());
    });

    it('replaces in the whole file only after confirmation', async () => {
        const fake = makeBridge();
        await open(fake);
        fireEvent.click(screen.getByRole('button', { name: 'Find' }));
        fireEvent.change(await screen.findByLabelText('Find in file'), {
            target: { value: 'row' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
        fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'ROW' } });
        fireEvent.click(screen.getByRole('button', { name: 'Replace all in file' }));
        await waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
        expect(fake.bridge.replaceAll).not.toHaveBeenCalled();
        act(() => settleConfirm('confirm'));
        await waitFor(() =>
            expect(fake.bridge.replaceAll).toHaveBeenCalledWith(
                'f1',
                expect.objectContaining({ text: 'row' }),
                'ROW',
            ),
        );
    });

    it('lists statements of an SQL file and shows one in full', async () => {
        const fake = makeBridge();
        fake.bridge.analyzeFile = vi.fn(async () => ({
            ok: true as const,
            value: { format: 'sql-mysql' as const, kind: 'statement' as const },
        }));
        await open(fake);
        fake.push.items({
            fileId: 'f1',
            state: 'scanning',
            bytesRead: 10,
            totalBytes: 100,
            count: 1_200,
        });
        fireEvent.click(await screen.findByRole('button', { name: 'Statements' }));
        expect(await screen.findByText('INSERT INTO t VALUES (0);')).toBeTruthy();
        expect(screen.getByText(/1,200 statements/)).toBeTruthy();
        fireEvent.click(screen.getByText('INSERT INTO t VALUES (1);').closest('button')!);
        await waitFor(() => expect(fake.bridge.readItem).toHaveBeenCalledWith('f1', 1));
        expect(await screen.findByText(/statement 2 ·/)).toBeTruthy();
    });
});
