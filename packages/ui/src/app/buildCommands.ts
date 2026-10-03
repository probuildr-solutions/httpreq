/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { RefObject } from 'react';
import { getAncestors } from '@httpreq/workspace';
import type { DesktopBridge } from '@httpreq/shared';
import type { CommandMap } from '../commands';
import { openExportDialog } from '../export/exportDialogStore';
import { openImportDialog } from '../import/importDialogStore';
import { toggleColorScheme } from '../kit';
import { usePreferences, type ResponsePosition } from '../preferences';
import { editableRequest, useWorkbenchStore } from '../store';
import { nextZoomLevel } from '../webZoom';

/** The dialogs the Settings, Help and Tools commands open. */
export type AppDialog = 'settings' | 'shortcuts' | 'about';

/** Everything the command set reads or calls; the registry itself owns no state. */
export interface CommandDeps {
    desktop?: DesktopBridge;
    mac: boolean;
    urlRef: RefObject<HTMLInputElement | null>;
    tabCount: number;
    httpTabActive: boolean;
    requestTabActive: boolean;
    responsePosition: ResponsePosition;
    sidebarVisible: boolean;
    statusBarVisible: boolean;
    /** Whether "Check for Updates" is offered at all (off in development builds). */
    updateCheck: boolean;
    newRequest: () => void;
    newWebSocket: () => void;
    createCollection: () => unknown;
    saveActive: () => Promise<boolean>;
    saveActiveAs: () => void;
    closeTab: (id: string) => Promise<void>;
    send: (focusResponse?: boolean) => Promise<void>;
    duplicateNode: (id: string) => unknown;
    cycleRequest: (step: 1 | -1) => void;
    activateTab: (id: string) => void;
    setResponsePosition: (position: ResponsePosition) => void;
    toggleSidebar: () => void;
    toggleStatusBar: () => void;
    openDocumentation: () => void;
    checkUpdatesNow: () => Promise<void>;
    openDialog: (dialog: AppDialog) => void;
    /**
     * Set while Database Studio's workspace is in front: Save, Save As and Close then act on its
     * active file instead of the (hidden) request tabs, and the request-only commands are off.
     */
    studio?: { save: () => void; saveAs: () => void; close: () => void; hasTab: boolean };
}

/**
 * The command registry: every action the menus, shortcuts and native macOS menu can run, keyed by
 * a stable id. Menus and the shortcut manager only look commands up here, so a new action is one
 * entry in this map and one line in `APP_MENUS`, with nothing else to change (open for extension,
 * closed for modification).
 *
 * Platform differences are explicit: macOS provides edit, zoom and full-screen through its native
 * menu roles, the desktop build drives the window through Electron, and the browser build offers
 * page zoom and the Fullscreen API instead.
 */
