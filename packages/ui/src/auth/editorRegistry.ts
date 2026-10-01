/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { ComponentType } from 'react';
import type { AuthConfigOf } from '@httpreq/api-client';
import type { AuthType } from '@httpreq/shared';
import type { AuthEditorProps } from './authServices';
import { JwtEditor } from './JwtEditor';
import { OAuth2Editor } from './OAuth2Editor';
import { ApiKeyEditor, BasicEditor, BearerEditor } from './SimpleEditors';

type EditorRegistry = {
    [T in AuthType]: ComponentType<AuthEditorProps<AuthConfigOf<T>>> | null;
};

/**
 * Configuration editor per scheme, mirroring the provider registry in `@httpreq/api-client`.
 * `none` and `inherit` have no fields; the Authorization panel renders their states itself.
 */
export const authEditors: EditorRegistry = {
    none: null,
    inherit: null,
    'api-key': ApiKeyEditor,
    bearer: BearerEditor,
    basic: BasicEditor,
    digest: BasicEditor,
    jwt: JwtEditor,
    oauth2: OAuth2Editor,
};
