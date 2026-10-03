/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { DbError } from '@httpreq/db-core';

/** Tokens one owner (a window) may hold at a time. */
const MAX_PER_OWNER = 64;

interface Grant {
    path: string;
    owner: number;
}

/**
 * Turns "the user picked this file" into an opaque, unguessable token. The renderer never supplies
 * a path: it receives a token from a native dialog (or a confirmed drop) and presents it back, so
 * a compromised page cannot ask the privileged side to open `~/.ssh/id_rsa`.
 *
 * Tokens are bound to the window that was granted them, are released when it closes, and are
 * single-purpose references to one path, not capabilities to anything else.
 */
export class FileHandleRegistry {
    private readonly grants = new Map<string, Grant>();

    grant(path: string, owner: number): string {
        let held = 0;
        for (const grant of this.grants.values()) if (grant.owner === owner) held++;
        if (held >= MAX_PER_OWNER) {
            throw new DbError('LIMIT_EXCEEDED', 'Too many files are open in this window.');
        }
        const token = randomBytes(16).toString('hex');
        this.grants.set(token, { path, owner });
        return token;
    }

    /** The path a token stands for, if it was granted to this owner. */
    resolve(token: unknown, owner: number): string {
        const grant = typeof token === 'string' ? this.grants.get(token) : undefined;
        if (!grant || grant.owner !== owner) {
            throw new DbError('PERMISSION_DENIED', 'That file was not chosen in this window.');
        }
        return grant.path;
    }

    revoke(token: string): void {
        this.grants.delete(token);
    }

    revokeOwner(owner: number): void {
        for (const [token, grant] of this.grants)
            if (grant.owner === owner) this.grants.delete(token);
    }

    get size(): number {
        return this.grants.size;
    }
}
