/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { DEFAULT_SPLIT_RATIO, usePreferences } from './preferences';
import { WorkbenchSplit } from './WorkbenchSplit';

/**
 * The layout shared by HTTP and WebSocket requests. What matters is that it is genuinely shared:
 * the position and ratio come from the application preferences, so the layout toggle moves a
 * WebSocket message log exactly as it moves an HTTP response.
 */

const mount = () =>
    render(
        <>
            <WorkbenchSplit
                requestId="request-editor"
                labels={{ request: 'Request', response: 'Response' }}
                splitterLabel="Resize request and response panels"
                request={<p>editor</p>}
                response={<p>output</p>}
            />
        </>,
    );

beforeEach(() => {
    act(() => {
        usePreferences.setState({
            responsePosition: 'right',
            splitRatio: { ...DEFAULT_SPLIT_RATIO },
        });
    });
});

describe('WorkbenchSplit', () => {
    it('names both panes and gives the splitter the request pane to control', () => {
        mount();
        expect(screen.getByRole('region', { name: 'Request' })).toContainElement(
            screen.getByText('editor'),
        );
        expect(screen.getByRole('region', { name: 'Response' })).toContainElement(
            screen.getByText('output'),
        );
        expect(screen.getByRole('separator')).toHaveAttribute('aria-controls', 'request-editor');
    });

    it('follows the application layout preference rather than a layout of its own', () => {
        mount();
        // Side by side: the splitter is a vertical bar between two columns.
        expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');

        act(() => usePreferences.getState().setResponsePosition('bottom'));
        expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('reads the ratio remembered for the current layout', () => {
        act(() => usePreferences.getState().setSplitRatio('right', 0.3));
        mount();
        expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '30');

        act(() => usePreferences.getState().setResponsePosition('bottom'));
        // Each layout keeps its own ratio, so switching does not carry the other one's over.
        expect(screen.getByRole('separator')).toHaveAttribute(
            'aria-valuenow',
            String(Math.round(DEFAULT_SPLIT_RATIO.bottom * 100)),
        );
    });
});
