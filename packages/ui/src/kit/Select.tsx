/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    FloatingPortal,
    autoUpdate,
    flip,
    offset,
    shift,
    size as sizeMiddleware,
    useDismiss,
    useFloating,
    useInteractions,
    useRole,
} from '@floating-ui/react';
import {
    forwardRef,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { IconCheck, IconChevronDown, IconX } from '@tabler/icons-react';
import { cx } from './cx';
import { controlSize, inputFrame, type FieldSize } from './fieldStyles';
import { InputWrapper } from './fields';

/** One choice in a list: the stored value and the text shown for it. */
export interface SelectOption {
    value: string;
    label: string;
    disabled?: boolean;
}

/** Options may be given as plain strings when value and label are the same. */
export type SelectData = Array<string | SelectOption>;

const normalize = (data: SelectData): SelectOption[] =>
    data.map((entry) => (typeof entry === 'string' ? { value: entry, label: entry } : entry));

/** The popup shared by every combobox: positioned under its anchor and as wide as it. */
function useListbox(open: boolean, onClose: () => void, minWidth?: number) {
    const floating = useFloating({
        transform: false,
        open,
        onOpenChange: (next) => !next && onClose(),
        placement: 'bottom-start',
        whileElementsMounted: autoUpdate,
        middleware: [
            offset(4),
            flip(),
            shift({ padding: 6 }),
            sizeMiddleware({
                apply({ rects, elements, availableHeight }) {
                    Object.assign(elements.floating.style, {
                        minWidth: `${Math.max(rects.reference.width, minWidth ?? 0)}px`,
                        maxHeight: `${Math.min(availableHeight - 8, 280)}px`,
                    });
                },
            }),
        ],
    });
    const interactions = useInteractions([
        useDismiss(floating.context),
        useRole(floating.context, { role: 'listbox' }),
    ]);
    return { ...floating, ...interactions };
}

/** One row of a listbox. */
function OptionRow({
    option,
    selected,
    active,
    check,
    id,
    render,
    onPick,
    onHover,
}: {
    option: SelectOption;
    selected: boolean;
    active: boolean;
    check: boolean;
    id: string;
    render?: (option: SelectOption) => ReactNode;
    onPick: () => void;
    onHover: () => void;
}) {
    return (
        <div
            id={id}
            role="option"
            aria-selected={selected}
            aria-disabled={option.disabled || undefined}
            data-active={active || undefined}
            // Holding focus on mousedown keeps it in the input of an autocomplete.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => !option.disabled && onPick()}
            onMouseEnter={onHover}
            className={cx(
                'flex cursor-pointer items-center gap-2 rounded-xs px-2.5 py-1.5 text-sm',
                active && 'bg-hover',
                selected && 'bg-primary-soft text-primary-text',
                option.disabled && 'pointer-events-none opacity-50',
            )}
        >
            <span className="min-w-0 flex-1 truncate">
                {render ? render(option) : option.label}
            </span>
            {check && selected && <IconCheck size={14} aria-hidden className="shrink-0" />}
        </div>
    );
}

interface ComboboxFieldProps {
    label?: ReactNode;
    description?: ReactNode;
    error?: ReactNode;
    size?: FieldSize;
    variant?: 'default' | 'unstyled';
    /** Classes for the control itself; `className` styles the labelled wrapper. */
    inputClassName?: string;
    /** Minimum width of the popup in pixels. */
    menuWidth?: number;
}

export interface SelectProps
    extends
        ComboboxFieldProps,
        Omit<ComponentPropsWithoutRef<'button'>, 'value' | 'onChange' | 'size'> {
    data: SelectData;
    value: string | null;
    onChange: (value: string | null) => void;
    placeholder?: string;
    /** Shows a button that clears the selection. */
    clearable?: boolean;
    withCheckIcon?: boolean;
    renderOption?: (option: SelectOption) => ReactNode;
    /** Inline style for the trigger, used to colour it by its value. */
    triggerStyle?: ComponentPropsWithoutRef<'button'>['style'];
}

/** A drop-down list for choosing one value from a fixed set. Arrow keys move; Enter picks. */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
    {
        data,
        value,
        onChange,
        placeholder,
        clearable,
        withCheckIcon = true,
        renderOption,
        label,
        description,
        error,
        size = 'sm',
        variant = 'default',
        inputClassName,
        menuWidth,
        triggerStyle,
        className,
        disabled,
        id,
        ...props
    },
    ref,
) {
    const options = useMemo(() => normalize(data), [data]);
    const selected = options.find((option) => option.value === value);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const listId = useId();
    const generated = useId();
    const buttonId = id ?? generated;
    const box = useListbox(open, () => setOpen(false), menuWidth);

    const pick = (option: SelectOption) => {
        onChange(option.value);
        setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
                setActive(
                    Math.max(
                        0,
                        options.findIndex((option) => option.value === value),
                    ),
                );
                setOpen(true);
                return;
            }
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((index) => (index + step + options.length) % options.length);
        } else if ((event.key === 'Enter' || event.key === ' ') && open) {
            event.preventDefault();
            const option = options[active];
            if (option && !option.disabled) pick(option);
        }
    };

    return (
        <InputWrapper
            label={label}
            description={description}
            error={error}
            labelProps={{ htmlFor: buttonId }}
            className={className}
        >
            <div className="relative flex">
                <button
                    ref={(node) => {
                        box.refs.setReference(node);
                        if (typeof ref === 'function') ref(node);
                        else if (ref) ref.current = node;
                    }}
                    id={buttonId}
                    type="button"
                    role="combobox"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-controls={open ? listId : undefined}
                    aria-activedescendant={open ? `${listId}-${active}` : undefined}
                    aria-invalid={error ? true : undefined}
                    disabled={disabled}
                    {...box.getReferenceProps({
                        ...props,
                        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                            props.onClick?.(event);
                            setActive(
                                Math.max(
                                    0,
                                    options.findIndex((o) => o.value === value),
                                ),
                            );
                            setOpen((current) => !current);
                        },
                        onKeyDown,
                    })}
                    style={triggerStyle}
                    className={cx(
                        'flex w-full items-center gap-1.5 text-left outline-none',
                        controlSize(size, variant),
                        inputFrame(variant, !!error, size),
                        'focus-visible:border-primary',
                        disabled && 'opacity-60',
                        inputClassName,
                    )}
                >
                    <span
                        className={cx('min-w-0 flex-1 truncate', !selected && 'text-placeholder')}
                    >
                        {selected ? selected.label : placeholder}
                    </span>
                    {clearable && selected && !disabled ? (
                        <span
                            role="button"
                            aria-label="Clear"
                            className="flex shrink-0 text-dimmed hover:text-fg"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => {
                                event.stopPropagation();
                                onChange(null);
                            }}
                        >
                            <IconX size={13} aria-hidden />
                        </span>
                    ) : (
                        <IconChevronDown
                            size={size === 'toolbar' ? 13 : 14}
                            aria-hidden
                            className="shrink-0 text-dimmed"
                        />
                    )}
                </button>
            </div>
            {open && (
                <FloatingPortal>
                    <div
                        ref={box.refs.setFloating}
                        id={listId}
                        style={box.floatingStyles}
                        {...box.getFloatingProps()}
                        className="z-[1000] animate-pop overflow-y-auto rounded-sm border border-line bg-surface p-1 shadow-popup"
                    >
                        {options.map((option, index) => (
                            <OptionRow
                                key={option.value}
                                id={`${listId}-${index}`}
                                option={option}
                                selected={option.value === value}
                                active={index === active}
                                check={withCheckIcon}
                                render={renderOption}
                                onPick={() => pick(option)}
                                onHover={() => setActive(index)}
                            />
                        ))}
                    </div>
                </FloatingPortal>
            )}
        </InputWrapper>
    );
});

