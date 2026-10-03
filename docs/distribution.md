# Distributing the macOS app

HttpReq ships for macOS as a native installer (`.pkg`) and a `.zip` that the auto-updater downloads,
each for Intel (`x64`) and Apple silicon (`arm64`). There is no disk image. This page explains what
makes those open without a warning, what the build does about it, and how to set it up.

## What the "Not Opened" dialog means

> "HttpReq" Not Opened — Apple could not verify "HttpReq" is free of malware that may harm your Mac
> or compromise your privacy.

This is Gatekeeper refusing an app that has no **Developer ID signature and Apple notarization
ticket**. It is not a corrupt download and it is not specific to one format: a `.pkg` and
a `.zip` of the same unsigned app both show it. Switching from one format to another cannot remove
it; only the credentials below can. The earlier, different message, _"HttpReq is damaged and can't
be opened"_, was a real packaging fault (see [What was wrong](#what-was-wrong)), and is fixed.

| What the user sees                         | Cause                                                                 | Fixed by                                     |
| ------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------- |
| "… is damaged and can't be opened"         | The app's signature does not verify (arm64 is strict about this)      | The build changes below; already fixed       |
| "Apple could not verify … free of malware" | Signed ad hoc or not at all; not notarized                            | A Developer ID certificate and notarization  |
| ".pkg … can't be opened … unidentified"    | The installer is not signed with a Developer ID Installer certificate | The installer certificate, and notarizing it |
| Opens with no prompt                       | Developer ID signed, notarized, ticket stapled                        | Nothing; this is the goal                    |

**Without an Apple Developer Program membership (US$99 a year) there is no way to make macOS trust a
download.** An ad hoc signed build is the most any project without one can ship, and it needs
**System Settings › Privacy & Security › Open Anyway** on first launch (macOS 15 and later removed
the Control-click shortcut for apps that are not notarized).

## What was wrong

Reviewing the packaging end to end found three faults, all fixed:

1. **No Developer ID signature or notarization.** The build had the right switches, but when the
   secrets were absent it silently produced ad hoc signed packages, and when only some were present
   it produced a signed app that was never notarized (electron-builder only logs a warning). Nothing
   stopped such a build from being published as a release. Now a release **fails** before building
   (`scripts/check-mac-signing.mjs`), and a Developer ID build that cannot be notarized fails in the
   build itself (`scripts/after-sign.cjs`).
2. **The Electron binary's signature was invalidated after the fact.** The security fuses are
   flipped on the Electron Framework binary, which breaks the signature the prebuilt arm64 binaries
   ship with; Apple silicon refuses code whose signature does not verify. The configuration never
   asked `@electron/fuses` to re-sign it. `electronFuses.resetAdHocDarwinSignature` is now on, so the
   bundle stays valid even if the signing step that follows is skipped.
3. **The verification script never checked a signed build.** It decided whether to check Gatekeeper
   and notarization from the signing variables, which that step of the workflow does not have, so a
   Developer ID build was only ever checked as if it were ad hoc. It now reads the signature from the
   packages themselves and checks the app inside every zip and pkg, and the pkg's own signature
   and ticket.

## Why the disk image was dropped, and what that does and does not fix

The PKG is now the first-install format. Be clear about what that changes:

- **It does not by itself make macOS trust the app.** A `.pkg` needs the same three things as any
  other format (Developer ID Application certificate, Developer ID **Installer** certificate,
  notarization with the ticket stapled to the installer). Without the Installer certificate the PKG
  is unsigned and Gatekeeper refuses it.
- **What it does remove** is the disk image as a variable: the image is built by `hdiutil` on the CI
  runner (an Apple silicon machine producing the Intel image too), is deliberately left unsigned
  because stapling would change its bytes after their checksum is recorded, and its app is copied by
  the user from a quarantined volume. The installer is built by `productbuild`, signed, notarized and
  stapled as one file, and its `hostArchitectures` makes an Intel/Apple silicon mix-up an installer
  error instead of a broken app.
- **The root cause of the Intel disk image failure was not reproduced.** Nothing in this
  repository can be built or run off macOS, and the symptom was not recorded. What the packaging
  review found that can break one architecture only is covered by the checks below, which fail the
  build and name the file: `verify-packages.mjs` now checks that every Mach-O file in the app
  (helpers, frameworks, `.node` modules), not only the main executable, contains the architecture the
  package is for, in addition to the signature, hardened runtime, entitlements, Gatekeeper and
  stapling checks that already ran. If the Intel package still misbehaves, the first failing check
  in the macOS job names the cause; send that log.

