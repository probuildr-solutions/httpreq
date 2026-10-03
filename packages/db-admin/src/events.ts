/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ObjectName, SqlDialect } from './dialect';

/**
 * Scheduled events (MySQL's event scheduler). The form edits an `EventDesign`; the statements come
 * from here, so the user picks dates and intervals instead of writing `ON SCHEDULE EVERY …`.
 */
export const EVENT_INTERVAL_UNITS = [
    'SECOND',
    'MINUTE',
    'HOUR',
    'DAY',
    'WEEK',
    'MONTH',
    'QUARTER',
    'YEAR',
] as const;

export type EventIntervalUnit = (typeof EVENT_INTERVAL_UNITS)[number];

export type EventStatus = 'ENABLE' | 'DISABLE' | 'DISABLE ON SLAVE';

export interface EventDesign extends ObjectName {
    schedule: 'once' | 'recurring';
    /** `YYYY-MM-DD HH:MM:SS` for a one-off event; the first run of a recurring one when set. */
    start?: string;
    /** Recurring only: no run after this moment. */
    end?: string;
    /** Recurring only: the gap between runs. */
    interval?: { every: number; unit: EventIntervalUnit };
    status: EventStatus;
    /** `ON COMPLETION PRESERVE`: keep the event after its last run. */
    preserve: boolean;
    comment?: string;
    body: string;
}

export const emptyEvent = (): EventDesign => ({
    name: '',
    schedule: 'recurring',
    interval: { every: 1, unit: 'DAY' },
    status: 'ENABLE',
    preserve: true,
    body: '',
});

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/;

/** A date-time as the server reads it: `YYYY-MM-DD HH:MM:SS`. */
export const normalizeTimestamp = (value: string): string => {
    const text = value.trim().replace('T', ' ');
    return /^\S+ \d{2}:\d{2}$/.test(text) ? `${text}:00` : text;
};

/** Why an event cannot be created; empty when it can. */
export const validateEvent = (event: EventDesign): string[] => {
    const problems: string[] = [];
    if (!event.name.trim()) problems.push('The event needs a name.');
    if (event.schedule === 'once') {
        if (!event.start?.trim()) problems.push('Choose when the event runs.');
    } else {
        const every = event.interval?.every ?? 0;
        if (!Number.isInteger(every) || every < 1)
            problems.push('The interval must be a whole number of at least 1.');
        if (
            event.start &&
            event.end &&
            normalizeTimestamp(event.end) <= normalizeTimestamp(event.start)
        )
            problems.push('The end must come after the start.');
    }
    for (const [label, value] of [
        ['start', event.start],
        ['end', event.end],
    ] as const) {
        if (value?.trim() && !TIMESTAMP.test(value.trim()))
            problems.push(`The ${label} must be a date and time.`);
    }
    if (!event.body.trim()) problems.push('The event needs a body.');
    return problems;
};

const scheduleSql = (dialect: SqlDialect, event: EventDesign): string => {
    const stamp = (value: string) =>
        dialect.literal({ kind: 'text', value: normalizeTimestamp(value) });
    if (event.schedule === 'once')
        return `AT ${event.start ? stamp(event.start) : 'CURRENT_TIMESTAMP'}`;
    const interval = event.interval ?? { every: 1, unit: 'DAY' as const };
    return (
        `EVERY ${Math.max(1, Math.floor(interval.every))} ${interval.unit}` +
        (event.start?.trim() ? ` STARTS ${stamp(event.start)}` : '') +
        (event.end?.trim() ? ` ENDS ${stamp(event.end)}` : '')
    );
};

const eventBody = (body: string): string => {
    const text = body.trim().replace(/;+\s*$/, '');
    // More than one statement needs a compound block.
    return /^begin\b/i.test(text) || !text.includes(';') ? text : `BEGIN\n${text};\nEND`;
};

export const createEventSql = (dialect: SqlDialect, event: EventDesign): string[] => [
    `CREATE EVENT ${dialect.qualify(event)}\nON SCHEDULE ${scheduleSql(dialect, event)}\nON COMPLETION ${
        event.preserve ? '' : 'NOT '
    }PRESERVE\n${event.status}${
        event.comment?.trim()
            ? `\nCOMMENT ${dialect.literal({ kind: 'text', value: event.comment.trim() })}`
            : ''
    }\nDO ${eventBody(event.body)};`,
];

/** Editing an event: it is dropped and created again, as MySQL's `ALTER EVENT` cannot change a body safely in one step. */
export const alterEventSql = (dialect: SqlDialect, event: EventDesign): string[] => [
    dropEventSql(dialect, event, true),
    ...createEventSql(dialect, event),
];

export const dropEventSql = (dialect: SqlDialect, event: ObjectName, ifExists = false): string =>
    `DROP EVENT ${ifExists ? 'IF EXISTS ' : ''}${dialect.qualify(event)};`;

/** Reads what the form needs back out of `SHOW CREATE EVENT`'s statement. */
export const eventFromDefinition = (definition: string, name: ObjectName): EventDesign => {
    const event = emptyEvent();
    event.name = name.name;
    event.database = name.database;
    event.schema = name.schema;
    const at = /ON SCHEDULE\s+AT\s+'([^']+)'/i.exec(definition);
    const every =
        /ON SCHEDULE\s+EVERY\s+(\d+)\s+(\w+)(?:\s+STARTS\s+'([^']+)')?(?:\s+ENDS\s+'([^']+)')?/i.exec(
            definition,
        );
    if (at) {
        event.schedule = 'once';
        event.start = at[1];
        delete event.interval;
    } else if (every) {
        event.schedule = 'recurring';
        event.interval = {
            every: Number(every[1]),
            unit: (every[2]!.toUpperCase() as EventIntervalUnit) ?? 'DAY',
        };
        event.start = every[3];
        event.end = every[4];
    }
    event.preserve = !/ON COMPLETION NOT PRESERVE/i.test(definition);
    event.status = /\bDISABLE ON SLAVE\b/i.test(definition)
        ? 'DISABLE ON SLAVE'
        : /\bDISABLE\b/i.test(definition)
          ? 'DISABLE'
          : 'ENABLE';
    event.comment = /\bCOMMENT\s+'((?:[^']|'')*)'/i.exec(definition)?.[1]?.replace(/''/g, "'");
    const body = /\bDO\s+([\s\S]*)$/i.exec(definition);
    event.body = body ? body[1]!.trim().replace(/;+\s*$/, '') : '';
    return event;
};
