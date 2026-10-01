/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import { prettyJsonText, prettyXmlText } from './prettyText';

describe('pretty-printing', () => {
    it('indents JSON with four spaces', () => {
        expect(prettyJsonText('{"a":[1]}')).toEqual({
            text: '{\n    "a": [\n        1\n    ]\n}',
            ok: true,
        });
    });

    it('indents XML with four spaces and keeps text elements on one line', () => {
        expect(prettyXmlText('<?xml version="1.0"?><a><b>1</b><c/><!-- note --></a>')).toEqual({
            text: '<?xml version="1.0"?>\n<a>\n    <b>1</b>\n    <c/>\n    <!-- note -->\n</a>',
            ok: true,
        });
    });

    it('returns invalid content unchanged instead of mangling it', () => {
        expect(prettyJsonText('{nope')).toEqual({ text: '{nope', ok: false });
        expect(prettyXmlText('<a><b></a>')).toEqual({ text: '<a><b></a>', ok: false });
        expect(prettyXmlText('plain text')).toEqual({ text: 'plain text', ok: false });
    });
});
