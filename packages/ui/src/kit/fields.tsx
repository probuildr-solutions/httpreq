/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    createContext,
    forwardRef,
    useContext,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type ChangeEvent,
    type ComponentPropsWithoutRef,
    type ReactNode,
    type Ref,
} from 'react';
import { IconEye, IconEyeOff, IconMinus } from '@tabler/icons-react';
import { ActionIcon } from './buttons';
import { cx } from './cx';
import { CONTROL_SIZE, controlSize, inputFrame, type FieldSize } from './fieldStyles';

export interface InputWrapperProps {
    label?: ReactNode;
    description?: ReactNode;
    /** Puts the description under the control instead of between the label and it. */
    descriptionBelow?: boolean;
    error?: ReactNode;
    required?: boolean;
    labelProps?: ComponentPropsWithoutRef<'label'>;
    className?: string;
    children: ReactNode;
}

/** A label, optional description above the control, and an error below it. */
export function InputWrapper({
    label,
    description,
    descriptionBelow,
    error,
    required,
    labelProps,
    className,
    children,
}: InputWrapperProps) {
    if (!label && !description && !error) return <div className={className}>{children}</div>;
    return (
        <div className={cx('flex flex-col', className)}>
            {label && (
                <label {...labelProps} className={cx('text-sm font-medium', labelProps?.className)}>
                    {label}
                    {required && <span className="text-danger-text"> *</span>}
                </label>
            )}
            {description && !descriptionBelow && (
                <div className="mb-1 text-xs text-dimmed">{description}</div>
            )}
            <div className={label || description ? 'mt-1' : undefined}>{children}</div>
            {description && descriptionBelow && (
                <div className="mt-1 text-xs text-dimmed">{description}</div>
            )}
            {error && <div className="mt-1 text-xs text-danger-text">{error}</div>}
        </div>
    );
}
InputWrapper.displayName = 'InputWrapper';

/** Props every labelled text control accepts on top of the native element's. */
interface TextControlProps {
    label?: ReactNode;
    description?: ReactNode;
    error?: ReactNode;
    size?: FieldSize;
    variant?: 'default' | 'unstyled';
    leftSection?: ReactNode;
    rightSection?: ReactNode;
    /** Classes for the native element, while `className` styles the whole labelled control. */
    inputClassName?: string;
    /** Puts the description under the control instead of between the label and it. */
    descriptionBelow?: boolean;
}

export interface TextInputProps
    extends TextControlProps, Omit<ComponentPropsWithoutRef<'input'>, 'size'> {}

/** A single-line text field with an optional label, description, error and inline icons. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
    {
        label,
        description,
        error,
        size = 'sm',
        variant = 'default',
        leftSection,
        rightSection,
        inputClassName,
        className,
        id,
        required,
        disabled,
        descriptionBelow,
        ...props
    },
    ref,
) {
    const generated = useId();
    const inputId = id ?? generated;
    return (
        <InputWrapper
            descriptionBelow={descriptionBelow}
            label={label}
            description={description}
            error={error}
            required={required}
            labelProps={{ htmlFor: inputId }}
            className={className}
        >
            <div
                className={cx(
                    'flex items-center gap-1.5',
                    controlSize(size, variant),
                    inputFrame(variant, !!error),
                    disabled && 'opacity-60',
                )}
            >
                {leftSection && <span className="flex shrink-0 text-dimmed">{leftSection}</span>}
                <input
                    ref={ref}
                    id={inputId}
                    required={required}
                    disabled={disabled}
                    aria-invalid={error ? true : undefined}
                    {...props}
                    className={cx(
                        'min-w-0 flex-1 border-0 bg-transparent py-0 text-inherit outline-none',
                        inputClassName,
                    )}
                />
                {rightSection && <span className="flex shrink-0 text-dimmed">{rightSection}</span>}
            </div>
        </InputWrapper>
    );
});

/** A text field that can reveal what was typed. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<TextInputProps, 'type'>>(
    function PasswordInput(props, ref) {
        const [visible, setVisible] = useState(false);
        return (
            <TextInput
                {...props}
                ref={ref}
                type={visible ? 'text' : 'password'}
                rightSection={
                    <ActionIcon
                        size={22}
                        variant="subtle"
                        aria-label={visible ? 'Hide' : 'Show'}
                        onClick={() => setVisible((value) => !value)}
                    >
                        {visible ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                    </ActionIcon>
                }
            />
        );
    },
);

export interface TextareaProps
    extends
        Omit<TextControlProps, 'leftSection' | 'rightSection'>,
        Omit<ComponentPropsWithoutRef<'textarea'>, 'rows'> {
    /** Grows with its content between `minRows` and `maxRows`. */
    autosize?: boolean;
    minRows?: number;
    maxRows?: number;
}

