/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    emptyCollection,
    emptyEvent,
    splitType,
    type CollectionDesign,
    type EventDesign,
    type RoutineDesign,
    type RoutineParameter,
    type TriggerDesign,
} from '@httpreq/db-admin';

/*
 * The models the object editors edit, and how each is made: new, or read back from an existing
 * object. They are plain data (no components), so a menu can build one to open an editor with.
 */

/** What the trigger editor tab is opened with: a new trigger, or one read from the server. */
export interface TriggerModel {
    mode: 'create' | 'edit';
    /** The trigger as it is on the server, to drop before creating the edited one. */
    original: TriggerDesign | null;
    design: TriggerDesign;
}

export const newTriggerModel = (seed: {
    database?: string;
    schema?: string;
    table?: string;
}): TriggerModel => ({
    mode: 'create',
    original: null,
    design: {
        name: '',
        database: seed.database,
        schema: seed.schema,
        table: seed.table ?? '',
        timing: 'BEFORE',
        events: ['INSERT'],
        forEachRow: true,
        body: '',
    },
});

export interface EventModel {
    mode: 'create' | 'edit';
    original: EventDesign | null;
    design: EventDesign;
}

export const newEventModel = (seed: { database?: string }): EventModel => ({
    mode: 'create',
    original: null,
    design: { ...emptyEvent(), database: seed.database },
});

/** A parameter as the grid edits it: the type and its length kept apart. */
export interface ParameterRow {
    id: string;
    name: string;
    mode: RoutineParameter['mode'];
    dataType: string;
    /** `255`, `10,2`: what goes in the parentheses after the type. */
    length: string;
    default: string;
}

export interface RoutineModel {
    mode: 'create' | 'edit';
    kind: 'function' | 'procedure';
    original: RoutineDesign | null;
    name: string;
    database?: string;
    schema?: string;
    language: string;
    returns: string;
    returnsLength: string;
    parameters: ParameterRow[];
    body: string;
    deterministic: boolean;
    security: '' | 'DEFINER' | 'INVOKER';
    comment: string;
    owner: string;
}

let counter = 0;
export const rowId = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;

export const newParameter = (): ParameterRow => ({
    id: rowId(),
    name: '',
    mode: 'IN',
    dataType: '',
    length: '',
    default: '',
});

export const newRoutineModel = (
    kind: 'function' | 'procedure',
    seed: { database?: string; schema?: string },
): RoutineModel => ({
    mode: 'create',
    kind,
    original: null,
    name: '',
    database: seed.database,
    schema: seed.schema,
    language: 'plpgsql',
    returns: '',
    returnsLength: '',
    parameters: [],
    body: '',
    deterministic: false,
    security: '',
    comment: '',
    owner: '',
});

/** A model from a routine read off the server, for editing it. */
export const routineModelFrom = (design: RoutineDesign): RoutineModel => {
    const split = (type: string) => {
        const { type: dataType, length } = splitType(type);
        return { dataType, length: length ?? '' };
    };
    const returns = design.returns ? split(design.returns) : { dataType: '', length: '' };
    return {
        mode: 'edit',
        kind: design.kind,
        original: design,
        name: design.name,
        database: design.database,
        schema: design.schema,
        language: design.language ?? 'plpgsql',
        returns: returns.dataType,
        returnsLength: returns.length,
        parameters: design.parameters.map((p) => ({
            id: rowId(),
            name: p.name,
            mode: p.mode,
            ...split(p.type),
            default: p.default ?? '',
        })),
        body: design.body,
        deterministic: !!design.deterministic,
        security: design.security ?? '',
        comment: design.comment ?? '',
        owner: design.owner ?? '',
    };
};

const withLength = (type: string, length: string): string =>
    type && length.trim() ? `${type}(${length.trim()})` : type;

/** The routine design a model describes. */
export const routineDesignOf = (model: RoutineModel): RoutineDesign => ({
    kind: model.kind,
    name: model.name.trim(),
    database: model.database,
    schema: model.schema,
    parameters: model.parameters.map((p) => ({
        name: p.name.trim(),
        mode: p.mode,
        type: withLength(p.dataType.trim(), p.length),
        ...(p.default.trim() ? { default: p.default.trim() } : {}),
    })),
    ...(model.kind === 'function'
        ? { returns: withLength(model.returns.trim(), model.returnsLength) }
        : {}),
    language: model.language,
    body: model.body,
    deterministic: model.deterministic,
    ...(model.security ? { security: model.security } : {}),
    ...(model.comment.trim() ? { comment: model.comment } : {}),
    ...(model.owner.trim() ? { owner: model.owner } : {}),
});

export interface CollectionModel {
    mode: 'create' | 'edit';
    design: CollectionDesign;
    /** Write the validator by hand instead of generating it from the fields. */
    handWritten: boolean;
}

export const newCollectionModel = (seed: {
    database?: string;
    name?: string;
}): CollectionModel => ({
    mode: seed.name ? 'edit' : 'create',
    design: { ...emptyCollection(), database: seed.database, name: seed.name ?? '' },
    handWritten: false,
});
