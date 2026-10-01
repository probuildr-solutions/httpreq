/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { KeyValueItem } from '@httpreq/shared';

/** `key: value` lines; `//` disables a row. Descriptions are matched back by key. */
export const toBulkText = (items: KeyValueItem[]) =>
    items.map((item) => `${item.enabled ? '' : '//'}${item.key}: ${item.value}`).join('\n');

export const fromBulkText = <T extends KeyValueItem>(
    text: string,
    previous: T[],
    create: (patch: Partial<KeyValueItem>) => T,
): T[] => {
    const unused = [...previous];
    return text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
            const enabled = !line.trimStart().startsWith('//');
            const content = enabled ? line : line.trimStart().slice(2);
            const separator = content.indexOf(':');
            const key = (separator >= 0 ? content.slice(0, separator) : content).trim();
            const value = separator >= 0 ? content.slice(separator + 1).trim() : '';
            const match = unused.find((item) => item.key === key);
            if (match) unused.splice(unused.indexOf(match), 1);
            return match ? { ...match, key, value, enabled } : create({ key, value, enabled });
        });
};
