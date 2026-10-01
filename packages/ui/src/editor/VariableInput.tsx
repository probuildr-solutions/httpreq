/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconEye, IconEyeOff } from '@tabler/icons-react';
import {
    forwardRef,
    useCallback,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type InputHTMLAttributes,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { parseTemplate } from '@httpreq/api-client';
import { useWorkbenchStore } from '../store';
import { useVariables } from '../variableContext';
import { ActionIcon, Button, cx, Group, Popover, Text, TextInput, UnstyledButton } from '../kit';

type NativeProps = Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'size' | 'type'
>;

export interface VariableInputProps extends NativeProps {
    value: string;
    onChange: (value: string) => void;
    /** `box` is a bordered field; `cell` is borderless, for editable tables. */
    variant?: 'box' | 'cell';
    /** Masks the value (password field) until the user reveals it. */
    masked?: boolean;
    /** Monospace text, for URLs and values. */
    mono?: boolean;
    rightSection?: ReactNode;
    invalid?: boolean;
    /** Offers `{{variable}}` completion after typing `{{`. */
    completion?: boolean;
}

const COMPLETION_TRIGGER = /\{\{\s*([^{}\s]*)$/;
const CLOSE_DELAY = 180;

/**
 * Single-line input that highlights `{{variables}}` without changing the text. A mirror layer
 * behind a transparent-text input renders the same characters with highlighted variable spans,
 * kept aligned while the input scrolls. Hovering a variable shows its resolved value and source;
 * secret values stay masked unless explicitly revealed.
 */
/**
 * The mirror and the input must share every metric that affects glyph positions.
 *
 * Ligatures are off: the monospace stack starts with coding fonts (JetBrains Mono, Cascadia Code)
 * whose contextual ligatures redraw `//`, `://`, `=>` and the like as joined glyphs, so a typed
 * `https://` could look as if a slash was missing, and the caret no longer matched the characters.
 */
const GLYPH_METRICS =
    '[font-family:inherit] [font-size:inherit] [font-variant-ligatures:none] [font-feature-settings:"liga"_0,"calt"_0] tracking-normal px-[var(--vi-padding)] leading-[calc(var(--vi-height)-2px)] whitespace-pre';

const ROOT = [
    'relative flex h-[var(--vi-height)] min-w-0 items-center font-sans text-sm text-fg',
    '[--vi-height:var(--control-h)] [--vi-padding:var(--control-px)]',
    'data-[mono]:font-mono data-[mono]:text-[12.5px]',
    'data-[variant=box]:rounded-sm data-[variant=box]:border data-[variant=box]:border-line data-[variant=box]:bg-field',
    'data-[variant=box]:focus-within:border-primary data-[variant=box]:data-[invalid]:border-danger',
    // Inside a table cell the field is one row tall and takes the cell's padding.
    'data-[variant=cell]:bg-transparent data-[variant=cell]:[--vi-height:28px] data-[variant=cell]:[--vi-padding:8px]',
    'data-[variant=cell]:focus-within:shadow-[inset_0_0_0_1px_var(--color-primary)]',
    'data-[disabled]:opacity-60',
].join(' ');

/** A `{{variable}}` drawn by the mirror: accent when defined, red when the environment lacks it. */
const VARIABLE_CHIP = [
    'rounded-[3px] bg-var-bg text-var-fg shadow-[0_0_0_1px_var(--color-var-ring)]',
    'data-[defined=false]:bg-var-missing-bg data-[defined=false]:text-var-missing-fg data-[defined=false]:shadow-[0_0_0_1px_var(--color-var-missing-ring)]',
].join(' ');

export const VariableInput = forwardRef<HTMLInputElement, VariableInputProps>(
    function VariableInput(
        {
            value,
            onChange,
            variant = 'box',
            masked = false,
            mono = true,
            rightSection,
            invalid,
            completion = true,
            className,
            onKeyDown,
            onBlur,
            disabled,
            ...inputProps
        },
        forwardedRef,
    ) {
        const { resolver } = useVariables();
        const inputRef = useRef<HTMLInputElement>(null);
        const mirrorRef = useRef<HTMLDivElement>(null);
        const rootRef = useRef<HTMLDivElement>(null);
        useImperativeHandle(forwardedRef, () => inputRef.current!, []);

        const [revealed, setRevealed] = useState(false);
        // A value that starts with a {{reference}} names a secret rather than containing one.
        const hidden = masked && !revealed && !value.trimStart().startsWith('{{');
        const segments = useMemo(() => (hidden ? [] : parseTemplate(value)), [value, hidden]);
        const highlighted = segments.some((segment) => segment.variable);

        /* Scroll sync between the input and its mirror. */
        const syncScroll = useCallback(() => {
            const input = inputRef.current;
            const mirror = mirrorRef.current;
            if (input && mirror) mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
        }, []);
        useLayoutEffect(syncScroll, [value, syncScroll]);

        /*
         * Hover card for the variable under the pointer. Once the user starts editing the variable in
         * it, the card is pinned: it stays open, on that variable, until it is saved, cancelled or
         * dismissed, however the pointer moves.
         */
        const [hover, setHover] = useState<{ name: string; left: number; width: number } | null>(
            null,
        );
        const pinned = useRef(false);
        const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
        const keepHover = () => clearTimeout(closeTimer.current);
        const releaseHover = () => {
            clearTimeout(closeTimer.current);
            if (pinned.current) return;
            closeTimer.current = setTimeout(() => setHover(null), CLOSE_DELAY);
        };
        const dismissHover = () => {
            clearTimeout(closeTimer.current);
            pinned.current = false;
            setHover(null);
        };
        const onPointerMove = (clientX: number, clientY: number) => {
            const mirror = mirrorRef.current;
            const root = rootRef.current;
            if (!mirror || !root || !highlighted || pinned.current) return;
            const origin = root.getBoundingClientRect();
            for (const span of mirror.querySelectorAll<HTMLElement>('[data-variable]')) {
                const rect = span.getBoundingClientRect();
                if (
                    clientX >= rect.left &&
                    clientX <= rect.right &&
                    clientY >= rect.top &&
                    clientY <= rect.bottom
                ) {
                    keepHover();
                    const name = span.dataset.variable!;
                    setHover((current) =>
                        current?.name === name && current.left === rect.left - origin.left
                            ? current
                            : { name, left: rect.left - origin.left, width: rect.width },
                    );
                    return;
                }
            }
            if (hover) releaseHover();
        };

        /* `{{` completion. */
        const [suggest, setSuggest] = useState<{ query: string; index: number } | null>(null);
        const suggestions = useMemo(() => {
            if (!suggest) return [];
            const query = suggest.query.toLowerCase();
            return resolver
                .names()
                .filter((name) => name.toLowerCase().includes(query))
                .slice(0, 8);
        }, [suggest, resolver]);

        const updateSuggestions = () => {
            const input = inputRef.current;
            // Read the live field type: typing `{{` into a masked field unmasks it in the same keystroke.
            if (
                !completion ||
                !input ||
                input.type === 'password' ||
                input.selectionStart !== input.selectionEnd
            ) {
                setSuggest(null);
                return;
            }
            const match = COMPLETION_TRIGGER.exec(input.value.slice(0, input.selectionStart ?? 0));
            setSuggest(match ? { query: match[1]!, index: 0 } : null);
        };

        const accept = (name: string) => {
            const input = inputRef.current;
            if (!input) return;
            const caret = input.selectionStart ?? value.length;
            const before = value.slice(0, caret).replace(COMPLETION_TRIGGER, '');
            const after = value.slice(caret).replace(/^[^{}\s]*\}\}/, '');
            const inserted = `{{${name}}}`;
            onChange(`${before}${inserted}${after}`);
            setSuggest(null);
            const position = before.length + inserted.length;
            requestAnimationFrame(() => {
                input.setSelectionRange(position, position);
                syncScroll();
            });
        };

        const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
            if (suggest && suggestions.length) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    setSuggest({
                        ...suggest,
                        index: (suggest.index + step + suggestions.length) % suggestions.length,
                    });
                    return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    accept(suggestions[suggest.index]!);
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setSuggest(null);
                    return;
                }
            }
            onKeyDown?.(event);
        };

        const listId = `${inputProps.id ?? inputProps.name ?? 'variable'}-suggestions`;
        const suggestionsOpen = !!suggest && suggestions.length > 0;

        return (
            <div
                ref={rootRef}
                className={cx(ROOT, className)}
                data-variant={variant}
                data-mono={mono || undefined}
                data-invalid={invalid || undefined}
                data-disabled={disabled || undefined}
            >
                <Popover opened={suggestionsOpen} position="bottom-start" offset={4} width="target">
                    <Popover.Target>
                        <div className="relative h-full min-w-0 flex-1 overflow-hidden">
                            {highlighted && (
                                <div
                                    ref={mirrorRef}
                                    // Draws the text; the input above it draws only the caret while variables are highlighted.
                                    className={cx(
                                        GLYPH_METRICS,
                                        'pointer-events-none absolute inset-0 overflow-visible text-fg will-change-transform',
                                    )}
                                    aria-hidden
                                >
                                    {segments.map((segment) =>
                                        segment.variable ? (
                                            <span
                                                key={segment.start}
                                                data-variable={segment.variable}
                                                data-defined={
                                                    resolver.lookup(segment.variable)
                                                        ? 'true'
                                                        : 'false'
                                                }
                                                className={VARIABLE_CHIP}
                                            >
                                                {segment.text}
                                            </span>
                                        ) : (
                                            <span key={segment.start}>{segment.text}</span>
                                        ),
                                    )}
                                </div>
                            )}
                            <input
                                {...inputProps}
                                ref={inputRef}
                                className={cx(
                                    GLYPH_METRICS,
                                    'relative block size-full border-0 bg-transparent text-inherit outline-0',
                                    'data-[highlighted]:text-transparent data-[highlighted]:caret-fg',
                                    'data-[highlighted]:selection:bg-selection data-[highlighted]:selection:text-transparent',
                                )}
                                data-highlighted={highlighted || undefined}
                                type={hidden ? 'password' : 'text'}
                                value={value}
                                disabled={disabled}
                                spellCheck={false}
                                autoComplete="off"
                                aria-invalid={invalid || undefined}
                                aria-autocomplete={completion ? 'list' : undefined}
                                aria-expanded={completion ? suggestionsOpen : undefined}
                                aria-controls={suggestionsOpen ? listId : undefined}
                                onChange={(event) => {
                                    onChange(event.currentTarget.value);
                                    syncScroll();
                                    requestAnimationFrame(updateSuggestions);
                                }}
                                onKeyDown={handleKeyDown}
                                onKeyUp={(event) => {
                                    syncScroll();
                                    if (
                                        event.key === 'ArrowLeft' ||
                                        event.key === 'ArrowRight' ||
                                        event.key === 'Home' ||
                                        event.key === 'End'
                                    ) {
                                        updateSuggestions();
                                    }
                                }}
                                onScroll={syncScroll}
                                onSelect={syncScroll}
                                onMouseMove={(event) => onPointerMove(event.clientX, event.clientY)}
                                onMouseLeave={releaseHover}
                                onBlur={(event) => {
                                    setSuggest(null);
                                    onBlur?.(event);
                                }}
                            />
                        </div>
                    </Popover.Target>
                    <Popover.Dropdown className="max-h-[260px] overflow-y-auto">
                        <div role="listbox" id={listId} aria-label="Variables">
                            {suggestions.map((name, index) => {
                                const definition = resolver.lookup(name);
                                return (
                                    <UnstyledButton
                                        key={name}
                                        role="option"
                                        aria-selected={index === suggest?.index}
                                        tabIndex={-1}
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            accept(name);
                                        }}
                                        className="flex w-full items-baseline justify-between gap-3 rounded-xs px-2 py-1 text-xs hover:bg-hover aria-selected:bg-hover"
                                    >
                                        <span className="font-mono text-var-fg">{name}</span>
                                        <Text
                                            component="span"
                                            size="xs"
                                            className="text-dimmed truncate"
                                        >
                                            {definition?.dynamic
                                                ? definition.value
                                                : definition?.source}
                                        </Text>
                                    </UnstyledButton>
                                );
                            })}
                        </div>
                    </Popover.Dropdown>
                </Popover>

                <Popover
                    opened={!!hover && !suggestionsOpen}
                    onClose={dismissHover}
                    position="bottom-start"
                    offset={6}
                >
                    <Popover.Target>
                        <span
                            className="pointer-events-none absolute bottom-0.5 h-px"
                            style={{ left: hover?.left ?? 0, width: hover?.width ?? 0 }}
                            aria-hidden
                        />
                    </Popover.Target>
                    <Popover.Dropdown
                        className="max-w-[380px] p-2.5"
                        onMouseEnter={keepHover}
                        onMouseLeave={releaseHover}
                    >
                        {hover && (
                            <VariableDetails
                                key={hover.name}
                                name={hover.name}
                                editable={!disabled}
                                onEditStart={() => {
                                    keepHover();
                                    pinned.current = true;
                                }}
                                onEditEnd={(saved) => {
                                    dismissHover();
                                    if (saved) inputRef.current?.focus();
                                }}
                            />
                        )}
                    </Popover.Dropdown>
                </Popover>

                {masked && (
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={revealed ? 'Hide value' : 'Show value'}
                        aria-pressed={revealed}
                        onClick={() => setRevealed((current) => !current)}
                        disabled={disabled}
                        className="mr-[3px] flex-none"
                    >
                        {revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </ActionIcon>
                )}
                {rightSection}
            </div>
        );
    },
);

