/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { IconChevronDown, IconChevronUp, IconSearch } from '@tabler/icons-react';
import type { KeyboardEvent } from 'react';
import { ActionIcon, CloseButton, Text, TextInput, Tooltip } from './kit';

interface Props {
    query: string;
    onQueryChange: (query: string) => void;
    /** Number of matches in the displayed response. */
    count: number;
    /** Zero-based index of the highlighted match. */
    current: number;
    onStep: (direction: 1 | -1) => void;
    onClose: () => void;
}

/**
 * The find bar of the response panel: it searches whatever the body view shows (text, JSON, XML,
 * HTML, or the events of a stream). Enter and Shift+Enter step through the matches, Esc closes.
 */
export function ResponseSearch({ query, onQueryChange, count, current, onStep, onClose }: Props) {
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
        }
    };
    const status = !query ? '' : count === 0 ? 'No results' : `${current + 1} of ${count}`;

    return (
        <div
            className="flex flex-none items-center gap-1 border-b border-line bg-chrome px-2.5 py-1"
            role="search"
        >
            <TextInput
                size="xs"
                className="min-w-[120px] flex-[0_1_280px]"
                aria-label="Search in response"
                placeholder="Search in response"
                leftSection={<IconSearch size={13} aria-hidden />}
                value={query}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
                onKeyDown={onKeyDown}
                data-autofocus
                autoFocus
            />
            <Text
                size="xs"
                className="min-w-16 whitespace-nowrap text-dimmed tabular-nums"
                aria-live="polite"
            >
                {status}
            </Text>
            <Tooltip label="Previous match (Shift+Enter)">
                <ActionIcon
                    size="sm"
                    aria-label="Previous match"
                    disabled={count === 0}
                    onClick={() => onStep(-1)}
                >
                    <IconChevronUp size={15} />
                </ActionIcon>
            </Tooltip>
            <Tooltip label="Next match (Enter)">
                <ActionIcon
                    size="sm"
                    aria-label="Next match"
                    disabled={count === 0}
                    onClick={() => onStep(1)}
                >
                    <IconChevronDown size={15} />
                </ActionIcon>
            </Tooltip>
            <CloseButton aria-label="Close search" onClick={onClose} />
        </div>
    );
}
