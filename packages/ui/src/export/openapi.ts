import type { AuthConfig, HttpRequest, KeyValueItem } from '@httpreq/shared';
import { effectiveVariables, type ExportSource } from './source';

/** OpenAPI 3.1, the current version of the specification. */
export const OPENAPI_VERSION = '3.1.0';

type Json = Record<string, unknown>;

/** Header parameters OpenAPI reserves: they are described by `requestBody`, `responses` and `security`. */
const RESERVED_HEADERS = /^(accept|content-type|authorization)$/i;

const VARIABLE = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const LEADING_VARIABLE = /^\{\{\s*([^{}\s]+)\s*\}\}/;

interface SplitUrl {
  /** The server part: `{base_url}`, `https://api.example.com`, or empty for a relative URL. */
  server: string;
  /** Names of `{{variables}}` in the server part, which become server variables. */
  serverVariables: string[];
  /** The path template, e.g. `/users/{id}`. */
  path: string;
  /** Names of `{{variables}}` in the path, which become path parameters. */
  pathParameters: string[];
}

/**
 * Splits a request URL into an OpenAPI server and path. A leading `{{variable}}` (the usual
 * `{{base_url}}`) becomes a server variable; `{{variables}}` in the path become path parameters.
 */
export const splitUrl = (url: string): SplitUrl => {
  const withoutQuery = url.split('#')[0]!.split('?')[0]!.trim();
  let server = '';
  let rest = withoutQuery;
  const leading = LEADING_VARIABLE.exec(withoutQuery);
  const absolute = /^([a-z][\w+.-]*:\/\/[^/]*)(.*)$/i.exec(withoutQuery);
  if (leading) {
    server = leading[0];
    rest = withoutQuery.slice(leading[0].length);
  } else if (absolute) {
    server = absolute[1]!;
    rest = absolute[2]!;
  }
  const serverVariables = [...server.matchAll(VARIABLE)].map((match) => match[1]!);
  const pathParameters = [...rest.matchAll(VARIABLE)].map((match) => match[1]!);
  const path = `/${rest.replace(/^\/+/, '')}`.replace(VARIABLE, '{$1}');
  return {
    server: server.replace(VARIABLE, '{$1}'),
    serverVariables,
    path,
    pathParameters: [...new Set(pathParameters)],
  };
};

const scopesOf = (scope: string) => scope.split(/\s+/).filter(Boolean);

/** The security scheme for an authorization, and the scopes a requirement on it lists. */
const securityScheme = (
  auth: AuthConfig,
): { base: string; scheme: Json; scopes: string[] } | null => {
  switch (auth.type) {
    case 'none':
    case 'inherit':
      return null;
    case 'bearer':
      return { base: 'bearerAuth', scheme: { type: 'http', scheme: 'bearer' }, scopes: [] };
    case 'jwt':
      return auth.addTo === 'query'
        ? {
            base: 'jwtAuth',
            scheme: { type: 'apiKey', in: 'query', name: auth.queryParamKey || 'token' },
            scopes: [],
          }
        : {
            base: 'jwtAuth',
            scheme: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            scopes: [],
          };
    case 'basic':
      return { base: 'basicAuth', scheme: { type: 'http', scheme: 'basic' }, scopes: [] };
    case 'digest':
      return { base: 'digestAuth', scheme: { type: 'http', scheme: 'digest' }, scopes: [] };
    case 'api-key':
      return {
        base: 'apiKeyAuth',
        scheme: { type: 'apiKey', in: auth.location, name: auth.key || 'X-API-Key' },
        scopes: [],
      };
    case 'oauth2': {
      const scopes = scopesOf(auth.scope);
      const scopeMap = Object.fromEntries(scopes.map((scope) => [scope, '']));
      const flows: Json =
        auth.grantType === 'client_credentials'
          ? { clientCredentials: { tokenUrl: auth.tokenUrl, scopes: scopeMap } }
          : auth.grantType === 'password'
            ? { password: { tokenUrl: auth.tokenUrl, scopes: scopeMap } }
            : {
                authorizationCode: {
                  authorizationUrl: auth.authUrl,
                  tokenUrl: auth.tokenUrl,
                  scopes: scopeMap,
                },
              };
      return { base: 'oauth2Auth', scheme: { type: 'oauth2', flows }, scopes };
    }
  }
};

const stringSchema = (example: string | undefined): Json => ({
  type: 'string',
  ...(example ? { example } : {}),
});

/** A string parameter, its example on the parameter itself, where every importer looks for it. */
const parameterSchema = (example: string | undefined): Json => ({
  schema: { type: 'string' },
  ...(example ? { example } : {}),
});

