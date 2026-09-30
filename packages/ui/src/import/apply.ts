import { deserializeAuth } from '@httpreq/api-client';
import {
  createId,
  WORKSPACE_VERSION,
  type Environment,
  type EnvironmentVariable,
  type Workspace,
} from '@httpreq/shared';
import { migrateWorkspace } from '@httpreq/workspace';
import { ImportError } from './errors';
import type { EnvironmentConflict, ImportedEnvironment, ImportPlan } from './types';

export interface AppliedImport {
  workspace: Workspace;
  /** The collection or request to reveal, when the plan added one. */
  rootId: string | null;
  kind: 'collection' | 'request' | 'environment';
  /** One line for the import summary, e.g. “Collection “Pets” with 12 requests”. */
  message: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const uniqueName = (name: string, taken: string[]) => {
  for (let index = 2; ; index++) {
    const candidate = `${name} (${index})`;
    if (!taken.some((existing) => sameName(existing, candidate))) return candidate;
  }
};

const toVariables = (imported: ImportedEnvironment): EnvironmentVariable[] =>
  imported.variables.map((variable) => ({ id: createId(), ...variable }));

/**
 * Adds an imported environment by name. A new name creates the environment; an existing one is
 * merged (new keys added, existing keys updated), replaced, or kept alongside a numbered copy,
 * as the user chose. Either way the environment is in the picker afterwards, and it becomes the
 * active one when none was active.
 */
export const applyEnvironment = (
  workspace: Workspace,
  imported: ImportedEnvironment,
  conflict: EnvironmentConflict,
): { workspace: Workspace; environment: Environment; message: string } => {
  const existing = workspace.environments.find((item) => sameName(item.name, imported.name));
  let environment: Environment;
  let environments: Environment[];
  let message: string;

  if (!existing || conflict === 'copy') {
    const name = existing
      ? uniqueName(
          imported.name.trim(),
          workspace.environments.map((item) => item.name),
        )
      : imported.name.trim();
    environment = { id: createId(), name, variables: toVariables(imported) };
    environments = [...workspace.environments, environment];
    message = `Created environment “${name}” with ${plural(environment.variables.length, 'variable')}`;
  } else if (conflict === 'replace') {
    environment = { ...existing, variables: toVariables(imported) };
    environments = workspace.environments.map((item) =>
      item.id === existing.id ? environment : item,
    );
    message = `Replaced the variables of “${existing.name}” (${plural(environment.variables.length, 'variable')})`;
  } else {
    let added = 0;
    let updated = 0;
    const variables = [...existing.variables];
    for (const variable of imported.variables) {
      const index = variables.findIndex((item) => item.key === variable.key);
      if (index < 0) {
        variables.push({ id: createId(), ...variable });
        added++;
      } else {
        const current = variables[index]!;
        // An empty imported value (a placeholder such as `bearer_token`) never wipes a real one.
        const value = variable.value === '' ? current.value : variable.value;
        if (value !== current.value || variable.enabled !== current.enabled) updated++;
        variables[index] = {
          ...current,
          value,
          enabled: variable.enabled,
          secret: current.secret || variable.secret,
        };
      }
    }
    environment = { ...existing, variables };
    environments = workspace.environments.map((item) =>
      item.id === existing.id ? environment : item,
    );
    message = `Merged into environment “${existing.name}”: ${added} added, ${updated} updated`;
  }

  return {
    environment,
    message,
    workspace: {
      ...workspace,
      environments,
      activeEnvironmentId: workspace.activeEnvironmentId,
      updatedAt: new Date().toISOString(),
    },
  };
};

/** Runs a plan's tree through the same validation as stored data, so nothing malformed lands. */
const normalizeTree = (plan: Extract<ImportPlan, { type: 'collection' | 'request' }>) => {
  const parsed = migrateWorkspace(
    {
      version: WORKSPACE_VERSION,
      id: 'import',
      name: 'Import',
      collections: plan.type === 'collection' ? [plan.collection] : [],
      folders: plan.type === 'collection' ? plan.folders : [],
      requests: plan.type === 'collection' ? plan.requests : [plan.request],
      environments: [],
      activeEnvironmentId: null,
      openRequestIds: [],
      updatedAt: new Date().toISOString(),
    },
    deserializeAuth,
  );
  if (!parsed) throw new ImportError('The imported data could not be validated.');
  return parsed;
};

/** Merges one plan into the workspace. */
export const applyImportPlan = (
  workspace: Workspace,
  plan: ImportPlan,
  conflict: EnvironmentConflict,
): AppliedImport => {
  if (plan.type === 'environment') {
    const result = applyEnvironment(workspace, plan.environment, conflict);
    return {
      workspace: result.workspace,
      rootId: null,
      kind: 'environment',
      message: result.message,
    };
  }

  const tree = normalizeTree(plan);
  let next: Workspace = {
    ...workspace,
    collections: [...workspace.collections, ...tree.collections],
    folders: [...workspace.folders, ...tree.folders],
    requests: [...workspace.requests, ...tree.requests],
    updatedAt: new Date().toISOString(),
  };

  if (plan.type === 'request') {
    const request = tree.requests[0]!;
    return {
      workspace: next,
      rootId: request.id,
      kind: 'request',
      message: `Request “${request.name}”`,
    };
  }

  const collection = tree.collections[0]!;
  let message = `Collection “${collection.name}” with ${plural(tree.requests.length, 'request')}`;
  if (tree.folders.length) message += ` in ${plural(tree.folders.length, 'folder')}`;
  if (plan.environment) {
    const result = applyEnvironment(next, plan.environment, conflict);
    next = result.workspace;
    message += `; ${result.message.charAt(0).toLowerCase()}${result.message.slice(1)}`;
  }
  return { workspace: next, rootId: collection.id, kind: 'collection', message };
};