/** A multi-line field that optionally resizes itself to fit what was typed. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
    {
        label,
        description,
        error,
        size = 'sm',
        variant = 'default',
        autosize,
        minRows = 2,
        maxRows,
        inputClassName,
        className,
        id,
        value,
        // Consumed here: a textarea has no sections.
        ...props
    },
    ref,
) {
    const generated = useId();
    const inputId = id ?? generated;
    const inner = useRef<HTMLTextAreaElement | null>(null);

    const fit = () => {
        const element = inner.current;
        if (!element || !autosize) return;
        const style = getComputedStyle(element);
        const line = parseFloat(style.lineHeight) || 20;
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        element.style.height = 'auto';
        const max = maxRows ? line * maxRows + padding : Infinity;
        element.style.height = `${Math.min(element.scrollHeight, max)}px`;
        element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
    };
    useLayoutEffect(fit, [value, autosize, maxRows, minRows]);

    const assign = (element: HTMLTextAreaElement | null) => {
        inner.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref) ref.current = element;
    };

    return (
        <InputWrapper
            label={label}
            description={description}
            error={error}
            labelProps={{ htmlFor: inputId }}
            className={className}
        >
            <textarea
                ref={assign}
                id={inputId}
                rows={minRows}
                value={value}
                aria-invalid={error ? true : undefined}
                {...props}
                className={cx(
                    'block w-full resize-none px-2.5 py-1.5 text-inherit outline-none',
                    CONTROL_SIZE[size],
                    inputFrame(variant, !!error),
                    inputClassName,
                )}
            />
        </InputWrapper>
    );
});

export interface NumberInputProps
    extends
        Omit<TextControlProps, 'leftSection' | 'rightSection'>,
        Omit<ComponentPropsWithoutRef<'input'>, 'size' | 'value' | 'onChange' | 'min' | 'max'> {
    value: number | string;
    onChange: (value: number | string) => void;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
    w?: number;
}

/**
 * A numeric field. The text being typed is kept separately from the number, so an empty or
 * half-typed value ("1.") is not rewritten under the cursor; `onChange` receives a number once
 * the text parses, and an empty string when the field is cleared.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
    { value, onChange, min, max, step = 1, suffix = '', w, className, ...props },
    ref,
) {
    const [draft, setDraft] = useState<string | null>(null);
    const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    const shown = draft ?? (value === '' ? '' : `${value}${suffix}`);

    const commit = (text: string) => {
        const parsed = Number.parseFloat(text.replace(suffix, '').trim());
        onChange(Number.isFinite(parsed) ? clamp(parsed) : '');
    };

    return (
        <TextInput
            {...props}
            ref={ref}
            inputMode="decimal"
            value={shown}
            className={className}
            style={w ? { width: w } : undefined}
            onFocus={() => setDraft(value === '' ? '' : String(value))}
            onChange={(event) => {
                setDraft(event.currentTarget.value);
                commit(event.currentTarget.value);
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                const base = typeof value === 'number' ? value : 0;
                const next = clamp(base + (event.key === 'ArrowUp' ? step : -step));
                setDraft(String(next));
                onChange(next);
            }}
        />
    );
});

export interface CheckboxProps extends Omit<ComponentPropsWithoutRef<'input'>, 'size' | 'type'> {
    label?: ReactNode;
    size?: 'xs' | 'sm';
    indeterminate?: boolean;
}

/** A checkbox with an optional label and an indeterminate state for "some selected". */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
    { label, size = 'sm', indeterminate, className, id, ...props },
    ref,
) {
    const generated = useId();
    const inputId = id ?? generated;
    const inner = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        if (inner.current) inner.current.indeterminate = !!indeterminate;
    }, [indeterminate]);

    const assign = (element: HTMLInputElement | null) => {
        inner.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref) ref.current = element;
    };

    return (
        <span className={cx('inline-flex items-center gap-2', className)}>
            <span className="relative inline-flex">
                <input
                    ref={assign}
                    id={inputId}
                    type="checkbox"
                    {...props}
                    className={cx(
                        'peer m-0 shrink-0 cursor-pointer appearance-none rounded-xs border border-line bg-field',
                        'checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
                        'disabled:cursor-default disabled:opacity-50',
                        size === 'xs' ? 'size-3.5' : 'size-[18px]',
                    )}
                />
                <svg
                    viewBox="0 0 12 12"
                    aria-hidden
                    className="pointer-events-none absolute inset-0 m-auto hidden size-2.5 text-primary-fg peer-checked:block peer-indeterminate:hidden"
                >
                    <path
                        d="M2 6.5l2.5 2.5L10 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                    />
                </svg>
                <IconMinus
                    aria-hidden
                    className="pointer-events-none absolute inset-0 m-auto hidden size-2.5 text-primary-fg peer-indeterminate:block"
                />
            </span>
            {label && (
                <label htmlFor={inputId} className={cx(size === 'xs' ? 'text-xs' : 'text-sm')}>
                    {label}
                </label>
            )}
        </span>
    );
});