interface VariableDetailsProps {
    name: string;
    /** Offers a "Replace with" field that writes the variable to the active environment. */
    editable?: boolean;
    /** The user started editing: the card should stay open until {@link onEditEnd}. */
    onEditStart?: () => void;
    /** Editing ended, by saving (`true`) or cancelling (`false`). */
    onEditEnd?: (saved: boolean) => void;
}

/**
 * Current value and source of one variable, and a field to change it in place. Secrets need an
 * explicit reveal. Saving writes the active environment, so every `{{reference}}` to the variable,
 * in this request and any other, resolves to the new value at once.
 */
export function VariableDetails({
    name,
    editable = false,
    onEditStart,
    onEditEnd,
}: VariableDetailsProps) {
    const { resolver, environmentName } = useVariables();
    const setEnvironmentVariable = useWorkbenchStore((state) => state.setEnvironmentVariable);
    const [revealed, setRevealed] = useState(false);
    const definition = resolver.lookup(name);
    // A secret's value is never pre-filled: it would be on screen without the user asking for it.
    const initial = definition && !definition.secret ? definition.value : '';
    const [draft, setDraft] = useState(initial);
    const [editing, setEditing] = useState(false);

    // Dynamic variables are generated at send time; there is nothing stored to edit.
    const canEdit = editable && !!environmentName && !definition?.dynamic;
    const changed = definition?.secret ? draft !== '' : !definition || draft !== initial;
    const resolved =
        definition && !definition.dynamic && !definition.secret && definition.value.includes('{{')
            ? resolver.resolve(definition.value)
            : null;

    const beginEditing = () => {
        if (editing) return;
        setEditing(true);
        onEditStart?.();
    };

    const save = () => {
        if (!changed) return;
        setEnvironmentVariable(name, draft, definition?.secret ?? false);
        setEditing(false);
        onEditEnd?.(true);
    };

    const cancel = () => {
        setDraft(initial);
        setEditing(false);
        onEditEnd?.(false);
    };

    return (
        <div className="min-w-[240px]">
            <Text size="xs" className="font-mono font-semibold">{`{{${name}}}`}</Text>
            {!definition ? (
                <Text size="xs" className="text-danger-text mt-1">
                    {environmentName
                        ? `Not defined in “${environmentName}”. It is sent as written.`
                        : 'No environment is selected.'}
                </Text>
            ) : (
                <>
                    <Text size="xs" className="text-dimmed mt-1.5">
                        {definition.dynamic ? 'Generated at send time' : 'Current value'}
                    </Text>
                    <div className="flex items-start gap-2">
                        <Text size="xs" className="flex-1 font-mono break-all">
                            {definition.secret && !revealed
                                ? '••••••••'
                                : definition.value || '(empty)'}
                        </Text>
                        {definition.secret && (
                            <UnstyledButton
                                onClick={() => setRevealed((current) => !current)}
                                className="flex-none text-xs font-medium text-primary-text"
                            >
                                {revealed ? 'Hide' : 'Reveal'}
                            </UnstyledButton>
                        )}
                    </div>
                    {resolved !== null && (
                        <>
                            <Text size="xs" className="text-dimmed mt-1.5">
                                Resolves to
                            </Text>
                            <Text size="xs" className="flex-1 font-mono break-all">
                                {resolved}
                            </Text>
                        </>
                    )}
                    <Text size="xs" className="text-dimmed mt-1.5">
                        Source
                    </Text>
                    <Text size="xs">
                        {definition.dynamic
                            ? 'Dynamic variable'
                            : `${definition.source} environment`}
                    </Text>
                </>
            )}
            {canEdit && (
                <form
                    // "Replace with": edits the variable in the active environment without leaving the request.
                    className="mt-2.5 border-t border-line pt-2.5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        // The card is portalled, but React still bubbles its events to the URL bar's form.
                        event.stopPropagation();
                        save();
                    }}
                >
                    <TextInput
                        size="xs"
                        label={definition ? 'Replace with' : `Add to “${environmentName}”`}
                        placeholder={definition?.secret ? 'New secret value' : 'New value'}
                        type={definition?.secret && !revealed ? 'password' : 'text'}
                        value={draft}
                        spellCheck={false}
                        autoComplete="off"
                        inputClassName="font-mono"
                        onFocus={beginEditing}
                        onChange={(event) => {
                            beginEditing();
                            setDraft(event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                cancel();
                            }
                        }}
                    />
                    <Group gap={6} justify="flex-end" className="mt-2">
                        {editing && (
                            <Button size="compact-xs" variant="default" onClick={cancel}>
                                Cancel
                            </Button>
                        )}
                        <Button size="compact-xs" type="submit" disabled={!changed}>
                            {definition ? 'Save' : 'Add variable'}
                        </Button>
                    </Group>
                </form>
            )}
        </div>
    );
}
