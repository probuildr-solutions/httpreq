/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import type { MenuDefinition } from '../MenuBar';

/**
 * The application menu, as data. Entries name commands by id; labels, shortcuts and enabled state
 * come from the command registry (`buildCommands`), so adding a menu item never means touching a
 * component. Windows and Linux render it in the title bar; macOS builds a native menu from the
 * same command ids.
 */
export const APP_MENUS: MenuDefinition[] = [
    {
        label: 'File',
        mnemonic: 'f',
        entries: [
            { command: 'request.new' },
            { command: 'websocket.new' },
            { command: 'collection.new' },
            { separator: true },
            { command: 'file.import' },
            { command: 'file.export' },
            { separator: true },
            { command: 'request.save' },
            { command: 'request.save-as' },
            { separator: true },
            { command: 'request.close' },
            { separator: true },
            { command: 'app.exit' },
        ],
    },
    {
        label: 'Edit',
        mnemonic: 'e',
        entries: [
            { command: 'edit.undo' },
            { command: 'edit.redo' },
            { separator: true },
            { command: 'edit.cut' },
            { command: 'edit.copy' },
            { command: 'edit.paste' },
            { separator: true },
            { command: 'edit.select-all' },
        ],
    },
    {
        label: 'View',
        mnemonic: 'v',
        entries: [
            { command: 'view.response-right', role: 'radio' },
            { command: 'view.response-bottom', role: 'radio' },
            { separator: true },
            { command: 'view.toggle-sidebar', role: 'checkbox' },
            { command: 'view.toggle-status-bar', role: 'checkbox' },
            { command: 'view.toggle-theme' },
            { separator: true },
            { command: 'view.zoom-in' },
            { command: 'view.zoom-out' },
            { command: 'view.zoom-reset' },
            { separator: true },
            { command: 'view.fullscreen' },
        ],
    },
    {
        label: 'Request',
        mnemonic: 'r',
        entries: [
            { command: 'request.send' },
            { command: 'request.send-focus' },
            { command: 'request.focus-url' },
            { separator: true },
            { command: 'request.save' },
            { command: 'request.save-as' },
            { command: 'request.duplicate' },
            { separator: true },
            { command: 'request.next' },
            { command: 'request.previous' },
            { separator: true },
            { command: 'request.close' },
        ],
    },
    { label: 'Tools', mnemonic: 't', entries: [{ command: 'tools.settings' }] },
    {
        label: 'Help',
        mnemonic: 'h',
        entries: [
            { command: 'help.documentation' },
            { command: 'help.shortcuts' },
            { separator: true },
            { command: 'help.devtools' },
            { separator: true },
            { command: 'help.check-updates' },
            { command: 'help.about' },
        ],
    },
];