const schemaFor = (value: unknown): Json => {
  if (Array.isArray(value)) return { type: 'array' };
  if (value === null) return { type: 'null' };
  switch (typeof value) {
    case 'object':
      return { type: 'object' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return { type: 'string' };
  }
};

const formSchema = (items: KeyValueItem[], fileKeys: ReadonlySet<string> = new Set()) => ({
  type: 'object',
  properties: Object.fromEntries(
    items
      .filter((item) => item.key)
      .map((item) => [
        item.key,
        fileKeys.has(item.id)
          ? { type: 'string', format: 'binary' }
          : {
              ...stringSchema(item.value || undefined),
              ...(item.description ? { description: item.description } : {}),
            },
      ]),
  ),
});

const requestBody = (request: HttpRequest): Json | undefined => {
  const { body } = request;
  switch (body.mode) {
    case 'none':
      return undefined;
    case 'json': {
      let example: unknown = body.json;
      try {
        example = JSON.parse(body.json);
      } catch {
        // Bodies holding {{variables}} are not valid JSON; they are kept as written.
      }
      return {
        content: {
          'application/json': {
            schema: typeof example === 'string' ? {} : schemaFor(example),
            ...(body.json.trim() ? { example } : {}),
          },
        },
      };
    }
    case 'text':
      return {
        content: {
          [body.textContentType]: {
            schema: { type: 'string' },
            ...(body.text ? { example: body.text } : {}),
          },
        },
      };
    case 'form-urlencoded':
      return {
        content: {
          'application/x-www-form-urlencoded': { schema: formSchema(body.formUrlEncoded) },
        },
      };
    case 'multipart':
      return {
        content: {
          'multipart/form-data': {
            schema: formSchema(
              body.multipart,
              new Set(body.multipart.filter((field) => field.kind === 'file').map((f) => f.id)),
            ),
          },
        },
      };
    case 'binary':
      return {
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      };
  }
};

const operationIdOf = (name: string) =>
  name
    .trim()
    .replace(/[^\w]+(\w)?/g, (_, next: string | undefined) => (next ? next.toUpperCase() : ''))
    .replace(/^\w/, (first) => first.toLowerCase()) || 'operation';

/**
 * An OpenAPI 3.1 document describing the export's requests. Folders become tags; the most common
 * base URL becomes the document's server (others are set per path); `{{variables}}` in a path
 * become path parameters, with the active environment's values as examples; authorization
 * becomes security schemes, following inheritance exactly as a request is sent.
 */
export const toOpenApi = (source: ExportSource) => {
  const warnings = new Set<string>(source.skipped);
  const variables = effectiveVariables(source);
  const exampleOf = (name: string) => {
    const variable = variables.get(name);
    return variable && !variable.secret ? variable.value : undefined;
  };

  /* Security schemes, shared by every operation with the same configuration. */
  const schemes: Record<string, Json> = {};
  const schemeNames = new Map<string, string>();
  const requirementFor = (auth: AuthConfig): Json[] => {
    const found = securityScheme(auth);
    if (!found) return [];
    const signature = JSON.stringify(found.scheme);
    let name = schemeNames.get(signature);
    if (!name) {
      name = found.base;
      for (let index = 2; schemes[name]; index += 1) name = `${found.base}${index}`;
      schemes[name] = found.scheme;
      schemeNames.set(signature, name);
    }
    return [{ [name]: found.scopes }];
  };

  const folders = new Map(source.folders.map((folder) => [folder.id, folder]));
  /** Authorization as sent: the nearest non-inheriting ancestor, up to the export's root. */
  const effectiveAuth = (request: HttpRequest): AuthConfig => {
    if (request.auth.type !== 'inherit') return request.auth;
    let parentId = request.parentId;
    while (parentId && parentId !== source.rootId) {
      const folder = folders.get(parentId);
      if (!folder) break;
      if (folder.auth.type !== 'inherit') return folder.auth;
      parentId = folder.parentId;
    }
    return source.auth.type === 'inherit' ? { type: 'none' } : source.auth;
  };
  /** Folder path of a request, as its tag: "Users / Admin". */
  const tagOf = (request: HttpRequest) => {
    const names: string[] = [];
    let parentId = request.parentId;
    while (parentId && parentId !== source.rootId) {
      const folder = folders.get(parentId);
      if (!folder) break;
      names.unshift(folder.name);
      parentId = folder.parentId;
    }
    return names.length ? names.join(' / ') : null;
  };

  /* Servers: the most common base becomes the document's; any other is set on its paths. */
  const split = new Map(source.requests.map((request) => [request.id, splitUrl(request.url)]));
  const serverCounts = new Map<string, number>();
  for (const { server } of split.values()) {
    if (server) serverCounts.set(server, (serverCounts.get(server) ?? 0) + 1);
  }
  const primary = [...serverCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const serverObject = (url: string) => {
    const names = [...url.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
    return {
      url,
      ...(names.length
        ? {
            variables: Object.fromEntries(
              names.map((name) => [
                name,
                {
                  default: exampleOf(name) ?? '',
                  ...(variables.get(name)?.secret ? { description: 'Secret value' } : {}),
                },
              ]),
            ),
          }
        : {}),
    };
  };

  const rootSecurity = requirementFor(
    source.auth.type === 'inherit' ? { type: 'none' } : source.auth,
  );
  const rootSignature = JSON.stringify(rootSecurity);

  const paths: Record<string, Json> = {};
  const tags = new Map<string, string>();
  const operationIds = new Set<string>();
  let droppedHeaders = false;

  for (const request of source.requests) {
    const { server, path, pathParameters } = split.get(request.id)!;
    const method = request.method.toLowerCase();
    const item = (paths[path] ??= {});
    if (item[method]) {
      warnings.add(
        `More than one request is ${request.method} ${path}; OpenAPI allows one operation per method and path, so “${request.name}” was left out.`,
      );
      continue;
    }

    let operationId = operationIdOf(request.name);
    for (let index = 2; operationIds.has(operationId); index += 1) {
      operationId = `${operationIdOf(request.name)}${index}`;
    }
    operationIds.add(operationId);

    const parameters: Json[] = [
      ...pathParameters.map((name) => ({
        name,
        in: 'path',
        required: true,
        ...parameterSchema(exampleOf(name)),
      })),
      ...request.params
        .filter((param) => param.key)
        .map((param) => ({
          name: param.key,
          in: 'query',
          // What the request sends is required; switched-off parameters stay optional.
          ...(param.enabled ? { required: true } : {}),
          ...(param.description ? { description: param.description } : {}),
          ...parameterSchema(param.value || undefined),
        })),
      ...request.headers
        .filter((header) => {
          if (!header.key) return false;
          if (RESERVED_HEADERS.test(header.key)) {
            droppedHeaders = true;
            return false;
          }
          return true;
        })
        .map((header) => ({
          name: header.key,
          in: 'header',
          ...(header.enabled ? { required: true } : {}),
          ...(header.description ? { description: header.description } : {}),
          ...parameterSchema(header.value || undefined),
        })),
    ];

    const tag = tagOf(request);
    if (tag && !tags.has(tag)) {
      const folder = request.parentId ? folders.get(request.parentId) : undefined;
      tags.set(tag, folder?.description ?? '');
    }

    const security = requirementFor(effectiveAuth(request));
    const body = requestBody(request);
    item[method] = {
      operationId,
      summary: request.name,
      ...(request.description ? { description: request.description } : {}),
      ...(tag ? { tags: [tag] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: body } : {}),
      ...(JSON.stringify(security) === rootSignature ? {} : { security }),
      ...(server && server !== primary ? { servers: [serverObject(server)] } : {}),
      responses: { default: { description: 'Response' } },
    };
  }

  if (droppedHeaders) {
    warnings.add(
      'Accept, Content-Type and Authorization headers are not header parameters in OpenAPI; they are described by the request body and security instead.',
    );
  }
  if (source.requests.length === 0) warnings.add('There are no HTTP requests to describe.');

  const environment = source.environment;
  const document: Json = {
    openapi: OPENAPI_VERSION,
    info: {
      title: source.name,
      ...(source.description ? { description: source.description } : {}),
      version: '1.0.0',
    },
    ...(primary ? { servers: [serverObject(primary)] } : {}),
    ...(tags.size
      ? {
          tags: [...tags].map(([name, description]) => ({
            name,
            ...(description ? { description } : {}),
          })),
        }
      : {}),
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
    ...(rootSecurity.length ? { security: rootSecurity } : {}),
    // Not part of OpenAPI itself: the variables the requests were written against, so nothing
    // they reference is lost. Secret values are never included.
    ...(environment && environment.variables.length
      ? {
          'x-httpreq-environment': {
            name: environment.name,
            variables: environment.variables.map((variable) => ({
              key: variable.key,
              value: variable.value,
              ...(variable.secret ? { secret: true } : {}),
              ...(variable.enabled ? {} : { enabled: false }),
            })),
          },
        }
      : {}),
  };
  return { document, warnings: [...warnings] };
};
