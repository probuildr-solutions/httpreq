/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface MacSigning {
    describeMacSigning(env: Record<string, string | undefined>): {
        application: boolean;
        installer: boolean;
        notarization: string | null;
        partialNotarization: { label: string; missing: string[] } | null;
    };
    signingProblems(env: Record<string, string | undefined>): string[];
}
const signing = require('../scripts/mac-signing.cjs') as MacSigning;
const afterSign = (
    require('../scripts/after-sign.cjs') as { default: (c: object) => Promise<void> }
).default;

const CERTIFICATES = {
    CSC_LINK: 'base64-application-cert',
    CSC_INSTALLER_LINK: 'base64-installer-cert',
};
const APPLE_ID_LOGIN = {
    APPLE_ID: 'dev@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh',
    APPLE_TEAM_ID: 'TEAM123456',
};

describe('what the macOS build can sign with', () => {
    it('is untrusted without any credentials, and says what to add', () => {
        const problems = signing.signingProblems({});
        expect(problems).toHaveLength(3);
        expect(problems.join(' ')).toMatch(/Application certificate/);
        expect(problems.join(' ')).toMatch(/Installer certificate/);
        expect(problems.join(' ')).toMatch(/notarization credentials/i);
    });

    it('is trusted with both certificates and any complete notarization login', () => {
        for (const login of [
            APPLE_ID_LOGIN,
            { APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer' },
            { APPLE_KEYCHAIN_PROFILE: 'profile' },
        ]) {
            expect(signing.signingProblems({ ...CERTIFICATES, ...login })).toEqual([]);
        }
        expect(
            signing.describeMacSigning({ ...CERTIFICATES, ...APPLE_ID_LOGIN }).notarization,
        ).toBe('apple-id');
    });

    it('treats an empty value as not set, as CI does for a missing secret', () => {
        const env = { CSC_LINK: '', CSC_NAME: '  ', CSC_INSTALLER_LINK: '', APPLE_ID: '' };
        expect(signing.describeMacSigning(env)).toMatchObject({
            application: false,
            installer: false,
            notarization: null,
        });
    });

    it('accepts a keychain certificate name for the application', () => {
        expect(
            signing.describeMacSigning({ CSC_NAME: 'Developer ID Application: Ada (TEAM)' })
                .application,
        ).toBe(true);
    });

    it('reports an incomplete notarization login by what is missing', () => {
        const env = { ...CERTIFICATES, APPLE_ID: 'dev@example.com' };
        expect(signing.describeMacSigning(env).partialNotarization).toEqual({
            label: 'Apple ID',
            missing: ['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
        });
        expect(signing.signingProblems(env).join(' ')).toMatch(
            /incomplete.*APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/,
        );
    });
});

describe('the afterSign guard', () => {
    const original = { ...process.env };
    afterEach(() => {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, original);
    });
    const setEnv = (env: Record<string, string>) => {
        for (const key of [
            'CSC_LINK',
            'CSC_NAME',
            ...Object.keys(APPLE_ID_LOGIN),
            'HTTPREQ_ALLOW_UNNOTARIZED',
        ])
            delete process.env[key];
        Object.assign(process.env, env);
    };

    it('ignores other platforms and ad hoc builds', async () => {
        setEnv({});
        await expect(afterSign({ electronPlatformName: 'win32' })).resolves.toBeUndefined();
        await expect(afterSign({ electronPlatformName: 'darwin' })).resolves.toBeUndefined();
    });

    it('lets a notarizable Developer ID build through', async () => {
        setEnv({ CSC_LINK: 'cert', ...APPLE_ID_LOGIN });
        await expect(afterSign({ electronPlatformName: 'darwin' })).resolves.toBeUndefined();
    });

    it('fails a Developer ID build that could not be notarized, unless allowed', async () => {
        setEnv({ CSC_LINK: 'cert' });
        await expect(afterSign({ electronPlatformName: 'darwin' })).rejects.toThrow(
            /cannot be notarized/,
        );
        setEnv({ CSC_LINK: 'cert', HTTPREQ_ALLOW_UNNOTARIZED: '1' });
        await expect(afterSign({ electronPlatformName: 'darwin' })).resolves.toBeUndefined();
    });
});

interface Config {
    mac: {
        target: { target: string; arch: string[] }[];
        identity?: string;
        notarize?: boolean;
        hardenedRuntime: boolean;
        forceCodeSigning: boolean;
        entitlements: string;
        entitlementsInherit: string;
    };
    dmg: { sign: boolean };
    pkg: Record<string, unknown>;
    electronFuses: Record<string, boolean>;
    afterSign: unknown;
    publish: unknown[];
}

/** The configuration as electron-builder would load it under the given environment. */
const loadConfig = (env: Record<string, string>): Config => {
    const path = require.resolve('../electron-builder.config.cjs');
    const saved = { ...process.env };
    for (const key of ['CSC_LINK', 'CSC_NAME', 'HTTPREQ_REQUIRE_SIGNING']) delete process.env[key];
    Object.assign(process.env, env);
    delete require.cache[path];
    try {
        return require(path) as Config;
    } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, saved);
        delete require.cache[path];
    }
};

