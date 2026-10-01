/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createId, type KeyValueItem } from '@httpreq/shared';

/**
 * Query-string helpers that keep the URL and the Params table in sync. They work on raw text and
 * never percent-encode or decode, so `{{variables}}` survive untouched and a parse/rebuild round
 * trip is lossless. Encoding happens once, at execution time, on the resolved URL.
 */

export interface SplitUrl {
    base: string;
    query: string | null;
    hash: string;
}

export const splitUrl = (url: string): SplitUrl => {
    const hashIndex = url.indexOf('#');
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const queryIndex = beforeHash.indexOf('?');
    return queryIndex >= 0
        ? { base: beforeHash.slice(0, queryIndex), query: beforeHash.slice(queryIndex + 1), hash }
        : { base: beforeHash, query: null, hash };
};

export const parseQuery = (query: string): { key: string; value: string }[] =>
    query
        .split('&')
        .filter((pair) => pair.length > 0)
        .map((pair) => {
            const equals = pair.indexOf('=');
            return equals >= 0
                ? { key: pair.slice(0, equals), value: pair.slice(equals + 1) }
                : { key: pair, value: '' };
        });

// Only characters that would change the query's structure are escaped when rebuilding.
const escapeKey = (text: string) => text.replace(/[&#=]/g, (char) => encodeURIComponent(char));
const escapeValue = (text: string) => text.replace(/[&#]/g, (char) => encodeURIComponent(char));

const serializePair = (item: Pick<KeyValueItem, 'key' | 'value'>) =>
    item.value === '' && item.key !== ''
        ? escapeKey(item.key)
        : `${escapeKey(item.key)}=${escapeValue(item.value)}`;

/**
 * Params after the user edited the URL: the URL's pairs become the enabled rows (keeping the ids
 * and descriptions of rows at the same position with the same key), and disabled rows, which are
 * not part of the URL, are kept after them.
 */
export const paramsFromUrl = (url: string, previous: KeyValueItem[]): KeyValueItem[] => {
    const { query } = splitUrl(url);
    const pairs = query === null ? [] : parseQuery(query);
    const enabled = previous.filter((item) => item.enabled);
    const disabled = previous.filter((item) => !item.enabled);
    const unused = [...enabled];
    const next = pairs.map((pair, index) => {
        const positional = enabled[index];
        const match =
            positional && positional.key === pair.key && unused.includes(positional)
                ? positional
                : unused.find((item) => item.key === pair.key);
        if (match) unused.splice(unused.indexOf(match), 1);
        return match
            ? { ...match, key: pair.key, value: pair.value }
            : { id: createId(), key: pair.key, value: pair.value, enabled: true };
    });
    return [...next, ...disabled];
};

/** URL after the user edited the Params table: the query is rebuilt from the enabled rows. */
export const urlWithParams = (url: string, params: KeyValueItem[]): string => {
    const { base, hash } = splitUrl(url);
    const query = params
        .filter((item) => item.enabled && (item.key !== '' || item.value !== ''))
        .map(serializePair)
        .join('&');
    return `${base}${query ? `?${query}` : ''}${hash}`;
};
