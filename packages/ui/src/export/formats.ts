import { resolveEffectiveAuth } from '@httpreq/api-client';
import type { HttpRequest, Workspace } from '@httpreq/shared';
import { stringify as stringifyYaml } from 'yaml';
import { exportCollection, exportRequest } from '../exchange';
import { stringifyPretty } from '../indent';
import { toOpenApi } from './openapi';
import { toPostmanCollection } from './postman';
import { collectionSource, requestSource, type ExportSource } from './source';

/** What is being exported: a whole collection, or one request on its own. */
export type ExportTarget =
  { kind: 'collection'; id: string } | { kind: 'request'; request: HttpRequest };

export const EXPORT_FORMATS = ['httpreq', 'postman', 'openapi-json', 'openapi-yaml'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportFormatInfo {
  label: string;
  description: string;
  /** Appended to the file name, before nothing else: `Users.postman_collection.json`. */
  suffix: string;
  mime: string;
}

export const EXPORT_FORMAT_INFO: Record<ExportFormat, ExportFormatInfo> = {
  httpreq: {
    label: 'HttpReq',
    description: 'Everything HttpReq stores, for importing back into HttpReq.',
    suffix: 'httpreq.json',
    mime: 'application/json',
  },
  postman: {
    label: 'Postman Collection v2.1',
    description: 'Imports into Postman, Insomnia, Bruno, Hoppscotch and most API clients.',
    suffix: 'postman_collection.json',
    mime: 'application/json',
  },
  'openapi-json': {
    label: 'OpenAPI 3.1 (JSON)',
    description: 'An API description for documentation, code generation and API gateways.',
    suffix: 'openapi.json',
    mime: 'application/json',
  },
  'openapi-yaml': {
    label: 'OpenAPI 3.1 (YAML)',
    description: 'The same OpenAPI description, written as YAML.',
    suffix: 'openapi.yaml',
    mime: 'application/yaml',
  },
};

export interface ExportResult {
  fileName: string;
  mime: string;
  text: string;
  /** What the format could not carry over, for the user to see before saving. */
  warnings: string[];
}

export const exportFileName = (name: string, format: ExportFormat) =>
  `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'export'}.${EXPORT_FORMAT_INFO[format].suffix}`;

/** The format-independent content of an export, or null when its collection no longer exists. */
export const exportSource = (workspace: Workspace, target: ExportTarget): ExportSource | null =>
  target.kind === 'collection'
    ? collectionSource(workspace, target.id)
    : requestSource(
        workspace,
        target.request,
        resolveEffectiveAuth(workspace, target.request).auth,
      );

/** Builds the file for one target in one format. Returns null when the target no longer exists. */
export const buildExport = (
  workspace: Workspace,
  target: ExportTarget,
  format: ExportFormat,
): ExportResult | null => {
  const info = EXPORT_FORMAT_INFO[format];
  if (format === 'httpreq') {
    const data =
      target.kind === 'collection'
        ? exportCollection(workspace, target.id)
        : exportRequest(workspace, target.request);
    if (!data) return null;
    const name =
      target.kind === 'collection'
        ? (data as { collection: { name: string } }).collection.name
        : target.request.name;
    return {
      fileName: exportFileName(name, format),
      mime: info.mime,
      text: stringifyPretty(data),
      warnings: [],
    };
  }
  const source = exportSource(workspace, target);
  if (!source) return null;
  const { document, warnings } =
    format === 'postman' ? toPostmanCollection(source) : toOpenApi(source);
  return {
    fileName: exportFileName(source.name, format),
    mime: info.mime,
    text: format === 'openapi-yaml' ? stringifyYaml(document) : stringifyPretty(document),
    warnings,
  };
};
