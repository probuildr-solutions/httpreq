/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { AuthConfig } from '@httpreq/shared';
import { isTemplateOnly } from '../variables';

/** How a credential is shown in a header preview: a variable reference as written, else masked. */
export const maskedCredential = (value: string, placeholder = '<token>') => {
    const trimmed = value.trim();
    if (!trimmed) return placeholder;
    return isTemplateOnly(trimmed) ? trimmed : '••••••••';
};

/** `<prefix> <credential>`, or the credential alone when the prefix is blank. */
export const withPrefix = (prefix: string, credential: string) =>
    prefix.trim() ? `${prefix.trim()} ${credential}` : credential;
import type { AuthContext, AuthProvider } from './types';

type Definition<C extends AuthConfig> = Omit<
    AuthProvider<C>,
    'resolve' | 'serialize' | 'deserialize' | 'validate' | 'appliedHeaders' | 'previewHeaders'
> &
    Partial<Pick<AuthProvider<C>, 'validate' | 'appliedHeaders' | 'previewHeaders'>> & {
        /** Allowed values of enumerated fields; anything else falls back to the default. */
        enums?: Partial<Record<keyof C & string, readonly unknown[]>>;
        /** Fields that are never variable-substituted (e.g. enumerations). */
        literalFields?: readonly (keyof C & string)[];
    };

/**
 * Builds a provider from its scheme-specific parts. Resolution substitutes variables in every
 * string field, persistence clears literal secrets (a `{{variable}}` reference is kept, since
 * the secret itself then lives in the environment), and deserialization type-checks each field
 * against the defaults from `create()`.
 */
export const defineProvider = <C extends AuthConfig>(
    definition: Definition<C>,
): AuthProvider<C> => {
    const { enums = {}, literalFields = [], ...provider } = definition;
    const literal = new Set<string>(['type', ...literalFields, ...Object.keys(enums)]);
    const enumValues = enums as Record<string, readonly unknown[] | undefined>;

    return {
        validate: () => [],
        appliedHeaders: () => [],
        // Unless a scheme says more, its headers are known by name only.
        previewHeaders(config: C) {
            return Object.fromEntries(
                (provider.appliedHeaders?.(config) ?? []).map((name) => [
                    name,
                    '<calculated when the request is sent>',
                ]),
            );
        },
        ...provider,
        resolve(config: C, context: AuthContext): C {
            const resolved: Record<string, unknown> = { ...config };
            for (const [key, value] of Object.entries(config)) {
                if (typeof value === 'string' && !literal.has(key))
                    resolved[key] = context.resolve(value);
            }
            return resolved as C;
        },
        serialize(config: C): C {
            const copy: Record<string, unknown> = { ...config };
            for (const field of provider.secretFields) {
                const value = copy[field];
                if (typeof value === 'string' && value && !isTemplateOnly(value)) copy[field] = '';
            }
            return copy as C;
        },
        deserialize(value: Record<string, unknown>): C | null {
            if (value.type !== provider.type) return null;
            const defaults = provider.create() as Record<string, unknown>;
            const result: Record<string, unknown> = {};
            for (const [key, fallback] of Object.entries(defaults)) {
                const candidate = value[key];
                const allowed = enumValues[key];
                if (allowed) result[key] = allowed.includes(candidate) ? candidate : fallback;
                else if (fallback === null)
                    result[key] = typeof candidate === 'number' ? candidate : null;
                else result[key] = typeof candidate === typeof fallback ? candidate : fallback;
            }
            return result as C;
        },
    };
};