describe('the electron-builder configuration', () => {
    it('builds a dmg, a pkg and an updater zip for Intel and Apple silicon', () => {
        const { target } = loadConfig({}).mac;
        for (const kind of ['dmg', 'pkg', 'zip']) {
            expect(target.find((entry) => entry.target === kind)?.arch, kind).toEqual([
                'x64',
                'arm64',
            ]);
        }
    });

    it('signs ad hoc, without the hardened runtime or notarization, when there is no Developer ID', () => {
        const { mac } = loadConfig({});
        expect(mac).toMatchObject({
            identity: '-',
            notarize: false,
            hardenedRuntime: false,
            forceCodeSigning: false,
        });
    });

    it('uses the Developer ID, the hardened runtime and notarization when there is one', () => {
        const { mac } = loadConfig({ CSC_LINK: 'cert' });
        expect(mac.identity).toBeUndefined();
        expect(mac.notarize).toBeUndefined();
        expect(mac.hardenedRuntime).toBe(true);
    });

    it('refuses to build unsigned when a release requires signing', () => {
        expect(
            loadConfig({ CSC_LINK: 'cert', HTTPREQ_REQUIRE_SIGNING: '1' }).mac.forceCodeSigning,
        ).toBe(true);
    });

    it('re-signs the Electron binary after the fuses change it, which Apple silicon requires', () => {
        const { electronFuses } = loadConfig({});
        expect(electronFuses.resetAdHocDarwinSignature).toBe(true);
        // The fuses themselves are unchanged: tamper resistance is not traded for the signature.
        expect(electronFuses).toMatchObject({
            runAsNode: false,
            enableEmbeddedAsarIntegrityValidation: true,
            onlyLoadAppFromAsar: true,
        });
    });

    it('does not sign the disk image, whose checksum is recorded for the updater metadata', () => {
        expect(loadConfig({}).dmg.sign).toBe(false);
    });

    it('installs the pkg into /Applications for the whole Mac and upgrades in place', () => {
        expect(loadConfig({}).pkg).toMatchObject({
            installLocation: '/Applications',
            overwriteAction: 'upgrade',
            isRelocatable: false,
            allowAnywhere: false,
            allowCurrentUserHome: false,
        });
    });

    it('guards notarization with the afterSign hook', () => {
        expect(typeof loadConfig({}).afterSign).toBe('function');
    });

    it('is accepted by electron-builder, so a typo or an option the version dropped fails here', async () => {
        const { validateConfiguration } = require('app-builder-lib/out/util/config/config') as {
            validateConfiguration(config: unknown, debug: unknown): Promise<void>;
        };
        const debug = { isEnabled: false, add: () => undefined };
        const environments: Record<string, string>[] = [{}, { CSC_LINK: 'cert' }];
        for (const env of environments) {
            await expect(validateConfiguration(loadConfig(env), debug)).resolves.toBeUndefined();
        }
    });
});
