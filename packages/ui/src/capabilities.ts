/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useContext } from 'react';
import { WEB_CAPABILITIES, type PlatformCapabilities } from '@httpreq/shared';

/**
 * What this build of HttpReq can do. One React application serves the browser and the desktop, so
 * every desktop-only feature reads this instead of guessing from `window.httpreq`.
 *
 * The default is the browser's set: a component that renders outside the provider (a test, a
 * storybook) gets the smaller capability set rather than accidentally enabling SSH.
 */
export const CapabilitiesContext = createContext<PlatformCapabilities>(WEB_CAPABILITIES);

export const useCapabilities = () => useContext(CapabilitiesContext);
