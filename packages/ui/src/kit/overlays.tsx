/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import {
    FloatingFocusManager,
    FloatingList,
    FloatingOverlay,
    FloatingPortal,
    autoUpdate,
    flip,
    offset as offsetMiddleware,
    shift,
    size as sizeMiddleware,
    useClick,
    useDismiss,
    useFloating,
    useFocus,
    useHover,
    useInteractions,
    useListItem,
    useListNavigation,
    useMergeRefs,
    useRole,
    type Placement,
} from '@floating-ui/react';
import {
    Children,
    cloneElement,
    createContext,
    isValidElement,
    useContext,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type ComponentPropsWithoutRef,
    type ReactElement,
    type ReactNode,
    type Ref,
} from 'react';
import { cx } from './cx';

/** Props the interaction hooks of floating-ui attach to a trigger. */
type ReferenceProps = Record<string, unknown>;

/**
 * Attaches a floating reference and its interaction props to the single child of a `Target`,
 * so the trigger keeps its own element and styling instead of gaining a wrapper.
 */
function Trigger({
    children,
    reference,
    props,
}: {
    children: ReactNode;
    reference: Ref<HTMLElement>;
    props: ReferenceProps;
}) {
    const child = Children.only(children);
    const own = isValidElement(child) ? (child as ReactElement<{ ref?: Ref<HTMLElement> }>) : null;
    const ref = useMergeRefs([reference, own?.props.ref ?? null]);
    if (!own) return <>{children}</>;
    return cloneElement(own, { ref, ...props } as object);
}

const POPUP = 'z-[1000] rounded-sm border border-line bg-surface text-fg shadow-popup';

/* -------------------------------------------------------------------------------------------- */
/* Tooltip                                                                                       */
/* -------------------------------------------------------------------------------------------- */

export interface TooltipProps {
    label: ReactNode;
    position?: Placement;
    openDelay?: number;
    disabled?: boolean;
    /** Width in pixels; the label wraps when it is set. */
    w?: number | string;
    children: ReactElement;
}

