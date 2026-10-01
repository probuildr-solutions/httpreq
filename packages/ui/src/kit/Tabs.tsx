/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    createContext,
    forwardRef,
    useContext,
    useId,
    type ComponentPropsWithoutRef,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import { cx } from './cx';

interface TabsState {
    value: string | null;
    select: (value: string) => void;
    base: string;
}

const TabsContext = createContext<TabsState | null>(null);

const useTabs = () => {
    const state = useContext(TabsContext);
    if (!state) throw new Error('Tabs parts must be rendered inside <Tabs>.');
    return state;
};

export interface TabsProps extends Omit<ComponentPropsWithoutRef<'div'>, 'onChange'> {
    value: string | null;
    onChange: (value: string | null) => void;
    children: ReactNode;
}

/** A controlled tab set: a list of tabs and the panel of the selected one. */
export function Tabs({ value, onChange, className, children, ...props }: TabsProps) {
    const base = useId();
    return (
        <TabsContext.Provider value={{ value, select: onChange, base }}>
            <div {...props} className={cx('flex flex-col', className)}>
                {children}
            </div>
        </TabsContext.Provider>
    );
}

/**
 * The row of tabs. Arrow keys, Home and End move between tabs and select the one reached, so the
 * list behaves like the WAI-ARIA tabs pattern with automatic activation.
 */
const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function TabsList(
    { className, onKeyDown, ...props },
    ref,
) {
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        const tabs = [
            ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not(:disabled)'),
        ];
        const current = tabs.indexOf(document.activeElement as HTMLElement);
        if (current < 0) return;
        event.preventDefault();
        const next =
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.focus();
        tabs[next]?.click();
    };

    return (
        <div
            ref={ref}
            role="tablist"
            {...props}
            onKeyDown={handleKeyDown}
            className={cx('flex flex-nowrap', className)}
        />
    );
});

function TabsTab({
    value,
    className,
    children,
    ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'value'> & { value: string }) {
    const { value: current, select, base } = useTabs();
    const active = current === value;
    return (
        <button
            type="button"
            role="tab"
            id={`${base}-tab-${value}`}
            aria-selected={active}
            aria-controls={`${base}-panel-${value}`}
            tabIndex={active ? 0 : -1}
            data-active={active || undefined}
            {...props}
            onClick={(event) => {
                props.onClick?.(event);
                select(value);
            }}
            className={cx(
                'inline-flex flex-none items-center gap-1 border-0 border-b-2 border-transparent bg-transparent px-2.5 py-[7px] text-[12.5px] whitespace-nowrap',
                'text-dimmed transition-colors hover:bg-hover hover:text-fg',
                'data-[active]:border-primary data-[active]:text-fg',
                className,
            )}
        >
            {children}
        </button>
    );
}

function TabsPanel({
    value,
    keepMounted,
    className,
    children,
    ...props
}: ComponentPropsWithoutRef<'div'> & { value: string; keepMounted?: boolean }) {
    const { value: current, base } = useTabs();
    const active = current === value;
    // A panel that is not selected is unmounted unless asked to stay, so a hidden editor costs nothing.
    if (!active && !keepMounted) return null;
    return (
        <div
            role="tabpanel"
            id={`${base}-panel-${value}`}
            aria-labelledby={`${base}-tab-${value}`}
            hidden={!active}
            {...props}
            className={className}
        >
            {children}
        </div>
    );
}

Tabs.List = TabsList;
Tabs.Tab = TabsTab;
Tabs.Panel = TabsPanel;
