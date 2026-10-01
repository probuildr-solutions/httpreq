/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Suggestions for the request tables: header names and their usual values, query parameter names,
 * and the `{{variable}}` that probably belongs in a path variable. They are data and a lookup,
 * not component code, so the tables stay free of knowledge about HTTP.
 */

export const HEADER_NAMES = [
    'Accept',
    'Accept-Charset',
    'Accept-Encoding',
    'Accept-Language',
    'Authorization',
    'Cache-Control',
    'Content-Disposition',
    'Content-Encoding',
    'Content-Language',
    'Content-Type',
    'Cookie',
    'DNT',
    'If-Match',
    'If-Modified-Since',
    'If-None-Match',
    'If-Unmodified-Since',
    'Idempotency-Key',
    'Origin',
    'Pragma',
    'Prefer',
    'Range',
    'Referer',
    'User-Agent',
    'X-API-Key',
    'X-Correlation-ID',
    'X-CSRF-Token',
    'X-Forwarded-For',
    'X-HTTP-Method-Override',
    'X-Request-ID',
    'X-Requested-With',
] as const;

export const MEDIA_TYPES = [
    'application/json',
    'application/xml',
    'application/x-www-form-urlencoded',
    'application/octet-stream',
    'application/pdf',
    'application/problem+json',
    'application/graphql',
    'multipart/form-data',
    'text/plain',
    'text/html',
    'text/xml',
    'text/csv',
    'image/png',
    'image/jpeg',
] as const;

const HEADER_VALUES: Record<string, readonly string[]> = {
    accept: ['application/json', 'application/xml', 'text/html', 'text/plain', '*/*'],
    'accept-charset': ['utf-8'],
    'accept-encoding': ['gzip, deflate, br', 'gzip', 'identity'],
    'accept-language': ['en-US', 'en-US,en;q=0.9', 'en-GB'],
    authorization: ['Bearer {{token}}', 'Basic ', 'Bearer '],
    'cache-control': [
        'no-cache',
        'no-store',
        'max-age=0',
        'max-age=3600',
        'no-cache, no-store, must-revalidate',
    ],
    'content-encoding': ['gzip', 'deflate', 'br'],
    'content-type': MEDIA_TYPES,
    'content-language': ['en-US'],
    dnt: ['1'],
    pragma: ['no-cache'],
    prefer: ['return=minimal', 'return=representation'],
    range: ['bytes=0-1023'],
    'x-http-method-override': ['PUT', 'PATCH', 'DELETE'],
    'x-requested-with': ['XMLHttpRequest'],
    'x-request-id': ['{{$guid}}'],
    'x-correlation-id': ['{{$guid}}'],
    'idempotency-key': ['{{$guid}}'],
};

/** Usual values of a header, found by name in any casing; empty for a header with free-form values. */
export const headerValueSuggestions = (name: string): readonly string[] =>
    HEADER_VALUES[name.trim().toLowerCase()] ?? [];

export const QUERY_PARAM_NAMES = [
    'page',
    'per_page',
    'page_size',
    'limit',
    'offset',
    'cursor',
    'sort',
    'sort_by',
    'order',
    'q',
    'query',
    'search',
    'filter',
    'fields',
    'include',
    'expand',
    'format',
    'lang',
] as const;

const QUERY_VALUES: Record<string, readonly string[]> = {
    sort: ['asc', 'desc'],
    order: ['asc', 'desc'],
    format: ['json', 'xml', 'csv'],
    lang: ['en', 'fr', 'de', 'es'],
    page: ['1'],
    limit: ['10', '25', '50', '100'],
    per_page: ['10', '25', '50', '100'],
    page_size: ['10', '25', '50', '100'],
    offset: ['0'],
};

export const queryValueSuggestions = (name: string): readonly string[] =>
    QUERY_VALUES[name.trim().toLowerCase()] ?? [];

/** Body field names for form bodies. */
export const FORM_FIELD_NAMES = [
    'username',
    'password',
    'email',
    'grant_type',
    'client_id',
    'client_secret',
    'scope',
    'code',
    'refresh_token',
    'file',
    'name',
    'description',
] as const;

const FORM_VALUES: Record<string, readonly string[]> = {
    grant_type: ['password', 'client_credentials', 'authorization_code', 'refresh_token'],
};

export const formValueSuggestions = (name: string): readonly string[] =>
    FORM_VALUES[name.trim().toLowerCase()] ?? [];

/**
 * The variable a path variable most likely takes its value from: `{{userId}}` for `:userId` when
 * the environment has one, also trying the snake_case and kebab-case spellings.
 */
export const pathVariableSuggestions = (
    name: string,
    variableNames: readonly string[],
): string[] => {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((word) => word.toLowerCase());
    const candidates = new Set([name, words.join('_'), words.join('-'), words.join('')]);
    const lower = new Map(variableNames.map((variable) => [variable.toLowerCase(), variable]));
    const matches = [...candidates].flatMap(
        (candidate) => lower.get(candidate.toLowerCase()) ?? [],
    );
    return [...new Set(matches)].map((variable) => `{{${variable}}}`);
};
