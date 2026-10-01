/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    forwardRef,
    useCallback,
    useEffect,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
    type ReactNode,
} from 'react';
import { IconX } from '@tabler/icons-react';
import { copyText } from '../clipboard';
import { cx } from './cx';
import { Loader } from './layout';
import { DEFAULT_CONTROL, toneClasses, type Tone } from './tones';

export type ButtonVariant = 'filled' | 'light' | 'subtle' | 'outline' | 'default' | 'transparent';

const BUTTON_SIZE = {
    'compact-xs': 'h-[22px] px-[7px] text-2xs',
    'compact-sm': 'h-[26px] px-2.5 text-xs',
    xs: 'h-[var(--control-h)] px-3.5 text-xs',
    sm: 'h-[var(--control-h)] px-4 text-sm',
    md: 'h-[42px] px-[18px] text-base',
} as const;

export type ButtonSize = keyof typeof BUTTON_SIZE;

/** Colours for every variant; `default` is the neutral bordered control. */
const variantClasses = (variant: ButtonVariant, color: Tone | undefined): string => {
    if (variant === 'default') {
        // A coloured default button keeps its neutral frame and tints only the label.
        return cx(DEFAULT_CONTROL, color === 'red' && 'text-danger-text');
    }
    if (variant === 'transparent') return 'bg-transparent text-primary-text hover:underline';
    return toneClasses(variant, color ?? 'primary');
};

export interface ButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'color'> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    color?: Tone;
    leftSection?: ReactNode;
    rightSection?: ReactNode;
    loading?: boolean;
    fullWidth?: boolean;
}

/** The application's button. Compact sizes suit toolbars; `default` is the neutral variant. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    {
        variant = 'filled',
        size = 'xs',
        color,
        leftSection,
        rightSection,
        loading,
        fullWidth,
        disabled,
        className,
        children,
        type = 'button',
        ...props
    },
    ref,
) {
    const inactive = disabled || loading;
    return (
        <button
            ref={ref}
            type={type}
            disabled={inactive}
            data-loading={loading || undefined}
            {...props}
            className={cx(
                'relative inline-flex select-none items-center justify-center gap-1.5 rounded-sm font-semibold whitespace-nowrap transition-colors',
                BUTTON_SIZE[size],
                variantClasses(variant, color),
                fullWidth && 'w-full',
                inactive &&
                    'pointer-events-none border-transparent bg-neutral-soft text-placeholder opacity-70',
                className,
            )}
        >
            {loading && <Loader size={14} className="absolute" />}
            <span className={cx('inline-flex items-center gap-1.5', loading && 'invisible')}>
                {leftSection}
                {children}
                {rightSection}
            </span>
        </button>
    );
});

const ICON_VARIANT = {
    default: DEFAULT_CONTROL,
    subtle: 'text-dimmed hover:bg-hover hover:text-fg',
    transparent: 'text-dimmed hover:text-fg',
    light: 'bg-primary-soft text-primary-text hover:bg-primary-soft-hover',
    filled: 'bg-primary text-primary-fg hover:bg-primary-hover',
} as const;

export interface ActionIconProps extends Omit<ComponentPropsWithoutRef<'button'>, 'color'> {
    /** Edge length in pixels. */
    size?: number | 'xs' | 'sm' | 'md';
    variant?: keyof typeof ICON_VARIANT;
    color?: Tone;
    loading?: boolean;
}

const ICON_SIZE = { xs: 18, sm: 26, md: 28 } as const;

/** A square, icon-only button. Always give it an `aria-label`. */
export const ActionIcon = forwardRef<HTMLButtonElement, ActionIconProps>(function ActionIcon(
    {
        size = 'md',
        variant = 'subtle',
        color,
        loading,
        disabled,
        className,
        children,
        style,
        type = 'button',
        ...props
    },
    ref,
) {
    const edge = typeof size === 'number' ? size : ICON_SIZE[size];
    const inactive = disabled || loading;
    return (
        <button
            ref={ref}
            type={type}
            disabled={inactive}
            {...props}
            style={{ width: edge, height: edge, ...style }}
            className={cx(
                'inline-flex shrink-0 items-center justify-center rounded-sm transition-colors',
                color && variant !== 'default' && variant !== 'transparent'
                    ? toneClasses(variant, color)
                    : ICON_VARIANT[variant],
                inactive && 'pointer-events-none opacity-40',
                className,
            )}
        >
            {loading ? <Loader size={Math.round(edge / 2)} /> : children}
        </button>
    );
});

/**
 * A button with no styling at all, for rows and triggers that bring their own. `component="div"`
 * renders a non-interactive element with the same look, for rows that must contain a checkbox
 * (a checkbox cannot sit inside a button).
 */
export const UnstyledButton = forwardRef<
    HTMLButtonElement,
    ComponentPropsWithoutRef<'button'> & { component?: 'button' | 'div' }
>(function UnstyledButton({ className, type = 'button', component = 'button', ...props }, ref) {
    const classes = cx('border-0 bg-transparent p-0 text-left text-inherit', className);
    if (component === 'div') {
        const { disabled, ...divProps } = props;
        return (
            <div
                {...(divProps as ComponentPropsWithoutRef<'div'>)}
                aria-disabled={disabled || undefined}
                ref={ref as unknown as React.Ref<HTMLDivElement>}
                className={classes}
            />
        );
    }
    return <button ref={ref} type={type} {...props} className={classes} />;
});

/** The ✕ button used by dialogs and chips. */
export function CloseButton({
    className,
    size = 26,
    ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'color'> & {
    size?: number | 'xs' | 'sm';
}) {
    return (
        <ActionIcon
            size={size}
            variant="subtle"
            aria-label="Close"
            {...props}
            className={className}
        >
            <IconX size={16} aria-hidden />
        </ActionIcon>
    );
}

/** Opens the system file picker and hands the chosen file to `onChange`. */
export function FileButton({
    onChange,
    accept,
    children,
}: {
    onChange: (file: File | null) => void;
    accept?: string;
    children: (props: { onClick: () => void }) => ReactNode;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                type="file"
                accept={accept}
                hidden
                onChange={(event) => {
                    onChange(event.currentTarget.files?.[0] ?? null);
                    // Allows choosing the same file twice in a row.
                    event.currentTarget.value = '';
                }}
            />
            {children({ onClick: () => input.current?.click() })}
        </>
    );
}

/** Copies a value to the clipboard and reports `copied` for a moment afterwards. */
export function CopyButton({
    value,
    timeout = 1500,
    children,
}: {
    value: string;
    timeout?: number;
    children: (state: { copied: boolean; copy: () => void }) => ReactNode;
}) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);

    const copy = useCallback(() => {
        void copyText(value)
            .then(() => {
                setCopied(true);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), timeout);
            })
            .catch(() => undefined);
    }, [value, timeout]);

    return <>{children({ copied, copy })}</>;
}
