/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { createContext, useContext } from 'react';
import { createVariableResolver, type VariableResolver } from '@httpreq/api-client';

export interface VariableScope {
    resolver: VariableResolver;
    /** Active environment name, or null when none is selected. */
    environmentName: string | null;
}

export const VariableContext = createContext<VariableScope>({
    resolver: createVariableResolver(null),
    environmentName: null,
});

/** Variables of the active environment, for highlighting, tooltips and autocomplete. */
export const useVariables = () => useContext(VariableContext);