/** A hint shown on hover or keyboard focus. Desktop users read these, so the delay is generous. */
export function Tooltip({
    label,
    position = 'top',
    openDelay = 450,
    disabled,
    w,
    children,
}: TooltipProps) {
    const [open, setOpen] = useState(false);
    const { refs, floatingStyles, context } = useFloating({
        transform: false,
        open: open && !disabled,
        onOpenChange: setOpen,
        placement: position,
        whileElementsMounted: autoUpdate,
        middleware: [offsetMiddleware(6), flip(), shift({ padding: 6 })],
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([
        useHover(context, { move: false, delay: { open: openDelay, close: 0 } }),
        useFocus(context),
        useDismiss(context),
        useRole(context, { role: 'tooltip' }),
    ]);

    if (!label) return children;
    return (
        <>
            <Trigger reference={refs.setReference} props={getReferenceProps()}>
                {children}
            </Trigger>
            {open && !disabled && (
                <FloatingPortal>
                    <div
                        ref={refs.setFloating}
                        style={{ ...floatingStyles, width: w }}
                        {...getFloatingProps()}
                        className="pointer-events-none z-[1100] max-w-80 animate-fade rounded-sm bg-gray-9 px-2 py-1 text-xs text-white shadow-popup dark:bg-dark-0 dark:text-dark-9"
                    >
                        {label}
                    </div>
                </FloatingPortal>
            )}
        </>
    );
}

/* -------------------------------------------------------------------------------------------- */
/* Popover                                                                                       */
/* -------------------------------------------------------------------------------------------- */

interface PopoverState {
    reference: Ref<HTMLElement>;
    floating: Ref<HTMLElement>;
    referenceProps: ReferenceProps;
    floatingProps: ReferenceProps;
    style: CSSProperties;
    opened: boolean;
}

const PopoverContext = createContext<PopoverState | null>(null);

export interface PopoverProps {
    opened: boolean;
    onClose?: () => void;
    position?: Placement;
    offset?: number;
    /** `target` matches the dropdown to its trigger's width. */
    width?: number | 'target';
    children: ReactNode;
}

/** A controlled floating panel anchored to its target; the caller owns the open state. */
export function Popover({
    opened,
    onClose,
    position = 'bottom',
    offset = 6,
    width,
    children,
}: PopoverProps) {
    const { refs, floatingStyles, context } = useFloating({
        transform: false,
        open: opened,
        onOpenChange: (open) => !open && onClose?.(),
        placement: position,
        whileElementsMounted: autoUpdate,
        middleware: [
            offsetMiddleware(offset),
            flip(),
            shift({ padding: 6 }),
            sizeMiddleware({
                apply({ rects, elements }) {
                    if (width === 'target')
                        elements.floating.style.width = `${rects.reference.width}px`;
                },
            }),
        ],
    });
    const { getReferenceProps, getFloatingProps } = useInteractions([
        // Escape closes it; an outside press is the caller's call, as the target is often an input.
        useDismiss(context, { outsidePress: false }),
        useRole(context, { role: 'dialog' }),
    ]);

    return (
        <PopoverContext.Provider
            value={{
                reference: refs.setReference,
                floating: refs.setFloating,
                referenceProps: getReferenceProps(),
                floatingProps: getFloatingProps(),
                style: { ...floatingStyles, ...(typeof width === 'number' ? { width } : {}) },
                opened,
            }}
        >
            {children}
        </PopoverContext.Provider>
    );
}

function PopoverTarget({ children }: { children: ReactElement }) {
    const state = useContext(PopoverContext)!;
    return (
        <Trigger reference={state.reference} props={state.referenceProps}>
            {children}
        </Trigger>
    );
}

function PopoverDropdown({ className, children, ...props }: ComponentPropsWithoutRef<'div'>) {
    const state = useContext(PopoverContext)!;
    if (!state.opened) return null;
    return (
        <FloatingPortal>
            <div
                {...state.floatingProps}
                {...props}
                ref={state.floating as Ref<HTMLDivElement>}
                style={state.style}
                className={cx(POPUP, 'animate-pop p-1', className)}
            >
                {children}
            </div>
        </FloatingPortal>
    );
}

Popover.Target = PopoverTarget;
Popover.Dropdown = PopoverDropdown;

/* -------------------------------------------------------------------------------------------- */
/* Menu                                                                                          */
/* -------------------------------------------------------------------------------------------- */

interface MenuState {
    reference: Ref<HTMLElement>;
    floating: Ref<HTMLElement>;
    referenceProps: ReferenceProps;
    floatingProps: ReferenceProps;
    getItemProps: (props?: ReferenceProps) => ReferenceProps;
    style: CSSProperties;
    open: boolean;
    /** Closes the menu after an item was chosen. */
    close: () => void;
    context: ReturnType<typeof useFloating>['context'];
    items: React.RefObject<Array<HTMLElement | null>>;
    activeIndex: number | null;
}

const MenuContext = createContext<MenuState | null>(null);

export interface MenuProps {
    /** Controls the menu from outside; omit it and the menu manages its own state. */
    opened?: boolean;
    onChange?: (opened: boolean) => void;
    /** Whether focus goes back to the trigger when the menu closes. */
    returnFocus?: boolean;
    /** Same as `onChange(false)`, for call sites that only care about closing. */
    onClose?: () => void;
    position?: Placement;
    width?: number;
    children: ReactNode;
}

/** A click-to-open action menu with arrow-key navigation, closed by Escape or an outside click. */
export function Menu({
    opened,
    onChange,
    onClose,
    returnFocus = true,
    position = 'bottom-start',
    width,
    children,
}: MenuProps) {
    const [internal, setInternal] = useState(false);
    const open = opened ?? internal;
    const setOpen = (next: boolean) => {
        setInternal(next);
        onChange?.(next);
        if (!next) onClose?.();
    };

    /*
     * Focus goes back to the trigger shortly after the menu closes by choosing an item or pressing
     * Escape, so keyboard users keep their place. The decision is made when the delay ends, not
     * when the menu closes: a chosen item may open a rename field, and pulling focus away from it
     * would blur the field and commit the unchanged name before anyone could type.
     */
    const returnFocusRef = useRef(returnFocus);
    returnFocusRef.current = returnFocus;
    const restoreFocus = () => {
        setTimeout(() => {
            if (returnFocusRef.current) referenceElement.current?.focus();
        }, 10);
    };
    const referenceElement = useRef<HTMLElement | null>(null);
    const [activeIndex, setActiveIndex] = useState<number | null>(null);
    const items = useRef<Array<HTMLElement | null>>([]);

    const { refs, floatingStyles, context } = useFloating({
        transform: false,
        open,
        onOpenChange: (next, _event, reason) => {
            setOpen(next);
            if (!next && reason === 'escape-key') restoreFocus();
        },
        placement: position,
        whileElementsMounted: autoUpdate,
        middleware: [offsetMiddleware(4), flip(), shift({ padding: 6 })],
    });
    referenceElement.current = (refs.domReference.current as HTMLElement | null) ?? null;
    const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
        useClick(context),
        useDismiss(context),
        useRole(context, { role: 'menu' }),
        useListNavigation(context, {
            listRef: items,
            activeIndex,
            onNavigate: setActiveIndex,
            loop: true,
        }),
    ]);

    return (
        <MenuContext.Provider
            value={{
                reference: refs.setReference,
                floating: refs.setFloating,
                referenceProps: getReferenceProps(),
                floatingProps: getFloatingProps(),
                getItemProps,
                style: { ...floatingStyles, ...(width ? { width } : {}) },
                open,
                close: () => {
                    setOpen(false);
                    restoreFocus();
                },
                context,
                items,
                activeIndex,
            }}
        >
            {children}
        </MenuContext.Provider>
    );
}

