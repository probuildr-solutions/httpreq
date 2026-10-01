/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

'use strict';

// electron-builder `afterSign` hook. electron-builder signs the app and then notarizes it only if
// Apple credentials are in the environment; when they are not it logs a warning and carries on,
// which produced a signed app that macOS still refuses to open without a prompt. This hook turns
// that into a build failure: a Developer ID build must be notarized, or say explicitly that it is
// not meant to be (HTTPREQ_ALLOW_UNNOTARIZED=1, for a local test build).

const { describeMacSigning, signingProblems } = require('./mac-signing.cjs');

/** @param {{ electronPlatformName: string }} context */
async function afterSign(context) {
    if (context.electronPlatformName !== 'darwin') return;
    const signing = describeMacSigning(process.env);
    // An ad hoc build has no Developer ID to notarize with; the package says so in its name.
    if (!signing.application) return;
    if (signing.notarization) return;

    const detail = signingProblems(process.env)
        .filter((problem) => /notarization/i.test(problem))
        .join(' ');
    if (process.env.HTTPREQ_ALLOW_UNNOTARIZED === '1') {
        console.warn(
            `  • HTTPREQ_ALLOW_UNNOTARIZED is set: the app is signed but not notarized. ${detail}`,
        );
        return;
    }
    throw new Error(
        `The app was signed with a Developer ID certificate but cannot be notarized. ${detail} ` +
            'Notarization is what stops macOS from showing "Apple could not verify" when the app is first opened. ' +
            'Set the credentials, or set HTTPREQ_ALLOW_UNNOTARIZED=1 for a build that is only for yourself.',
    );
}

module.exports = { default: afterSign };
