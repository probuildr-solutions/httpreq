/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { Collection, Folder, HttpRequest } from '@httpreq/shared';

export interface ImportedVariable {
    key: string;
    value: string;
    enabled: boolean;
    secret: boolean;
}

/** Variables for one environment, identified by the name the source gave it. */
export interface ImportedEnvironment {
    name: string;
    variables: ImportedVariable[];
}

export type ImportFormat =
    | 'openapi'
    | 'swagger'
    | 'postman-collection'
    | 'postman-environment'
    | 'dotenv'
    | 'httpreq'
    | 'curl';

export const FORMAT_LABEL: Record<ImportFormat, string> = {
    openapi: 'OpenAPI 3',
    swagger: 'Swagger 2.0',
    'postman-collection': 'Postman collection',
    'postman-environment': 'Environment',
    dotenv: '.env file',
    httpreq: 'HttpReq export',
    curl: 'cURL command',
};

/**
 * What one import source turns into, before it touches the workspace. Ids are fresh, and parent
 * references point inside the plan, so applying it can never collide with existing data.
 */
export type ImportPlan =
    | {
          type: 'collection';
          format: ImportFormat;
          collection: Collection;
          folders: Folder[];
          requests: HttpRequest[];
          /** Variables the source defines for its requests (servers, collection variables). */
          environment?: ImportedEnvironment;
          /** Things the source contained that could not be carried over. */
          warnings: string[];
      }
    | { type: 'request'; format: ImportFormat; request: HttpRequest; warnings: string[] }
    | {
          type: 'environment';
          format: ImportFormat;
          environment: ImportedEnvironment;
          warnings: string[];
      };

/** What to do when an imported environment has the name of one that already exists. */
export type EnvironmentConflict = 'merge' | 'replace' | 'copy';