function MenuTarget({ children }: { children: ReactElement }) {
    const state = useContext(MenuContext)!;
    return (
        <Trigger reference={state.reference} props={state.referenceProps}>
            {children}
        </Trigger>
    );
}

function MenuDropdown({ className, children, ...props }: ComponentPropsWithoutRef<'div'>) {
    const state = useContext(MenuContext)!;
    if (!state.open) return null;
    return (
        <FloatingPortal>
            <FloatingFocusManager context={state.context} initialFocus={-1} returnFocus={false}>
                <div
                    {...state.floatingProps}
                    {...props}
                    ref={state.floating as Ref<HTMLDivElement>}
                    style={state.style}
                    className={cx(POPUP, 'min-w-40 animate-pop p-1 outline-none', className)}
                >
                    <FloatingList elementsRef={state.items}>{children}</FloatingList>
                </div>
            </FloatingFocusManager>
        </FloatingPortal>
    );
}

function MenuItem({
    leftSection,
    rightSection,
    color,
    disabled,
    onClick,
    className,
    children,
    ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'color'> & {
    leftSection?: ReactNode;
    rightSection?: ReactNode;
    color?: 'red';
}) {
    const state = useContext(MenuContext)!;
    // The list registers each item, so its index survives re-renders and conditional items.
    const { ref, index } = useListItem({
        label: typeof children === 'string' ? children : undefined,
    });
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            data-disabled={disabled || undefined}
            tabIndex={state.activeIndex === index ? 0 : -1}
            ref={ref}
            {...props}
            {...state.getItemProps({
                onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                    onClick?.(event);
                    state.close();
                },
            })}
            className={cx(
                'flex w-full items-center gap-2 rounded-xs px-2.5 py-1.5 text-left text-sm outline-none',
                'hover:bg-hover focus:bg-hover disabled:pointer-events-none disabled:opacity-50',
                color === 'red' && 'text-danger-text hover:bg-danger-soft focus:bg-danger-soft',
                className,
            )}
        >
            {leftSection && <span className="flex shrink-0 items-center">{leftSection}</span>}
            <span className="min-w-0 flex-1">{children}</span>
            {rightSection && (
                <span className="flex shrink-0 items-center text-dimmed">{rightSection}</span>
            )}
        </button>
    );
}