export interface SwitchProps extends Omit<ComponentPropsWithoutRef<'input'>, 'size' | 'type'> {
    label?: ReactNode;
    /** Smaller text under the label explaining what the switch does. */
    description?: ReactNode;
}

/** An on/off toggle exposed to assistive technology as a switch. */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
    { label, description, className, id, ...props },
    ref,
) {
    const generated = useId();
    const inputId = id ?? generated;
    return (
        <span className={cx('inline-flex items-start gap-2', className)}>
            <input
                ref={ref}
                id={inputId}
                type="checkbox"
                role="switch"
                {...props}
                className={cx(
                    'relative m-0 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border border-line bg-neutral-soft transition-colors',
                    'after:absolute after:top-px after:left-px after:size-[16px] after:rounded-full after:bg-white after:shadow-sm after:transition-transform after:content-[""]',
                    'checked:border-primary checked:bg-primary checked:after:translate-x-4',
                    'disabled:cursor-default disabled:opacity-50',
                )}
            />
            {(label || description) && (
                <span className="flex flex-col">
                    {label && (
                        <label htmlFor={inputId} className="text-sm">
                            {label}
                        </label>
                    )}
                    {description && <span className="text-xs text-dimmed">{description}</span>}
                </span>
            )}
        </span>
    );
});

interface RadioGroupState {
    value: string;
    onChange: (value: string) => void;
    name: string;
}

const RadioGroupContext = createContext<RadioGroupState | null>(null);

/** A set of radio buttons sharing one value. */
function RadioGroup({
    value,
    onChange,
    label,
    description,
    children,
}: {
    value: string;
    onChange: (value: string) => void;
    label?: ReactNode;
    description?: ReactNode;
    children: ReactNode;
}) {
    const name = useId();
    return (
        <RadioGroupContext.Provider value={{ value, onChange, name }}>
            <InputWrapper label={label} description={description}>
                <div role="radiogroup">{children}</div>
            </InputWrapper>
        </RadioGroupContext.Provider>
    );
}

