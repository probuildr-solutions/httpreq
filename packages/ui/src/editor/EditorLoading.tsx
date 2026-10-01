/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { Loader, Skeleton, Text } from '../kit';

const LINES = [62, 84, 45, 70, 38, 56];

/**
 * Shown in an editor's place while Monaco loads: the shape of a few lines of code and a label,
 * so the panel reads as “coming” rather than empty or frozen.
 */
export function EditorLoading({ label = 'Loading editor…' }: { label?: string }) {
    return (
        <div
            className="relative flex size-full min-h-[60px] flex-col overflow-hidden px-3.5 py-3"
            role="status"
            aria-live="polite"
            aria-label={label}
        >
            <div className="flex flex-col gap-[9px]" aria-hidden>
                {LINES.map((width, index) => (
                    <Skeleton key={index} className="h-[9px]" style={{ width: `${width}%` }} />
                ))}
            </div>
            <div className="absolute right-3 bottom-2.5 flex items-center gap-1.5">
                <Loader size={12} />
                <Text size="xs" className="text-dimmed">
                    {label}
                </Text>
            </div>
        </div>
    );
}
