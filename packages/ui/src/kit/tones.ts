/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/** The semantic colours a component can take. `primary` is the application accent. */
export type Tone = 'primary' | 'gray' | 'red' | 'yellow' | 'teal' | 'blue' | 'violet';

/** Maps the colour names call sites use onto the semantic token family that implements them. */
const FAMILY: Record<Tone, 'primary' | 'neutral' | 'danger' | 'warning' | 'success' | 'info'> = {
    primary: 'primary',
    violet: 'primary',
    gray: 'neutral',
    red: 'danger',
    yellow: 'warning',
    teal: 'success',
    blue: 'info',
};

/*
 * Tailwind only emits classes it can find as whole strings in the source, so every variant of
 * every tone is spelled out here instead of being assembled from the tone name at runtime.
 */
const FILLED = {
    primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
    neutral: 'bg-neutral text-white hover:bg-neutral-hover',
    danger: 'bg-danger text-white hover:bg-danger-hover',
    warning: 'bg-warning text-white hover:bg-warning-hover',
    success: 'bg-success text-white hover:bg-success-hover',
    info: 'bg-info text-white hover:bg-info-hover',
} as const;

const SOFT = {
    primary: 'bg-primary-soft text-primary-text hover:bg-primary-soft-hover',
    neutral: 'bg-neutral-soft text-neutral-text hover:bg-neutral-soft',
    danger: 'bg-danger-soft text-danger-text hover:bg-danger-soft',
    warning: 'bg-warning-soft text-warning-text hover:bg-warning-soft',
    success: 'bg-success-soft text-success-text hover:bg-success-soft',
    info: 'bg-info-soft text-info-text hover:bg-info-soft',
} as const;

const SUBTLE = {
    primary: 'text-primary-text hover:bg-primary-soft',
    neutral: 'text-neutral-text hover:bg-neutral-soft',
    danger: 'text-danger-text hover:bg-danger-soft',
    warning: 'text-warning-text hover:bg-warning-soft',
    success: 'text-success-text hover:bg-success-soft',
    info: 'text-info-text hover:bg-info-soft',
} as const;

const OUTLINE = {
    primary: 'border border-primary text-primary-text hover:bg-primary-soft',
    neutral: 'border border-line text-neutral-text hover:bg-neutral-soft',
    danger: 'border border-danger text-danger-text hover:bg-danger-soft',
    warning: 'border border-warning text-warning-text hover:bg-warning-soft',
    success: 'border border-success text-success-text hover:bg-success-soft',
    info: 'border border-info text-info-text hover:bg-info-soft',
} as const;

export type ToneVariant = 'filled' | 'light' | 'subtle' | 'outline';

const VARIANTS = { filled: FILLED, light: SOFT, subtle: SUBTLE, outline: OUTLINE } as const;

/** Classes for a coloured control in the given variant. */
export const toneClasses = (variant: ToneVariant, tone: Tone): string =>
    VARIANTS[variant][FAMILY[tone]];

/** The neutral treatment shared by `default` buttons: a bordered control on the field surface. */
export const DEFAULT_CONTROL =
    'border border-line bg-field text-fg hover:bg-hover active:bg-pressed';

/**
 * Form density for editor panes (authorization, request settings). Default `sm` controls are 36px
 * tall while the app's variable-aware fields are 30px; inside a container carrying this class,
 * selects, number fields and buttons take the same 30px, so a form never mixes two heights.
 */
export const FORM_DENSITY = '[--control-h:1.875rem]';