/** A single radio button, bound to the surrounding `Radio.Group`. */
export function Radio({
    value,
    label,
    size = 'sm',
    className,
    ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'size' | 'type' | 'onChange' | 'value'> & {
    value: string;
    label?: ReactNode;
    size?: 'xs' | 'sm';
}) {
    const group = useContext(RadioGroupContext);
    const id = useId();
    return (
        <span className={cx('inline-flex items-center gap-2', className)}>
            <input
                id={id}
                type="radio"
                name={group?.name}
                value={value}
                checked={group?.value === value}
                onChange={() => group?.onChange(value)}
                {...props}
                className={cx(
                    'm-0 shrink-0 cursor-pointer appearance-none rounded-full border border-line bg-field',
                    'checked:border-[length:4px] checked:border-primary checked:bg-primary-fg',
                    'disabled:cursor-default disabled:opacity-50',
                    size === 'xs' ? 'size-3.5' : 'size-[18px]',
                )}
            />
            {label && (
                <label htmlFor={id} className={cx(size === 'xs' ? 'text-xs' : 'text-sm')}>
                    {label}
                </label>
            )}
        </span>
    );
}

/** A whole card that acts as a radio button, with the indicator placed by the caller. */
function RadioCard({
    value,
    className,
    children,
}: {
    value: string;
    className?: string;
    children: ReactNode;
}) {
    const group = useContext(RadioGroupContext);
    const checked = group?.value === value;
    return (
        <button
            type="button"
            role="radio"
            aria-checked={checked}
            data-checked={checked || undefined}
            onClick={() => group?.onChange(value)}
            className={cx(
                'w-full rounded-sm border border-line bg-field p-2.5 text-left transition-colors hover:bg-hover',
                'data-[checked]:border-primary data-[checked]:bg-primary-soft',
                className,
            )}
        >
            {children}
        </button>
    );
}

/** The dot drawn inside a `Radio.Card`; it mirrors the card's checked state. */
function RadioIndicator({ size = 'sm' }: { size?: 'xs' | 'sm' }) {
    return (
        <span
            aria-hidden
            className={cx(
                'inline-block shrink-0 rounded-full border border-line bg-field',
                'in-data-[checked]:border-[length:4px] in-data-[checked]:border-primary in-data-[checked]:bg-primary-fg',
                size === 'xs' ? 'size-3.5' : 'size-[18px]',
            )}
        />
    );
}

Radio.Group = RadioGroup;
Radio.Card = RadioCard;
Radio.Indicator = RadioIndicator;

export interface SegmentedItem {
    value: string;
    label: ReactNode;
}

/** A row of mutually exclusive options, shown as one joined control. */
export function SegmentedControl({
    data,
    value,
    onChange,
    size = 'sm',
    fullWidth,
    disabled,
    className,
    ...props
}: Omit<ComponentPropsWithoutRef<'div'>, 'onChange'> & {
    data: Array<SegmentedItem | string>;
    value: string;
    onChange: (value: string) => void;
    size?: 'xs' | 'sm';
    fullWidth?: boolean;
    disabled?: boolean;
}) {
    return (
        <div
            role="radiogroup"
            {...props}
            className={cx(
                'inline-flex rounded-sm border border-line bg-hover p-0.5',
                fullWidth && 'flex w-full',
                className,
            )}
        >
            {data.map((entry) => {
                const item = typeof entry === 'string' ? { value: entry, label: entry } : entry;
                const active = item.value === value;
                return (
                    <button
                        key={item.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabled}
                        onClick={() => onChange(item.value)}
                        className={cx(
                            'flex-1 rounded-xs px-3 font-medium whitespace-nowrap transition-colors',
                            size === 'xs' ? 'h-6 text-xs' : 'h-7 text-sm',
                            active
                                ? 'bg-field text-fg shadow-sm'
                                : 'text-dimmed hover:text-fg disabled:hover:text-dimmed',
                            disabled && 'opacity-60',
                        )}
                    >
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
}

export type { ChangeEvent, Ref };
