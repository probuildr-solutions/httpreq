/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { IconCode } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import type { HttpRequest } from '@httpreq/shared';
import { ActionIcon, Popover, Tooltip } from '../kit';
import { CodeGenerationPanel } from './CodeGenerationPanel';

interface Props {
    request: HttpRequest;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * The `</>` button beside Save and Send, and the popover it opens. It is controlled so that
 * other actions (Copy as cURL for a gRPC request, which cURL cannot express) can open it too.
 * The panel is mounted only while open, so a closed popover costs nothing.
 */
export function CodeGenerationButton({ request, open, onOpenChange }: Props) {
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);

    // Keyboard users arrive on the language selector rather than having to tab into the popover.
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() =>
            panel.current?.querySelector<HTMLElement>('button')?.focus(),
        );
        return () => cancelAnimationFrame(frame);
    }, [open]);

    return (
        <Popover
            opened={open}
            position="bottom-end"
            offset={6}
            closeOnClickOutside
            onClose={(reason) => {
                onOpenChange(false);
                // Escape returns to the button; a click elsewhere keeps the focus where it landed.
                if (reason === 'escape-key') trigger.current?.focus();
            }}
        >
            <Tooltip label="Generate code" disabled={open}>
                <Popover.Target>
                    <ActionIcon
                        ref={trigger}
                        variant={open ? 'light' : 'default'}
                        size={32}
                        aria-label="Generate code"
                        onClick={() => onOpenChange(!open)}
                    >
                        <IconCode size={17} />
                    </ActionIcon>
                </Popover.Target>
            </Tooltip>
            <Popover.Dropdown
                aria-label="Code generation"
                className="w-[560px] max-w-[calc(100vw-16px)] p-2.5"
            >
                <div ref={panel}>
                    <CodeGenerationPanel request={request} />
                </div>
            </Popover.Dropdown>
        </Popover>
    );
}