## Kernel and system extensions (the Electron Builder tutorial)

The [macOS kernel extensions tutorial](https://www.electron.build/docs/tutorials/macos-kernel-extensions)
does not apply. HttpReq contains no kernel extension, system extension, DriverKit driver or
network extension, so it needs none of what that tutorial sets up: no
`com.apple.developer.system-extension.install` entitlement, no provisioning profile, no
`extraFiles` for a `.kext`/`.systemextension`, and no installer script that loads one. Adding them
would make Apple reject the notarization or the app's own signature. The configuration is the
ordinary one: Developer ID signing, hardened runtime, the three JIT/native-module entitlements below,
notarization and stapling. If a kernel or system extension is ever added, that tutorial is where to
start, and the installer would need the extension's own signing.

## The formats

| File                               | For                                                           |
| ---------------------------------- | ------------------------------------------------------------- |
| `HttpReq-<version>-mac-<arch>.pkg` | A first install with the native installer; managed fleets     |
| `HttpReq-<version>-mac-<arch>.zip` | The auto-updater only (it is not offered for a first install) |

Pick the installer for the Mac: `arm64` for Apple silicon, `x64` for Intel. Each declares its host
architecture in the installer's distribution, so the wrong one is refused with "not compatible with
this computer" rather than installing an app that cannot start.

The PKG and the ZIP come from the same signed app in the same run, so they are the same build. The PKG
installs into `/Applications` for the whole Mac, upgrades an older copy in place (it does not leave
the old files behind) and refuses to install over a newer version. To install it without the UI:

```bash
sudo installer -pkg HttpReq-<version>-mac-arm64.pkg -target /
```

**Universal binaries.** The build produces one app per architecture instead of a universal one on
purpose: the auto-updater picks its download by the architecture in the file name, a universal app
doubles every download, and nothing in HttpReq needs a single binary that runs on both. If that ever
changes, add `universal` to the `arch` lists in `electron-builder.config.cjs`, add `x64ArchFiles` for
the native modules (`**/*.node`), and change the expected names in `verify-packages.mjs`; it is a
three-line change, but it should be built and checked on a Mac before it is released.

## Setting up trusted releases

You need an Apple Developer Program account, and then three things.

**1. A Developer ID Application certificate** signs the app (the PKG and the ZIP both contain it).
In the Apple Developer portal create a _Developer ID Application_ certificate, install it in Keychain
Access, then export it with its private key as a `.p12`:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy   # paste it as the secret
```

| Secret                 | Value                             |
| ---------------------- | --------------------------------- |
| `MAC_CSC_LINK`         | The base64 `.p12`                 |
| `MAC_CSC_KEY_PASSWORD` | The password you exported it with |

**2. A Developer ID Installer certificate** signs the `.pkg`. It is a separate certificate type
(_Developer ID Installer_), exported the same way:

| Secret                           | Value                             |
| -------------------------------- | --------------------------------- |
| `MAC_INSTALLER_CSC_LINK`         | The base64 `.p12`                 |
| `MAC_INSTALLER_CSC_KEY_PASSWORD` | The password you exported it with |

**3. Notarization credentials** let Apple scan the app and the installer. Either an
[app-specific password](https://support.apple.com/102654) for the Apple ID that owns the team:

| Secret                        | Value                                     |
| ----------------------------- | ----------------------------------------- |
| `APPLE_ID`                    | The Apple ID's email                      |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password (not the login) |
| `APPLE_TEAM_ID`               | The 10-character team ID                  |

or an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), which
`electron-builder` also accepts and which suits an organisation better.

With all of them set the workflow signs the app with the hardened runtime, notarizes it, staples the
ticket, builds the PKG from it, signs the PKG with the Installer certificate, notarizes and staples it, and then `verify-packages.mjs`
asks macOS itself whether it would accept each one.

### What the workflow does

The macOS job first runs `check-mac-signing.mjs`, which reads which credentials exist:

- **A release** (a version bump or a `release`-labelled merge) with anything missing **fails here**,
  before anything is built, naming what to add. Nothing is published.
- **Any other run** (every merge builds packages) only reports what is missing, and still builds ad
  hoc signed packages for testing.
- A release with everything present sets `HTTPREQ_REQUIRE_SIGNING=1` for the rest of the job: the
  build then fails rather than produce an unsigned app or installer
  (`mac.forceCodeSigning`), and verification treats an ad hoc package as an error.

To release unsigned on purpose, run the workflow by hand with **allow_unsigned_mac**, or set the
repository variable `ALLOW_UNSIGNED_MAC_RELEASE` to `true`. Releases made that way tell users to use
**Open Anyway**; an ad hoc build also cannot install auto-updates (macOS requires a Developer ID
signature for that), so those users update from the release page.

### Hardened runtime and entitlements

Apple rejects an app for notarization unless the hardened runtime is on (`hardenedRuntime`, enabled
whenever there is a Developer ID). The runtime stops code the app did not ship from running, so
`build/entitlements.mac.plist` lists what Electron needs, for the app and every helper process:

| Entitlement                                              | Why                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `com.apple.security.cs.allow-jit`                        | V8 compiles JavaScript to machine code. Without it the app is killed at launch under the hardened runtime.         |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Electron's own requirement for the JIT and WebAssembly (the script sandbox is a WebAssembly interpreter).          |
| `com.apple.security.cs.disable-library-validation`       | Lets the app load the native modules `ssh2` ships (`cpu-features`, `sshcrypto`), which are built per architecture. |

`verify-packages.mjs` fails a Developer ID build whose hardened runtime is off or that lacks
`allow-jit`, as either would pass signing and then crash on a user's Mac.

## Checking a build by hand

On a Mac, with a downloaded (quarantined) copy, these are the questions Gatekeeper asks. Each should
succeed for a trusted release:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/HttpReq.app
codesign --display --verbose=4 /Applications/HttpReq.app     # Authority=Developer ID Application …, flags=…(runtime)
spctl --assess --type execute --verbose=2 /Applications/HttpReq.app   # accepted, source=Notarized Developer ID
xcrun stapler validate /Applications/HttpReq.app

pkgutil --check-signature HttpReq-<version>-mac-arm64.pkg    # signed by Developer ID Installer
spctl --assess --type install --verbose=2 HttpReq-<version>-mac-arm64.pkg
xcrun stapler validate HttpReq-<version>-mac-arm64.pkg
```

To see exactly what a build contains: `node apps/desktop/scripts/verify-packages.mjs mac` runs all of
the above on the packages in `apps/desktop/release/` (on a Mac).

## Building on your own Mac

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"   # or CSC_LINK + CSC_KEY_PASSWORD
export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop APPLE_TEAM_ID=TEAMID1234
npm run package:desktop
node apps/desktop/scripts/verify-packages.mjs mac
```

The Installer certificate is found in the keychain by its type (_Developer ID Installer_). A build for
yourself that is signed but not notarized needs `HTTPREQ_ALLOW_UNNOTARIZED=1`; without credentials at
all it is ad hoc signed, which is enough to run it on the Mac that built it.

## For users: opening a build that is not notarized

1. Open the `.pkg`; macOS shows the dialog above. Choose **Done**.
2. **System Settings › Privacy & Security**, scroll to the message about HttpReq, choose **Open
   Anyway**, and confirm with your password.
3. If macOS still refuses a quarantined download, clear the flag:
   `xattr -dr com.apple.quarantine /Applications/HttpReq.app`

## Troubleshooting

| Symptom                                                | Look at                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Release fails at "Check the macOS signing credentials" | The secrets it names. An empty secret counts as missing.                                            |
| "cannot be notarized" during the build                 | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` all set? The password is app-specific. |
| Notarization rejected the app                          | `xcrun notarytool log <id>`: usually an unsigned or non-hardened binary inside the app              |
| App signed and notarized but crashes on launch         | An entitlement is missing (see above); run it from Terminal to read the crash message               |
| Verification: "Gatekeeper does not accept … notarized" | The ticket is not stapled, or the app was modified after notarization                               |
| `.pkg`: "not signed with a Developer ID Installer"     | `MAC_INSTALLER_CSC_LINK` holds the _Application_ certificate; export the _Installer_ one            |
