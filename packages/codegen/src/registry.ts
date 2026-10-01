/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    DEFAULT_CODEGEN_OPTIONS,
    PROTOCOLS,
    type CodeGenerator,
    type CodegenOptions,
    type CodegenRequest,
    type CodegenResult,
    type ProtocolId,
} from '@httpreq/shared';
import { UnsupportedCombination } from './errors';

/**
 * The set of available generators. It is a registry, not a switch: a generator is one object
 * implementing {@link CodeGenerator}, added with {@link CodeGeneratorRegistry.register}, and no
 * existing generator or caller changes when one is added (open for extension, closed for
 * modification).
 */
export class CodeGeneratorRegistry {
    private readonly generators = new Map<string, CodeGenerator>();

    register<R extends CodegenRequest>(generator: CodeGenerator<R>): this {
        if (this.generators.has(generator.id)) {
            throw new Error(
                `A code generator with the id “${generator.id}” is already registered.`,
            );
        }
        this.generators.set(generator.id, generator as unknown as CodeGenerator);
        return this;
    }

    get(id: string): CodeGenerator | undefined {
        return this.generators.get(id);
    }

    list(): CodeGenerator[] {
        return [...this.generators.values()];
    }

    /** Generators that can produce code for `protocol`, in registration order. */
    forProtocol(protocol: ProtocolId): CodeGenerator[] {
        return this.list().filter((generator) => generator.protocols.includes(protocol));
    }

    /**
     * Generates code, or explains why it cannot. A generator that does not cover the request's
     * protocol, or that rejects the request with {@link UnsupportedCombination}, yields an
     * `unsupported` result carrying a reason fit to show to the user; it never produces
     * misleading partial code.
     */
    generate(
        request: CodegenRequest,
        generatorId: string,
        options: Partial<CodegenOptions> = {},
    ): CodegenResult {
        const generator = this.generators.get(generatorId);
        if (!generator) {
            return {
                supported: false,
                reason: `There is no code generator named “${generatorId}”.`,
            };
        }
        if (!generator.protocols.includes(request.protocol)) {
            const alternatives = this.forProtocol(request.protocol)
                .map((item) => item.label)
                .join(', ');
            return {
                supported: false,
                reason:
                    `${generator.label} cannot generate code for ${PROTOCOLS[request.protocol].label} requests.` +
                    (alternatives ? ` Available: ${alternatives}.` : ''),
            };
        }
        try {
            return {
                supported: true,
                code: generator.generate(request, { ...DEFAULT_CODEGEN_OPTIONS, ...options }),
            };
        } catch (error) {
            if (error instanceof UnsupportedCombination) {
                return { supported: false, reason: error.message };
            }
            throw error;
        }
    }
}
