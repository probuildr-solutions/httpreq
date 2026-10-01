/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { IconLayoutColumns, IconLayoutRows } from '@tabler/icons-react';
import { memo, useRef, type KeyboardEvent } from 'react';
import { ActionIcon, Tooltip } from './kit';
import { usePreferences, type ResponsePosition } from './preferences';

const options: { value: ResponsePosition; label: string; icon: typeof IconLayoutColumns }[] = [
    { value: 'right', label: 'Response right', icon: IconLayoutColumns },
    { value: 'bottom', label: 'Response bottom', icon: IconLayoutRows },
];

/**
 * Icon-only radio group choosing the application-wide response panel position. The buttons have a
 * fixed size: the toggle never takes width from the environment picker beside it, and never gives
 * any up either.
 */
export const LayoutToggle = memo(function LayoutToggle() {
    const value = usePreferences((state) => state.responsePosition);
    const setValue = usePreferences((state) => state.setResponsePosition);
    const refs = useRef<(HTMLButtonElement | null)[]>([]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const index = options.findIndex((option) => option.value === value);
        const next = options[(index + 1) % options.length]!;
        setValue(next.value);
        refs.current[options.indexOf(next)]?.focus();
    };

    return (
        <div
            role="radiogroup"
            aria-label="Response panel position"
            className="flex flex-none items-stretch border-l border-line"
            onKeyDown={onKeyDown}
        >
            {options.map((option, index) => {
                const checked = option.value === value;
                return (
                    <Tooltip key={option.value} label={option.label}>
                        <ActionIcon
                            ref={(element) => {
                                refs.current[index] = element;
                            }}
                            role="radio"
                            aria-checked={checked}
                            aria-label={option.label}
                            tabIndex={checked ? 0 : -1}
                            variant={checked ? 'light' : 'subtle'}
                            size={32}
                            // The selected layout is marked by an underline as well as colour.
                            className={
                                checked
                                    ? 'h-auto! min-h-0 rounded-none shadow-[inset_0_-2px_0_var(--color-primary)]'
                                    : 'h-auto! min-h-0 rounded-none'
                            }
                            onClick={() => setValue(option.value)}
                        >
                            <option.icon size={16} aria-hidden />
                        </ActionIcon>
                    </Tooltip>
                );
            })}
        </div>
    );
});