export function buildCommands(deps: CommandDeps): CommandMap {
    const {
        desktop,
        mac,
        urlRef,
        tabCount,
        httpTabActive,
        requestTabActive,
        responsePosition,
        sidebarVisible,
        statusBarVisible,
        updateCheck,
        newRequest,
        newWebSocket,
        createCollection,
        saveActive,
        saveActiveAs,
        closeTab,
        send,
        duplicateNode,
        cycleRequest,
        activateTab,
        setResponsePosition,
        toggleSidebar,
        toggleStatusBar,
        openDocumentation,
        checkUpdatesNow,
        openDialog,
        studio,
    } = deps;
    const active = () => {
        const state = useWorkbenchStore.getState();
        return state.activeSshSessionId ?? state.activeEnvironmentTabId ?? state.activeRequestId;
    };
    const map: CommandMap = {
        'request.new': {
            label: 'New Request',
            shortcut: [{ key: 't', mod: true }],
            run: newRequest,
        },
        'websocket.new': {
            label: 'New WebSocket Request',
            shortcut: [{ key: 't', mod: true, shift: true }],
            run: newWebSocket,
        },
        'collection.new': { label: 'New Collection', run: () => void createCollection() },
        'file.import': { label: 'Import…', run: () => openImportDialog() },
        'file.export': {
            label: 'Export…',
            // The open request's collection, or the request itself when it is not in one.
            run: () => {
                const state = useWorkbenchStore.getState();
                const request = editableRequest(state, state.activeRequestId);
                if (!request) return;
                const collection = getAncestors(state.workspace, request.id).find(
                    (ancestor) => ancestor.kind === 'collection',
                );
                openExportDialog(
                    collection
                        ? { kind: 'collection', id: collection.node.id }
                        : { kind: 'request', request },
                );
            },
            disabled: !httpTabActive,
        },
        'request.save': {
            label: 'Save',
            shortcut: [{ key: 's', mod: true }],
            run: studio ? studio.save : () => void saveActive(),
            disabled: studio ? !studio.hasTab : tabCount === 0,
        },
        'request.save-as': {
            label: 'Save As…',
            shortcut: [{ key: 's', mod: true, shift: true }],
            run: studio ? studio.saveAs : saveActiveAs,
            disabled: studio ? !studio.hasTab : !requestTabActive,
        },
        'request.close': {
            label: 'Close Request',
            shortcut: [{ key: 'w', mod: true }],
            run: () => {
                if (studio) return studio.close();
                const id = active();
                if (id) void closeTab(id);
            },
            disabled: studio ? !studio.hasTab : tabCount === 0,
        },
        'request.send': {
            label: 'Send Request',
            shortcut: [{ key: 'Enter', mod: true }],
            run: () => void send(),
            disabled: !httpTabActive,
        },
        'request.send-focus': {
            label: 'Send and Focus Response',
            shortcut: [{ key: 'Enter', mod: true, shift: true }],
            run: () => void send(true),
            disabled: !httpTabActive,
        },
        'request.focus-url': {
            label: 'Focus URL',
            shortcut: [{ key: 'l', mod: true }],
            run: () => {
                urlRef.current?.focus();
                urlRef.current?.select();
            },
            disabled: !httpTabActive,
        },
        'request.duplicate': {
            label: 'Duplicate Request',
            run: () => {
                const id = active();
                if (id) duplicateNode(id);
            },
            disabled: tabCount === 0,
        },
        'request.next': {
            label: 'Next Request',
            shortcut: [
                { key: 'Tab', ctrl: true },
                { key: 'PageDown', ctrl: true },
            ],
            run: () => cycleRequest(1),
            disabled: tabCount <= 1,
            repeatable: true,
        },
        'request.previous': {
            label: 'Previous Request',
            shortcut: [
                { key: 'Tab', ctrl: true, shift: true },
                { key: 'PageUp', ctrl: true },
            ],
            run: () => cycleRequest(-1),
            disabled: tabCount <= 1,
            repeatable: true,
        },
        'view.response-right': {
            label: 'Response Right',
            run: () => setResponsePosition('right'),
            checked: responsePosition === 'right',
        },
        'view.response-bottom': {
            label: 'Response Bottom',
            run: () => setResponsePosition('bottom'),
            checked: responsePosition === 'bottom',
        },
        'view.toggle-sidebar': {
            label: 'Sidebar',
            shortcut: [{ key: 'b', mod: true }],
            run: toggleSidebar,
            checked: sidebarVisible,
        },
        'view.toggle-status-bar': {
            label: 'Status Bar',
            run: toggleStatusBar,
            checked: statusBarVisible,
        },
        'view.toggle-theme': { label: 'Toggle Dark Theme', run: () => toggleColorScheme() },
        'tools.settings': {
            label: 'Settings…',
            shortcut: [{ key: ',', mod: true }],
            run: () => openDialog('settings'),
        },
        'help.documentation': { label: 'Documentation', run: openDocumentation },
        'help.shortcuts': { label: 'Keyboard Shortcuts', run: () => openDialog('shortcuts') },
        'help.about': { label: 'About HttpReq', run: () => openDialog('about') },
    };
    if (updateCheck) {
        map['help.check-updates'] = {
            label: 'Check for Updates…',
            run: () => void checkUpdatesNow(),
        };
    }
    for (let position = 1; position <= 9; position += 1) {
        map[`request.goto-${position}`] = {
            label: `Go to Request ${position}`,
            shortcut: [{ key: String(position), code: `Digit${position}`, mod: true }],
            run: () => {
                const state = useWorkbenchStore.getState();
                const target = [
                    ...state.workspace.openRequestIds,
                    ...state.openEnvironmentTabIds,
                    ...state.openSshSessionIds,
                ][position - 1];
                if (target) activateTab(target);
            },
        };
    }

    if (desktop) {
        const action = desktop.performAction;
        // macOS provides edit, zoom and full-screen through its native menu roles instead.
        if (!mac) {
            const edit = (label: string, key: string, run: () => void, shift = false) => ({
                label,
                // Shown in the menu only: the OS/editor already handles these keys natively.
                shortcut: [{ key, mod: true, shift }],
                allowInEditable: false,
                passive: true,
                run,
            });
            Object.assign(map, {
                'edit.undo': edit('Undo', 'z', () => action('undo')),
                'edit.redo': edit('Redo', 'y', () => action('redo')),
                'edit.cut': edit('Cut', 'x', () => action('cut')),
                'edit.copy': edit('Copy', 'c', () => action('copy')),
                'edit.paste': edit('Paste', 'v', () => action('paste')),
                'edit.select-all': edit('Select All', 'a', () => action('select-all')),
                'view.zoom-in': {
                    label: 'Zoom In',
                    shortcut: [
                        { key: '=', mod: true },
                        { key: '+', mod: true, shift: true },
                        { key: '+', mod: true },
                    ],
                    run: () => action('zoom-in'),
                },
                'view.zoom-out': {
                    label: 'Zoom Out',
                    shortcut: [
                        { key: '-', mod: true },
                        { key: '_', mod: true, shift: true },
                    ],
                    run: () => action('zoom-out'),
                },
                'view.zoom-reset': {
                    label: 'Reset Zoom',
                    shortcut: [{ key: '0', code: 'Digit0', mod: true }],
                    run: () => action('zoom-reset'),
                },
                'view.fullscreen': {
                    label: 'Full Screen',
                    shortcut: [{ key: 'F11' }],
                    run: () => action('toggle-fullscreen'),
                },
                'app.exit': { label: 'Exit', run: () => action('quit') },
            } satisfies CommandMap);
        }
        map['help.devtools'] = {
            label: 'Toggle Developer Tools',
            run: () => action('toggle-devtools'),
        };
    } else {
        // The browser owns Ctrl +/-, so the page zoom has menu commands but no shortcuts.
        const zoom = (direction: 'in' | 'out' | 'reset') => () =>
            usePreferences
                .getState()
                .setZoomLevel(nextZoomLevel(usePreferences.getState().zoomLevel, direction));
        map['view.zoom-in'] = { label: 'Zoom In', run: zoom('in') };
        map['view.zoom-out'] = { label: 'Zoom Out', run: zoom('out') };
        map['view.zoom-reset'] = { label: 'Reset Zoom', run: zoom('reset') };
    }
    if (!desktop && typeof document !== 'undefined' && document.fullscreenEnabled) {
        map['view.fullscreen'] = {
            label: 'Full Screen',
            run: () =>
                void (document.fullscreenElement
                    ? document.exitFullscreen()
                    : document.documentElement.requestFullscreen()),
        };
    }
    return map;
}
