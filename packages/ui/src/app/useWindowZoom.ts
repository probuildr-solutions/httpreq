/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { useCallback, useEffect, useState } from 'react';
import type { DesktopBridge } from '@httpreq/shared';
import { usePreferences } from '../preferences';
import { applyWebZoom } from '../webZoom';

/**
 * Page zoom for both hosts. The desktop app zooms its window natively, so the hook only follows
 * Electron's level; the browser build scales the page itself from the stored preference.
 * `zoomed` drives the status bar's "Reset Zoom" control.
 */
export function useWindowZoom(desktop?: DesktopBridge) {
    const zoomLevel = usePreferences((state) => state.zoomLevel);
    const setZoomLevel = usePreferences((state) => state.setZoomLevel);

    // The desktop app zooms its window natively; the browser build scales the page itself.
    useEffect(() => {
        if (!desktop) applyWebZoom(zoomLevel);
    }, [desktop, zoomLevel]);
    // The desktop window's zoom lives in Electron; follow it so the status bar knows when to offer
    // the reset.
    const [desktopZoom, setDesktopZoom] = useState(0);
    useEffect(() => {
        if (!desktop) return;
        void desktop.getWindowState().then((state) => state && setDesktopZoom(state.zoomLevel));
        return desktop.onWindowStateChange((state) => setDesktopZoom(state.zoomLevel));
    }, [desktop]);
    const zoomed = Math.abs(desktop ? desktopZoom : zoomLevel) > 0.001;
    const resetZoom = useCallback(() => {
        if (desktop) desktop.performAction('zoom-reset');
        else setZoomLevel(0);
    }, [desktop, setZoomLevel]);

    return { zoomed, resetZoom };
}