export interface AutocompleteProps
    extends
        ComboboxFieldProps,
        Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'size'> {
    data: string[];
    value: string;
    onChange: (value: string) => void;
    /** At most this many suggestions are shown. */
    limit?: number;
}

/** A text field that suggests values from a list as the user types, but accepts anything. */
export const Autocomplete = forwardRef<HTMLInputElement, AutocompleteProps>(function Autocomplete(
    {
        data,
        value,
        onChange,
        limit = 8,
        label,
        description,
        error,
        size = 'sm',
        variant = 'default',
        inputClassName,
        menuWidth,
        className,
        ...props
    },
    ref,
) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const listId = useId();
    const box = useListbox(open, () => setOpen(false), menuWidth);

    const suggestions = useMemo(() => {
        const needle = value.trim().toLowerCase();
        return data
            .filter((entry) => entry.toLowerCase().includes(needle) && entry !== value)
            .slice(0, limit)
            .map((entry) => ({ value: entry, label: entry }));
    }, [data, value, limit]);

    useEffect(() => setActive(0), [value]);
    const visible = open && suggestions.length > 0;

    const pick = (entry: string) => {
        onChange(entry);
        setOpen(false);
    };

    return (
        <InputWrapper label={label} description={description} error={error} className={className}>
            <div
                ref={box.refs.setReference}
                className={cx(
                    'flex items-center',
                    controlSize(size, variant),
                    inputFrame(variant, !!error),
                )}
            >
                <input
                    ref={ref}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={visible}
                    aria-controls={visible ? listId : undefined}
                    autoComplete="off"
                    {...props}
                    value={value}
                    onChange={(event) => {
                        onChange(event.currentTarget.value);
                        setOpen(true);
                    }}
                    onFocus={(event) => {
                        props.onFocus?.(event);
                        setOpen(true);
                    }}
                    onKeyDown={(event) => {
                        props.onKeyDown?.(event);
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault();
                            setOpen(true);
                            const step = event.key === 'ArrowDown' ? 1 : -1;
                            const count = suggestions.length || 1;
                            setActive((index) => (index + step + count) % count);
                        } else if (event.key === 'Enter' && visible) {
                            event.preventDefault();
                            pick(suggestions[active]!.value);
                        } else if (event.key === 'Escape') {
                            setOpen(false);
                        }
                    }}
                    onBlur={(event) => {
                        props.onBlur?.(event);
                        setOpen(false);
                    }}
                    className={cx(
                        'min-w-0 flex-1 border-0 bg-transparent text-inherit outline-none',
                        inputClassName,
                    )}
                />
            </div>
            {visible && (
                <FloatingPortal>
                    <div
                        ref={box.refs.setFloating}
                        id={listId}
                        style={box.floatingStyles}
                        {...box.getFloatingProps()}
                        className="z-[1000] animate-pop overflow-y-auto rounded-sm border border-line bg-surface p-1 shadow-popup"
                    >
                        {suggestions.map((option, index) => (
                            <OptionRow
                                key={option.value}
                                id={`${listId}-${index}`}
                                option={option}
                                selected={false}
                                active={index === active}
                                check={false}
                                onPick={() => pick(option.value)}
                                onHover={() => setActive(index)}
                            />
                        ))}
                    </div>
                </FloatingPortal>
            )}
        </InputWrapper>
    );
});

