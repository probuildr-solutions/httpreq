/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use strict';

// What the macOS build can sign and notarize with, read from the environment. One module answers
// that question for everything that needs to know: electron-builder.config.cjs (which signing mode
// to build in), after-sign.cjs (refuse to ship a signed but un-notarized app), the release
// workflow's credential check, and the tests.
//
// A macOS download is only trusted by Gatekeeper without a prompt when it is
//   1. signed with a Developer ID Application certificate (the app, and the DMG's contents),
//   2. signed with a Developer ID Installer certificate (the PKG),
//   3. notarized by Apple and the ticket stapled (the app, and the PKG).
// Anything less shows "Apple could not verify "HttpReq" is free of malware": that is not a bug in
// the package, it is the absence of these three, and no packaging setting can stand in for them.

/** Notarization credentials electron-builder understands, tried in this order. */
const NOTARIZATION_METHODS = [
    {
        id: 'apple-id',
        label: 'Apple ID',
        variables: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    },
    {
        id: 'api-key',
        label: 'App Store Connect API key',
        variables: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    },
    {
        id: 'keychain-profile',
        label: 'notarytool keychain profile',
        variables: ['APPLE_KEYCHAIN_PROFILE'],
    },
];

/** A variable counts as set only when it has a value: an empty secret is how CI says "not set". */
const isSet = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   application: boolean,
 *   installer: boolean,
 *   notarization: string | null,
 *   partialNotarization: { label: string, missing: string[] } | null,
 * }}
 */
function describeMacSigning(env = process.env) {
    const methods = NOTARIZATION_METHODS.map((method) => ({
        ...method,
        present: method.variables.filter((name) => isSet(env, name)),
        missing: method.variables.filter((name) => !isSet(env, name)),
    }));
    const complete = methods.find((method) => method.missing.length === 0);
    const partial = methods.find(
        (method) => method.present.length > 0 && method.missing.length > 0,
    );
    return {
        // CSC_LINK is a certificate for CI; CSC_NAME picks one from the local keychain.
        application: isSet(env, 'CSC_LINK') || isSet(env, 'CSC_NAME'),
        installer: isSet(env, 'CSC_INSTALLER_LINK'),
        notarization: complete ? complete.id : null,
        partialNotarization:
            !complete && partial ? { label: partial.label, missing: partial.missing } : null,
    };
}

/** What stops the macOS packages from being trusted, as sentences. Empty when nothing does. */
function signingProblems(env = process.env) {
    const signing = describeMacSigning(env);
    const problems = [];
    if (!signing.application) {
        problems.push(
            'No Developer ID Application certificate: set MAC_CSC_LINK and MAC_CSC_KEY_PASSWORD (CSC_LINK and CSC_KEY_PASSWORD when building by hand). Without it the app is only ad hoc signed.',
        );
    }
    if (!signing.installer) {
        problems.push(
            'No Developer ID Installer certificate: set MAC_INSTALLER_CSC_LINK and MAC_INSTALLER_CSC_KEY_PASSWORD (CSC_INSTALLER_LINK and CSC_INSTALLER_KEY_PASSWORD when building by hand). Without it the .pkg is unsigned.',
        );
    }
    if (signing.partialNotarization) {
        problems.push(
            `Notarization credentials are incomplete (${signing.partialNotarization.label}): ${signing.partialNotarization.missing.join(', ')} not set.`,
        );
    } else if (!signing.notarization) {
        problems.push(
            'No notarization credentials: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or an App Store Connect API key). Without them nothing is notarized, and macOS shows "Apple could not verify" on first open.',
        );
    }
    return problems;
}

module.exports = { NOTARIZATION_METHODS, describeMacSigning, signingProblems };
