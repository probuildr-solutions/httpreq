/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { ReactNode } from 'react';
import { CloseButton, Group, Modal, type ModalRootProps } from './kit';

export interface AppModalProps extends Omit<ModalRootProps, 'children'> {
    title: ReactNode;
    /** The body: the message, content or form fields. It scrolls when the dialog is taller than the window. */
    children?: ReactNode;
    /**
     * The action buttons (Cancel, Save, Delete…), right-aligned in a footer pinned below the body,
     * so a long form never scrolls its actions out of view.
     */
    footer?: ReactNode;
    /** Secondary actions at the left end of the footer, such as “Test connection”. */
    footerStart?: ReactNode;
    withCloseButton?: boolean;
}

/**
 * Every dialog in the app: a header with the title and close button, a scrolling body and a footer
 * of actions, divided by rules. Use this instead of a bare `Modal` so popups stay consistent.
 * Header, body and footer are stacked, and only the body scrolls.
 */
export function AppModal({
    title,
    children,
    footer,
    footerStart,
    withCloseButton = true,
    onClose,
    ...props
}: AppModalProps) {
    return (
        <Modal {...props} onClose={onClose}>
            <header className="flex min-h-12 flex-none items-center justify-between border-b border-line py-2.5 pr-3 pl-4">
                <h2 className="m-0 text-sm font-semibold">{title}</h2>
                {withCloseButton && <CloseButton onClick={onClose} />}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
            {(footer || footerStart) && (
                <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-line bg-hover px-4 py-2.5">
                    {footerStart && <Group gap="xs">{footerStart}</Group>}
                    <Group gap="xs" className="ml-auto">
                        {footer}
                    </Group>
                </footer>
            )}
        </Modal>
    );
}
