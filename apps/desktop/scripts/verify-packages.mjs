// Checks a platform's packages before they are uploaded, so a broken or mislabelled build fails
// its job instead of reaching a release. Run after `npm run package:desktop`:
//
//   node apps/desktop/scripts/verify-packages.mjs <win|mac|linux>
//
// It fails unless every expected installer exists, is not empty and is named for the current
// version, and unless every packaged app (app.asar) reports that same version, which is what
// `app.getVersion()` returns at runtime. It then writes SHA256SUMS-<platform>.txt beside them.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(desktop, 'release');
const { version } = JSON.parse(readFileSync(join(desktop, '..', '..', 'package.json'), 'utf8'));
const v = version.replace(/[.+]/g, '\\$&');

/** Every installer each platform must produce; electron-builder.config.cjs sets these names. */
const expected = {
  win: [new RegExp(`^HttpReq-Setup-${v}-x64\\.exe$`)],
  mac: ['x64', 'arm64'].flatMap((arch) => [
    new RegExp(`^HttpReq-${v}-mac-${arch}\\.dmg$`),
    new RegExp(`^HttpReq-${v}-mac-${arch}\\.zip$`),
  ]),
  linux: [
    new RegExp(`^HttpReq-${v}-linux-(x86_64|x64)\\.AppImage$`),
    new RegExp(`^httpreq_${v}_amd64\\.deb$`),
  ],
};

const platform = process.argv[2];
if (!expected[platform]) {
  console.error(`Usage: verify-packages.mjs <${Object.keys(expected).join('|')}>`);
  process.exit(2);
}

const errors = [];
const files = readdirSync(release).filter((name) => statSync(join(release, name)).isFile());
const packages = expected[platform].map((pattern) => {
  const name = files.find((file) => pattern.test(file));
  if (!name) errors.push(`Missing package matching ${pattern} in ${release}.`);
  else if (statSync(join(release, name)).size === 0) errors.push(`${name} is empty.`);
  return name;
});

// The version baked into each packaged app.
const { extractFile } = require('@electron/asar');
const findAsars = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'app.asar') return [path];
    return entry.isDirectory() && !entry.isSymbolicLink() ? findAsars(path) : [];
  });
const asars = findAsars(release);
if (asars.length === 0) errors.push('No packaged app.asar found to check the app version.');
for (const asar of asars) {
  const packaged = JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version;
  if (packaged !== version) {
    errors.push(`${relative(release, asar)} reports version ${packaged}, expected ${version}.`);
  }
}

// The Debian control file carries its own version field.
const deb = packages.find((name) => name?.endsWith('.deb'));
if (deb) {
  const debVersion = execFileSync('dpkg-deb', ['--field', join(release, deb), 'Version'], {
    encoding: 'utf8',
  }).trim();
  if (debVersion !== version) errors.push(`${deb} has Version ${debVersion}, expected ${version}.`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`::error title=Invalid ${platform} package::${error}`);
  process.exit(1);
}

const sums = packages
  .map((name) => {
    const hash = createHash('sha256')
      .update(readFileSync(join(release, name)))
      .digest('hex');
    return `${hash}  ${name}\n`;
  })
  .join('');
writeFileSync(join(release, `SHA256SUMS-${platform}.txt`), sums);
console.log(`Verified ${platform} packages for ${version}:\n${sums}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${platform} packages (${version})\n\n` +
      packages
        .map(
          (name) => `- \`${name}\` (${(statSync(join(release, name)).size / 1e6).toFixed(1)} MB)`,
        )
        .join('\n') +
      '\n',
  );
}
