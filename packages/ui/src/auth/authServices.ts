/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useContext } from 'react';
import type { OAuthTokens } from '@httpreq/api-client';
import type { OAuth2Auth } from '@httpreq/shared';

/** Capabilities that authorization editors need from the app, without importing it. */
export interface AuthServices {
    /** Resolves variables in `config` and runs the token request through the platform runtime. */
    requestTokens(
        config: OAuth2Auth,
        options?: { code?: string; codeVerifier?: string },
    ): Promise<OAuthTokens>;
    /** Writes a value to the active environment; false when no environment is selected. */
    setVariable(key: string, value: string): boolean;
    /** Opens an authorization URL in the system browser (desktop) or a new tab (web). */
    openUrl(url: string): void;
    /** Resolves `{{variables}}` for previews (e.g. building the authorization URL). */
    resolve(text: string): string;
}

const unavailable = () => Promise.reject(new Error('Authorization services are unavailable.'));

export const AuthServicesContext = createContext<AuthServices>({
    requestTokens: unavailable,
    setVariable: () => false,
    openUrl: () => undefined,
    resolve: (text) => text,
});

export const useAuthServices = () => useContext(AuthServicesContext);

export interface AuthEditorProps<C> {
    config: C;
    onChange: (config: C) => void;
}
