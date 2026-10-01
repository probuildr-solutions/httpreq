/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type {
    AuthConfig,
    AuthType,
    HttpMethod,
    HttpResponse,
    PreparedRequest,
} from '@httpreq/shared';

/** Case-insensitive header collection that keeps the casing a header was first written with. */
export class HeaderMap {
    private readonly entries = new Map<string, [name: string, value: string]>();

    constructor(initial?: Record<string, string>) {
        Object.entries(initial ?? {}).forEach(([name, value]) => this.set(name, value));
    }

    set(name: string, value: string) {
        this.entries.set(name.toLowerCase(), [name, value]);
    }

    get(name: string) {
        return this.entries.get(name.toLowerCase())?.[1];
    }

    has(name: string) {
        return this.entries.has(name.toLowerCase());
    }

    delete(name: string) {
        this.entries.delete(name.toLowerCase());
    }

    toRecord(): Record<string, string> {
        return Object.fromEntries(this.entries.values());
    }
}

/** The request as authorization sees it while the pipeline is building it. */
export interface RequestDraft {
    method: HttpMethod;
    url: URL;
    headers: HeaderMap;
}

export interface AuthContext {
    /** Substitutes `{{variables}}` from the active environment. */
    resolve(text: string): string;
    now(): number;
}

export interface AuthIssue {
    field?: string;
    message: string;
    /** Errors stop the request from being sent; warnings are only shown. */
    severity: 'error' | 'warning';
}

export type AuthConfigOf<T extends AuthType> = Extract<AuthConfig, { type: T }>;

/**
 * One authorization scheme. The execution engine only talks to this contract, so adding a scheme
 * (e.g. NTLM on desktop) means adding a provider and an editor, never touching the pipeline.
 */
export interface AuthProvider<C extends AuthConfig = AuthConfig> {
    readonly type: C['type'];
    readonly label: string;
    readonly description: string;
    /** Fields holding credentials: masked in the UI and never persisted as literal values. */
    readonly secretFields: readonly (keyof C & string)[];
    /** A new, empty configuration. */
    create(): C;
    /** Problems with the (unresolved) configuration, for the editor and before sending. */
    validate(config: C): AuthIssue[];
    /** Substitutes variables, returning the configuration used for this execution only. */
    resolve(config: C, context: AuthContext): C;
    /** Adds credentials to the request (headers or query). */
    applyToRequest(config: C, request: RequestDraft, context: AuthContext): void | Promise<void>;
    /** Header names this scheme writes, used to flag conflicts with manually configured headers. */
    appliedHeaders(config: C): string[];
    /**
     * The headers this scheme will add, for display. Values never contain a credential: a literal
     * secret is masked, while a `{{variable}}` reference is shown as written.
     */
    previewHeaders(config: C): Record<string, string>;
    /** Answers an authentication challenge (e.g. a Digest 401) with a request to retry once. */
    handleChallenge?(
        config: C,
        request: PreparedRequest,
        response: HttpResponse,
        context: AuthContext,
    ): Promise<PreparedRequest | null>;
    /** The configuration to persist: literal secrets are removed, variable references kept. */
    serialize(config: C): C;
    /** Validates untrusted stored or imported data, filling defaults for missing fields. */
    deserialize(value: Record<string, unknown>): C | null;
}