Menu.Target = MenuTarget;
Menu.Dropdown = MenuDropdown;
Menu.Item = MenuItem;
Menu.Label = ({ children }: { children: ReactNode }) => (
    <div className="px-2.5 py-1 text-xs font-medium text-dimmed">{children}</div>
);
Menu.Divider = () => <hr role="separator" className="my-1 border-0 border-t border-line" />;

/* -------------------------------------------------------------------------------------------- */
/* Modal                                                                                         */
/* -------------------------------------------------------------------------------------------- */

const MODAL_WIDTH = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

/** Props of the dialog shell; `AppModal` adds the header, body and footer. */
export interface ModalRootProps {
    opened: boolean;
    onClose: () => void;
    size?: keyof typeof MODAL_WIDTH;
    centered?: boolean;
    zIndex?: number;
    closeOnEscape?: boolean;
    closeOnClickOutside?: boolean;
    trapFocus?: boolean;
    returnFocus?: boolean;
    children: ReactNode;
}

/**
 * The dialog shell: a dimmed overlay, a focus trap and Escape / outside-click dismissal. It owns
 * no layout of its own; `AppModal` supplies the header, body and footer.
 */
export function Modal({
    opened,
    onClose,
    size = 'md',
    zIndex = 200,
    closeOnEscape = true,
    closeOnClickOutside = true,
    trapFocus = true,
    returnFocus = true,
    children,
}: ModalRootProps) {
    const { refs, context } = useFloating({
        transform: false,
        open: opened,
        onOpenChange: (open) => !open && onClose(),
    });
    const { getFloatingProps } = useInteractions([
        useDismiss(context, { escapeKey: closeOnEscape, outsidePress: closeOnClickOutside }),
        useRole(context, { role: 'dialog' }),
    ]);

    // Focus goes to the element marked `data-autofocus` (e.g. the confirm button), else to a field
    // that asked for it with `autoFocus`, else to the first control, else to the dialog itself.
    useEffect(() => {
        if (!opened) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let attempts = 0;
        const focusDialog = () => {
            const dialog = refs.floating.current;
            // The portal mounts a render after `opened` flips, so the dialog may not exist yet.
            if (!dialog) {
                if (attempts++ < 10) timer = setTimeout(focusDialog, 16);
                return;
            }
            if (dialog.contains(document.activeElement)) return;
            const target =
                dialog.querySelector<HTMLElement>('[data-autofocus]') ??
                dialog.querySelector<HTMLElement>(
                    'input:not([type=hidden]), textarea, select, button:not([aria-label=Close])',
                ) ??
                dialog;
            target.focus();
        };
        timer = setTimeout(focusDialog, 0);
        return () => clearTimeout(timer);
    }, [opened, refs.floating]);

    if (!opened) return null;
    return (
        <FloatingPortal>
            <FloatingOverlay
                lockScroll
                style={{ zIndex }}
                className="grid animate-fade place-items-center bg-overlay p-4"
            >
                <FloatingFocusManager
                    context={context}
                    modal={trapFocus}
                    returnFocus={returnFocus}
                    initialFocus={-1}
                >
                    <div
                        ref={refs.setFloating}
                        {...getFloatingProps()}
                        className={cx(
                            'flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-md border border-line bg-surface shadow-popup outline-none',
                            MODAL_WIDTH[size],
                        )}
                    >
                        {children}
                    </div>
                </FloatingFocusManager>
            </FloatingOverlay>
        </FloatingPortal>
    );
}
