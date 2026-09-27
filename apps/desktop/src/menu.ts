import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { DOCUMENTATION_URL, type MenuCommand } from '@httpreq/shared';

interface MacMenuHandlers {
  command(command: MenuCommand): void;
  openExternal(url: string): void;
}

/**
 * macOS keeps a native global menu bar, so its menu mirrors the in-window React menu used on
 * Windows and Linux. App commands forward to the renderer, whose centralized shortcut manager
 * owns their key bindings (`registerAccelerator: false` avoids handling a key twice); edit and
 * window roles stay native so text editing and window management behave like any Mac app.
 */
export const buildMacMenu = ({ command, openExternal }: MacMenuHandlers) => {
  const item = (
    label: string,
    id: MenuCommand,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => command(id),
  });

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        item('Check for Updates…', 'help.check-updates'),
        { type: 'separator' },
        item('Settings…', 'tools.settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('New Request', 'request.new', 'Cmd+T'),
        { type: 'separator' },
        item('Import…', 'file.import'),
        item('Export…', 'file.export'),
        { type: 'separator' },
        item('Save', 'request.save', 'Cmd+S'),
        { type: 'separator' },
        item('Close Request', 'request.close', 'Cmd+W'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Response Right', 'view.response-right'),
        item('Response Bottom', 'view.response-bottom'),
        { type: 'separator' },
        item('Toggle Sidebar', 'view.toggle-sidebar', 'Cmd+B'),
        item('Toggle Status Bar', 'view.toggle-status-bar'),
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Request',
      submenu: [
        item('Send Request', 'request.send', 'Cmd+Enter'),
        item('Save Request', 'request.save', 'Cmd+S'),
        item('Duplicate Request', 'request.duplicate'),
        { type: 'separator' },
        item('Close Request', 'request.close', 'Cmd+W'),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => openExternal(DOCUMENTATION_URL) },
        item('Keyboard Shortcuts', 'help.shortcuts'),
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
};
