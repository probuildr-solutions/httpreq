/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ScriptStage } from '@httpreq/shared';
import { findMember, GLOBALS, type ApiMember } from './scriptApi';

/**
 * Reading the script text around the cursor, without a JavaScript parser: just enough to tell
 * what a `.` follows (`httpreq.request.headers.`, `expect(x).to.`) and which call the cursor is
 * inside. The scripts the sandbox runs are short and written by hand, so a backwards scan of the
 * text before the cursor is both sufficient and cheap enough to run on every keystroke.
 */

const IDENTIFIER = /[A-Za-z0-9_$]/;
const BLANK = /\s/;

export interface MemberAccess {
    /** The receiver, outermost first: `['httpreq', 'request']`. A call is written `expect()`. */
    path: string[];
    /** What has been typed after the last dot. */
    partial: string;
    /** Offset in the text where `partial` begins. */
    partialStart: number;
}

const skipBlank = (text: string, index: number): number => {
    let i = index;
    while (i > 0 && BLANK.test(text[i - 1]!)) i -= 1;
    return i;
};

/** The index of the `(` that matches the `)` ending at `index`, or -1. */
const matchingOpen = (text: string, index: number): number => {
    let depth = 0;
    for (let i = index; i > 0; i -= 1) {
        const char = text[i - 1];
        if (char === ')') depth += 1;
        else if (char === '(') {
            depth -= 1;
            if (depth === 0) return i - 1;
        }
    }
    return -1;
};

/** The member access the cursor (at the end of `before`) is completing, or null when there is none. */
export const memberAccessAt = (before: string): MemberAccess | null => {
    let start = before.length;
    while (start > 0 && IDENTIFIER.test(before[start - 1]!)) start -= 1;
    const partial = before.slice(start);

    let index = skipBlank(before, start);
    if (before[index - 1] !== '.') return null;
    index -= 1;
    if (before[index - 1] === '?') index -= 1;

    const path: string[] = [];
    for (;;) {
        index = skipBlank(before, index);
        let call = false;
        if (before[index - 1] === ')') {
            const open = matchingOpen(before, index);
            if (open < 0) return null;
            index = skipBlank(before, open);
            call = true;
        }
        let nameStart = index;
        while (nameStart > 0 && IDENTIFIER.test(before[nameStart - 1]!)) nameStart -= 1;
        if (nameStart === index) return null;
        path.unshift(before.slice(nameStart, index) + (call ? '()' : ''));
        index = skipBlank(before, nameStart);
        if (before[index - 1] !== '.') break;
        index -= 1;
        if (before[index - 1] === '?') index -= 1;
    }
    return { path, partial, partialStart: start };
};

/** The type a receiver path evaluates to, or undefined when it is not part of the script API. */
export const resolveType = (path: string[], stage: ScriptStage): string | undefined => {
    const [first, ...rest] = path;
    if (!first) return undefined;
    const firstName = first.replace(/\(\)$/, '');
    const global = GLOBALS.find((member) => member.name === firstName);
    if (!global || !callable(global, first.endsWith('()'))) return undefined;
    let type = global.returns;
    for (const step of rest) {
        if (!type) return undefined;
        const member = findMember(type, step.replace(/\(\)$/, ''), stage);
        if (!member || !callable(member, step.endsWith('()'))) return undefined;
        type = member.returns;
    }
    return type;
};

/** A function must be called to give its result; a property must not be. */
const callable = (member: ApiMember, called: boolean): boolean =>
    member.kind === 'method' || member.kind === 'function' ? called : !called;

/** The member that `name` refers to after `path`, for hover. */
export const memberAt = (
    path: string[],
    name: string,
    stage: ScriptStage,
): ApiMember | undefined => {
    if (path.length === 0) return GLOBALS.find((member) => member.name === name);
    const type = resolveType(path, stage);
    return type ? findMember(type, name, stage) : undefined;
};

export interface CallSite {
    /** The function being called: its receiver path and name. */
    path: string[];
    name: string;
    /** Which argument the cursor is in, from 0. */
    argument: number;
}

/** The innermost call the cursor is inside, or null when it is not inside one. */
export const callSiteAt = (before: string): CallSite | null => {
    let depth = 0;
    let commas = 0;
    for (let i = before.length; i > 0; i -= 1) {
        const char = before[i - 1];
        if (char === ')' || char === ']' || char === '}') depth += 1;
        else if (char === '(' || char === '[' || char === '{') {
            if (depth === 0) {
                if (char !== '(') return null;
                const callee = before.slice(0, i - 1);
                let nameStart = callee.length;
                while (nameStart > 0 && IDENTIFIER.test(callee[nameStart - 1]!)) nameStart -= 1;
                const name = callee.slice(nameStart);
                if (!name) return null;
                // The method name stands in for the partial word, so the receiver is read as a member access.
                const access = memberAccessAt(`${callee.slice(0, nameStart)}x`);
                return { path: access?.path ?? [], name, argument: commas };
            }
            depth -= 1;
        } else if (char === ',' && depth === 0) commas += 1;
    }
    return null;
};
