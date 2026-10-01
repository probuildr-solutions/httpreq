/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { ReactNode } from 'react';
import { cx } from '../kit';
import { SECTION_LABEL } from './styles';

/**
 * The title strip at the top of every sidebar view (collections, environments, history, SSH,
 * tunnels). One component, so every view has the same height, rule and type, and that strip lines
 * up exactly with the request tab strip beside it (`--hr-strip-height`) whichever view is open.
 */
export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
    return (
        <div className="box-border flex h-[var(--hr-strip-height)] flex-none items-center gap-0.5 border-b border-line pr-1.5 pl-3">
            <h2 className={cx('m-0 flex-1', SECTION_LABEL)}>{title}</h2>
            {children}
        </div>
    );
}
