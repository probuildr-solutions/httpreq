/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';
import { cx } from './cx';
import { toneClasses, type Tone, type ToneVariant } from './tones';

/** Spacing steps, in pixels, shared by `Group`, `Stack` and `SimpleGrid`. */
export type Gap =
    0 | 2 | 4 | 6 | 8 | 10 | 12 | 14 | 16 | 20 | 24 | 28 | 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const GAP: Record<string, string> = {
    0: 'gap-0',
    2: 'gap-0.5',
    4: 'gap-1',
    6: 'gap-1.5',
    8: 'gap-2',
    10: 'gap-2.5',
    12: 'gap-3',
    14: 'gap-3.5',
    16: 'gap-4',
    20: 'gap-5',
    24: 'gap-6',
    28: 'gap-7',
    xs: 'gap-2',
    sm: 'gap-2.5',
    md: 'gap-3.5',
    lg: 'gap-5',
    xl: 'gap-7',
};

const JUSTIFY = {
    'flex-start': 'justify-start',
    center: 'justify-center',
    'flex-end': 'justify-end',
    'space-between': 'justify-between',
} as const;

const ALIGN = {
    'flex-start': 'items-start',
    center: 'items-center',
    'flex-end': 'items-end',
    stretch: 'items-stretch',
    baseline: 'items-baseline',
} as const;

