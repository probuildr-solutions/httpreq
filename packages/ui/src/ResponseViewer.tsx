import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { applyIndentation, BASE_EDITOR_OPTIONS } from './editor/editorOptions';
import './monaco';

interface Props {
  /**
   * Identifies the text shown, e.g. `<response>:pretty`. Each document keeps its own model and
   * scroll position, so switching back to a view already seen is a model swap, not a reload.
   */
  documentKey: string;
  /** Documents outside this group (other responses) are disposed when the group changes. */
  group: string;
  value: string;
  language: string;
  theme: string;
  options: monaco.editor.IEditorOptions;
  /** Highlights every match of `query` and reveals the `current` (zero-based) one. */
  find?: { query: string; current: number };
  /** Reports the number of matches whenever the search or the text changes. */
  onFindCount?: (count: number) => void;
  /** Ctrl/Cmd+F inside the editor: the host shows its own search bar instead of Monaco's. */
  onFindRequest?: () => void;
}

/** Matches beyond this are not highlighted, so a one-letter search in a huge body stays fast. */
const MAX_FIND_MATCHES = 5000;

interface Document {
  model: monaco.editor.ITextModel;
  value: string;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

/**
 * The read-only response body viewer. One Monaco instance lives for as long as the panel does;
 * Raw and Pretty are two models on it, created once each, and switching swaps the model and
 * restores that view's scroll position instead of rebuilding the editor or re-setting its text.
 */
export default function ResponseViewer({
  documentKey,
  group,
  value,
  language,
  theme,
  options,
  find,
  onFindCount,
  onFindRequest,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const documents = useRef(new Map<string, Document>());
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const callbacks = useRef({ onFindCount, onFindRequest });
  callbacks.current = { onFindCount, onFindRequest };

  useEffect(() => {
    const created = monaco.editor.create(host.current!, {
      ...BASE_EDITOR_OPTIONS,
      readOnly: true,
      domReadOnly: true,
      model: null,
    });
    instance.current = created;
    created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () =>
      callbacks.current.onFindRequest?.(),
    );
    const owned = documents.current;
    return () => {
      decorations.current?.clear();
      decorations.current = null;
      created.dispose();
      for (const document of owned.values()) document.model.dispose();
      owned.clear();
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = instance.current;
    if (!editor) return;
    const owned = documents.current;
    let document = owned.get(documentKey);
    if (!document) {
      const model = monaco.editor.createModel(value, language);
      applyIndentation(model);
      document = { model, value, viewState: null };
      owned.set(documentKey, document);
    } else {
      if (document.value !== value) {
        document.model.setValue(value);
        document.value = value;
        document.viewState = null;
      }
      if (document.model.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(document.model, language);
      }
    }

    const current = editor.getModel();
    if (current !== document.model) {
      for (const other of owned.values()) {
        if (other.model === current) other.viewState = editor.saveViewState();
      }
      editor.setModel(document.model);
      if (document.viewState) editor.restoreViewState(document.viewState);
    }

    // A new response replaces the old one; its models are no longer reachable.
    for (const [key, other] of owned) {
      if (!key.startsWith(`${group}:`)) {
        other.model.dispose();
        owned.delete(key);
      }
    }
  }, [documentKey, group, value, language]);

  const query = find?.query ?? '';
  const current = find?.current ?? 0;
  useEffect(() => {
    const editor = instance.current;
    const model = editor?.getModel();
    decorations.current?.clear();
    decorations.current = null;
    if (!editor || !model || !query) {
      callbacks.current.onFindCount?.(0);
      return;
    }
    const matches = model.findMatches(query, false, false, false, null, false, MAX_FIND_MATCHES);
    callbacks.current.onFindCount?.(matches.length);
    if (matches.length === 0) return;
    const active = Math.min(current, matches.length - 1);
    decorations.current = editor.createDecorationsCollection(
      matches.map((match, index) => ({
        range: match.range,
        options: {
          className: index === active ? 'hr-find-current' : 'hr-find-match',
          overviewRuler: {
            color: index === active ? '#f59f00' : '#f59f0088',
            position: monaco.editor.OverviewRulerLane.Center,
          },
        },
      })),
    );
    editor.revealRangeInCenterIfOutsideViewport(matches[active]!.range);
  }, [query, current, documentKey, value]);

  useEffect(() => monaco.editor.setTheme(theme), [theme]);
  useEffect(() => instance.current?.updateOptions(options), [options]);

  return <div ref={host} style={{ width: '100%', height: '100%' }} />;
}