/** A text field that turns each confirmed entry into a removable chip. */
export function TagsInput({
    value,
    onChange,
    placeholder,
    label,
    description,
    error,
    size = 'sm',
    className,
}: ComboboxFieldProps & {
    value: string[];
    onChange: (value: string[]) => void;
    placeholder?: string;
    className?: string;
}) {
    const [draft, setDraft] = useState('');
    const input = useRef<HTMLInputElement>(null);

    const commit = () => {
        const next = draft.trim();
        setDraft('');
        if (next && !value.includes(next)) onChange([...value, next]);
    };

    return (
        <InputWrapper label={label} description={description} error={error} className={className}>
            <div
                onClick={() => input.current?.focus()}
                className={cx(
                    'flex flex-wrap items-center gap-1 py-1',
                    controlSize(size, 'default'),
                    inputFrame('default', !!error),
                )}
            >
                {value.map((tag) => (
                    <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-xs bg-neutral-soft px-1.5 text-xs"
                    >
                        {tag}
                        <button
                            type="button"
                            aria-label={`Remove ${tag}`}
                            className="flex text-dimmed hover:text-fg"
                            onClick={() => onChange(value.filter((entry) => entry !== tag))}
                        >
                            <IconX size={11} aria-hidden />
                        </button>
                    </span>
                ))}
                <input
                    ref={input}
                    value={draft}
                    placeholder={value.length ? undefined : placeholder}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                            event.preventDefault();
                            commit();
                        } else if (event.key === 'Backspace' && !draft && value.length) {
                            onChange(value.slice(0, -1));
                        }
                    }}
                    className="min-w-24 flex-1 border-0 bg-transparent px-1 text-inherit outline-none"
                />
            </div>
        </InputWrapper>
    );
}