type FlexProps<T extends ElementType = 'div'> = {
    gap?: Gap;
    justify?: keyof typeof JUSTIFY;
    align?: keyof typeof ALIGN;
    className?: string;
    children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, 'className' | 'children'>;

/** A horizontal flex row. Wraps by default, like a toolbar; pass `wrap="nowrap"` to keep one line. */
export function Group({
    gap = 'md',
    justify = 'flex-start',
    align = 'center',
    wrap = 'wrap',
    grow,
    className,
    ...props
}: FlexProps & { wrap?: 'wrap' | 'nowrap'; grow?: boolean }) {
    return (
        <div
            {...props}
            className={cx(
                'flex flex-row',
                GAP[gap],
                JUSTIFY[justify],
                ALIGN[align],
                wrap === 'wrap' ? 'flex-wrap' : 'flex-nowrap',
                // Every child shares the row equally.
                grow && '*:grow',
                className,
            )}
        />
    );
}

/** A vertical flex column. */
export function Stack({
    gap = 'md',
    justify = 'flex-start',
    align = 'stretch',
    className,
    ...props
}: FlexProps) {
    return (
        <div
            {...props}
            className={cx('flex flex-col', GAP[gap], JUSTIFY[justify], ALIGN[align], className)}
        />
    );
}

/** Column counts per breakpoint, spelled out in full so Tailwind can find every class. */
const COLUMNS = {
    base: { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' },
    xs: {
        1: 'min-[30em]:grid-cols-1',
        2: 'min-[30em]:grid-cols-2',
        3: 'min-[30em]:grid-cols-3',
        4: 'min-[30em]:grid-cols-4',
    },
    sm: { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' },
    md: { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' },
} as const;

type Columns = 1 | 2 | 3 | 4;

/** An equal-width grid; `cols` is one count, or a count per breakpoint (`base`, `xs`, `sm`, `md`). */
export function SimpleGrid({
    cols = 1,
    gap = 'md',
    className,
    ...props
}: Omit<FlexProps, 'justify' | 'align'> & {
    cols?: Columns | Partial<Record<keyof typeof COLUMNS, Columns>>;
}) {
    const spec: Partial<Record<keyof typeof COLUMNS, Columns>> =
        typeof cols === 'number' ? { base: cols } : cols;
    const classes = (Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>)
        .map((point) => {
            const count = spec[point];
            return count ? COLUMNS[point][count] : '';
        })
        .join(' ');
    return <div {...props} className={cx('grid', classes, GAP[gap], className)} />;
}

/** Centres its content on both axes. */
export function Center({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
    return <div {...props} className={cx('flex items-center justify-center', className)} />;
}

/** Hides content visually while keeping it available to screen readers. */
export function VisuallyHidden({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
    return <span {...props} className={cx('sr-only', className)} />;
}

/** A horizontal rule, optionally carrying a centred label. */
export function Divider({
    label,
    className,
}: {
    label?: ReactNode;
    /** Accepted for readability at the call site; the label is always centred. */
    labelPosition?: 'left' | 'center' | 'right';
    className?: string;
}) {
    if (!label) return <hr className={cx('border-0 border-t border-line', className)} />;
    return (
        <div
            role="separator"
            className={cx('flex items-center gap-2 text-xs text-dimmed', className)}
        >
            <span className="h-px flex-1 bg-line" />
            {label}
            <span className="h-px flex-1 bg-line" />
        </div>
    );
}

const TEXT_SIZE = {
    xs: 'text-xs',
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
    xl: 'text-xl',
} as const;

export type TextSize = keyof typeof TEXT_SIZE;

/** Body text on the application's type scale. Colour and weight are Tailwind classes. */
export function Text({
    size = 'md',
    component,
    className,
    ...props
}: ComponentPropsWithoutRef<'p'> & {
    size?: TextSize;
    component?: 'span' | 'div' | 'p' | 'pre' | 'h2';
}) {
    const Tag = (component ?? 'p') as 'p';
    return <Tag {...props} className={cx(TEXT_SIZE[size], className)} />;
}

/** A heading; `order` picks the element, not the size. */
export function Title({
    order = 2,
    className,
    ...props
}: ComponentPropsWithoutRef<'h2'> & { order?: 1 | 2 | 3 | 4 | 5 | 6 }) {
    const Tag = `h${order}` as 'h2';
    return <Tag {...props} className={cx('m-0 text-lg font-semibold', className)} />;
}

/** Inline monospace text. */
export function Code({
    block,
    className,
    ...props
}: ComponentPropsWithoutRef<'code'> & { block?: boolean }) {
    const classes = cx(
        'rounded-sm bg-hover font-mono wrap-anywhere',
        block ? 'block overflow-auto p-2 text-xs whitespace-pre-wrap' : 'px-1 py-px text-[0.85em]',
        className,
    );
    return block ? (
        <pre className={classes}>
            <code {...props} />
        </pre>
    ) : (
        <code {...props} className={classes} />
    );
}

/** A keyboard key, as shown in the shortcuts list. */
export function Kbd({
    size = 'sm',
    className,
    ...props
}: ComponentPropsWithoutRef<'kbd'> & { size?: 'xs' | 'sm' }) {
    return (
        <kbd
            {...props}
            className={cx(
                'rounded-sm border border-b-2 border-line bg-hover px-1.5 py-px font-mono font-bold',
                size === 'xs' ? 'text-2xs' : 'text-xs',
                className,
            )}
        />
    );
}

const BADGE_SIZE = {
    xs: 'h-4 px-1.5 text-[0.625rem]',
    sm: 'h-[18px] px-2 text-2xs',
    md: 'h-5 px-2.5 text-xs',
} as const;

/** A small label: a pill by default, or a barely rounded tag with `radius="xs"`. */
export function Badge({
    size = 'sm',
    variant = 'light',
    color = 'primary',
    radius = 'full',
    leftSection,
    className,
    children,
    ...props
}: Omit<ComponentPropsWithoutRef<'span'>, 'color'> & {
    size?: keyof typeof BADGE_SIZE;
    variant?: ToneVariant;
    color?: Tone;
    radius?: 'xs' | 'full';
    leftSection?: ReactNode;
}) {
    return (
        <span
            {...props}
            className={cx(
                'inline-flex items-center justify-center gap-1 font-bold uppercase leading-none whitespace-nowrap',
                radius === 'full' ? 'rounded-full' : 'rounded-xs',
                BADGE_SIZE[size],
                // Badges are labels, so the tone's hover treatment is dropped.
                toneClasses(variant, color)
                    .replace(/hover:\S+/g, '')
                    .trim(),
                className,
            )}
        >
            {leftSection}
            {children}
        </span>
    );
}

/** A link styled as the application's text link. */
export function Anchor({
    size = 'md',
    component = 'a',
    className,
    ...props
}: Omit<ComponentPropsWithoutRef<'a'>, 'type'> & {
    size?: TextSize;
    /** `button` for a link that performs an action instead of navigating. */
    component?: 'a' | 'button';
}) {
    const classes = cx(
        'cursor-pointer border-0 bg-transparent p-0 text-primary-text no-underline hover:underline',
        TEXT_SIZE[size],
        className,
    );
    return component === 'button' ? (
        <button
            type="button"
            {...(props as ComponentPropsWithoutRef<'button'>)}
            className={classes}
        />
    ) : (
        <a {...props} className={classes} />
    );
}

/** An icon on a tinted square, used to mark list entries and dialogs. */
export function ThemeIcon({
    size = 28,
    color = 'primary',
    variant = 'light',
    round,
    className,
    children,
}: {
    size?: number;
    color?: Tone;
    variant?: ToneVariant;
    /** A circle instead of a rounded square. */
    round?: boolean;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <span
            className={cx(
                'inline-flex shrink-0 items-center justify-center',
                round ? 'rounded-full' : 'rounded-sm',
                toneClasses(variant, color)
                    .replace(/hover:\S+/g, '')
                    .trim(),
                className,
            )}
            style={{ width: size, height: size }}
        >
            {children}
        </span>
    );
}

/** A spinner. */
const LOADER_SIZE = { xs: 12, sm: 16, md: 20 } as const;

export function Loader({
    size = 18,
    className,
}: {
    size?: number | keyof typeof LOADER_SIZE;
    className?: string;
}) {
    const edge = typeof size === 'number' ? size : LOADER_SIZE[size];
    return (
        <span
            role="status"
            aria-label="Loading"
            className={cx(
                'inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent text-primary',
                className,
            )}
            style={{ width: edge, height: edge }}
        />
    );
}

/** A pulsing placeholder shown while content loads. */
export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
    return (
        <div
            {...props}
            aria-hidden
            className={cx('animate-pulse-soft rounded-sm bg-neutral-soft', className)}
        />
    );
}

/** A determinate progress bar. */
export function Progress({
    value,
    className,
    ...props
}: {
    value: number;
    className?: string;
    /** Accepted for call-site compatibility; the bar is always the same slim height. */
    size?: string;
    animated?: boolean;
    'aria-label'?: string;
}) {
    return (
        <div
            role="progressbar"
            aria-label={props['aria-label']}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value)}
            className={cx('h-1.5 overflow-hidden rounded-full bg-neutral-soft', className)}
        >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${value}%` }} />
        </div>
    );
}

/** An inline notice with an optional icon, tinted by tone. */
export function Alert({
    color = 'blue',
    variant = 'light',
    icon,
    title,
    className,
    children,
    ...props
}: Omit<ComponentPropsWithoutRef<'div'>, 'color' | 'title'> & {
    color?: Tone;
    variant?: ToneVariant;
    icon?: ReactNode;
    title?: ReactNode;
}) {
    return (
        <div
            role="alert"
            {...props}
            className={cx(
                'flex gap-2 rounded-sm p-2 text-sm',
                toneClasses(variant, color)
                    .replace(/hover:\S+/g, '')
                    .trim(),
                className,
            )}
        >
            {icon && <span className="mt-px shrink-0">{icon}</span>}
            <div className="min-w-0 flex-1">
                {title && <div className="mb-0.5 font-semibold">{title}</div>}
                <div className={cx(variant === 'light' && 'text-fg')}>{children}</div>
            </div>
        </div>
    );
}

/** The Table family: a compact data table styled for dialogs. */
export function Table({ className, ...props }: ComponentPropsWithoutRef<'table'>) {
    return <table {...props} className={cx('w-full border-collapse text-sm', className)} />;
}
Table.Tbody = (props: ComponentPropsWithoutRef<'tbody'>) => <tbody {...props} />;
Table.Thead = (props: ComponentPropsWithoutRef<'thead'>) => <thead {...props} />;
Table.Tr = ({ className, ...props }: ComponentPropsWithoutRef<'tr'>) => (
    <tr {...props} className={cx('border-b border-line last:border-b-0', className)} />
);
Table.Th = ({ className, ...props }: ComponentPropsWithoutRef<'th'>) => (
    <th {...props} className={cx('px-1 py-1 text-left font-semibold', className)} />
);
Table.Td = ({ className, ...props }: ComponentPropsWithoutRef<'td'>) => (
    <td {...props} className={cx('px-1 py-1', className)} />
);
