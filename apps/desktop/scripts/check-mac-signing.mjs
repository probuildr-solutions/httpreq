/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// Run by the release workflow before the macOS packages are built:
//
//   node apps/desktop/scripts/check-mac-signing.mjs
//
// A macOS package that is not signed with Developer ID certificates and notarized is shown
// "Apple could not verify ..." by Gatekeeper, whatever the package format. That cannot be fixed
// in the build, only by providing the credentials, so a release without them fails here, before
// anything is built, instead of publishing installers users cannot open without a workaround.
//
// A run that is not a release only reports what is missing (the packages are still built, ad hoc
// signed, for testing). A release can be allowed to go out unsigned on purpose, once, with the
// manual run's `allow_unsigned_mac` input or, for every release, the repository variable
// ALLOW_UNSIGNED_MAC_RELEASE=true.
//
// Environment: IS_RELEASE ("true" for a release), ALLOW_UNSIGNED_MAC ("true" to permit an
// unsigned release), and the signing variables listed in mac-signing.cjs.
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { describeMacSigning, signingProblems } = createRequire(import.meta.url)('./mac-signing.cjs');

const release = process.env.IS_RELEASE === 'true';
const allowed = process.env.ALLOW_UNSIGNED_MAC === 'true';
const signing = describeMacSigning(process.env);
const problems = signingProblems(process.env);
const trusted = problems.length === 0;

const status = trusted
    ? 'Developer ID signed and notarized: macOS will open it without a prompt.'
    : `Not trusted by Gatekeeper: ${problems.length} thing(s) missing.`;
console.log(status);
for (const problem of problems) console.log(`  - ${problem}`);

if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### macOS signing\n\n` +
            `| Credential | Status |\n| --- | --- |\n` +
            `| Developer ID Application | ${signing.application ? 'set' : '**missing**'} |\n` +
            `| Developer ID Installer (.pkg) | ${signing.installer ? 'set' : '**missing**'} |\n` +
            `| Notarization | ${signing.notarization ?? '**missing**'} |\n\n` +
            (trusted ? '' : 'See docs/distribution.md for how to set them up.\n'),
    );
}

if (trusted) {
    // From here on the build and its checks must produce Developer ID signed packages, or fail.
    if (release && !allowed && process.env.GITHUB_ENV) {
        appendFileSync(process.env.GITHUB_ENV, 'HTTPREQ_REQUIRE_SIGNING=1\n');
    }
    process.exit(0);
}

if (release && !allowed) {
    console.error(
        `::error title=macOS packages would not open without a Gatekeeper warning::${problems.join(' ')} ` +
            'Add the secrets, or allow an unsigned release with the allow_unsigned_mac input or the ALLOW_UNSIGNED_MAC_RELEASE repository variable.',
    );
    process.exit(1);
}

console.log(
    `::warning title=macOS packages are not notarized::${release ? 'Releasing unsigned on request. ' : 'Not a release, so this is only a warning. '}${problems.join(' ')}`,
);
