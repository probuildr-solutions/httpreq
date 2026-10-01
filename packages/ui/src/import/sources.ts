/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { parse as parseYaml } from 'yaml';
import { isHttpReqExport, parseHttpReqExport } from '../exchange';
import { parseCurl } from './curl';
import { ImportError } from './errors';
import { fromOpenApi, isOpenApiDocument } from './openapi';
import {
    fromPostmanCollection,
    fromPostmanEnvironment,
    isPostmanCollection,
    isPostmanEnvironment,
} from './postman';
import type { ImportedEnvironment, ImportPlan } from './types';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** Larger files are refused before they are read, so a stray video cannot hang the import. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const extension = (path: string) => {
    const name = baseName(path).toLowerCase();
    if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'env';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1) : '';
};

const SUPPORTED = new Set(['json', 'yaml', 'yml', 'env', 'curl', 'sh', 'txt']);

/** Whether a file's name makes it worth reading; anything else in a folder is skipped. */
export const isSupportedFile = (path: string) => SUPPORTED.has(extension(path));

export const SUPPORTED_ACCEPT = '.json,.yaml,.yml,.env,.curl,.sh,.txt,application/json';

/** The environment name a `.env` file implies: `.env.staging` and `staging.env` are “staging”. */
const dotenvName = (path: string) => {
    const name = baseName(path);
    const stem = name.replace(/^\.env\.?/i, '').replace(/\.env$/i, '');
    return stem || 'Environment';
};

/** `KEY=value` lines, with `#` comments, optional `export` and quoted values. */
export const parseDotenv = (text: string, path: string): ImportedEnvironment => {
    const variables: ImportedEnvironment['variables'] = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
        if (!match) {
            throw new ImportError(
                `Line ${index + 1} is not a KEY=value pair: “${trimmed.slice(0, 40)}”.`,
            );
        }
        let value = match[2]!;
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
            value = value.slice(1, -1);
            if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        } else {
            value = value.replace(/\s+#.*$/, '');
        }
        variables.push({ key: match[1]!, value, enabled: true, secret: false });
    });
    if (!variables.length) throw new ImportError('The .env file does not define any variables.');
    return { name: dotenvName(path), variables };
};

/** An HttpReq-style environment: `{ name, variables: [{ key, value }] }`. */
const isPlainEnvironment = (doc: Json) =>
    typeof doc.name === 'string' &&
    Array.isArray(doc.variables) &&
    doc.variables.every((item) => isObject(item) && typeof item.key === 'string');

const fromDocument = (doc: unknown, path: string, yaml: boolean): ImportPlan => {
    if (!isObject(doc)) {
        throw new ImportError(`The file does not contain a ${yaml ? 'YAML' : 'JSON'} object.`);
    }
    const name = baseName(path);
    if (isOpenApiDocument(doc)) return fromOpenApi(doc, name);
    if (!yaml) {
        if (isPostmanEnvironment(doc)) {
            return {
                type: 'environment',
                format: 'postman-environment',
                environment: fromPostmanEnvironment(doc, name),
                warnings: [],
            };
        }
        if (isPostmanCollection(doc)) return fromPostmanCollection(doc, name);
        if (Array.isArray(doc.requests) && Array.isArray(doc.order)) {
            throw new ImportError(
                'Postman Collection v1 is not supported. Export the collection as v2.1 from Postman.',
            );
        }
        if (isHttpReqExport(doc)) {
            let fragment;
            try {
                fragment = parseHttpReqExport(doc);
            } catch (error) {
                throw new ImportError((error as Error).message);
            }
            const collection = fragment.collections[0];
            return collection
                ? {
                      type: 'collection',
                      format: 'httpreq',
                      collection,
                      folders: fragment.folders,
                      requests: fragment.requests,
                      warnings: [],
                  }
                : {
                      type: 'request',
                      format: 'httpreq',
                      request: fragment.requests[0]!,
                      warnings: [],
                  };
        }
        if (isPlainEnvironment(doc)) {
            return {
                type: 'environment',
                format: 'postman-environment',
                environment: fromPostmanEnvironment(
                    { name: doc.name, values: doc.variables },
                    name,
                ),
                warnings: [],
            };
        }
    }
    throw new ImportError(
        'This file is not in a supported format. HttpReq imports OpenAPI 3.x, Swagger 2.0, Postman collections (v2.0/v2.1), Postman environments, .env files and HttpReq exports.',
    );
};

/** Where in a JSON text a parse error happened, as “line 3, column 7”. */
const jsonErrorLocation = (text: string, message: string) => {
    const position = Number(message.match(/position (\d+)/)?.[1]);
    if (!Number.isFinite(position)) return '';
    const before = text.slice(0, position).split('\n');
    return ` (line ${before.length}, column ${before[before.length - 1]!.length + 1})`;
};

/**
 * Turns the text of one import source into a plan. Throws `ImportError` with a message that says
 * what is wrong with the file.
 */
export const parseImportSource = (path: string, text: string): ImportPlan => {
    const kind = extension(path);
    if (!SUPPORTED.has(kind)) {
        throw new ImportError(`“.${kind || '?'}” files are not supported.`);
    }
    // A byte-order mark is common in files saved on Windows and trips up JSON.parse.
    const content = text.replace(/^\uFEFF/, '');
    if (!content.trim()) throw new ImportError('The file is empty.');

    if (kind === 'env') {
        return {
            type: 'environment',
            format: 'dotenv',
            environment: parseDotenv(content, path),
            warnings: [],
        };
    }
    if (kind === 'curl' || kind === 'sh' || kind === 'txt') {
        if (!/^\s*curl(\.exe)?\s/i.test(content)) {
            throw new ImportError('The file does not contain a cURL command.');
        }
        return { type: 'request', format: 'curl', request: parseCurl(content), warnings: [] };
    }
    if (kind === 'yaml' || kind === 'yml') {
        let doc: unknown;
        try {
            doc = parseYaml(content, { maxAliasCount: 1000 });
        } catch (error) {
            throw new ImportError(
                `The file is not valid YAML: ${(error as Error).message.split('\n')[0]}`,
            );
        }
        return fromDocument(doc, path, true);
    }
    let doc: unknown;
    try {
        doc = JSON.parse(content);
    } catch (error) {
        const message = (error as Error).message;
        throw new ImportError(`The file is not valid JSON${jsonErrorLocation(content, message)}.`);
    }
    return fromDocument(doc, path, false);
};
