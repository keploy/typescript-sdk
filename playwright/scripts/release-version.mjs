// release-version.mjs TAG: the publish workflow's version check.
//
// TAG is the pushed git tag. It must name package.json's version exactly
// (playwright-v<version>), so the version on npm is always the one a tagged
// commit carries. The version must be a release (x.y.z): npm 10 would make a
// prerelease the package's `latest`, so this workflow refuses one.
//
// Exit 0 with no output when the tag may publish; exit 1 and say why when not.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function refusal(tag, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return `package.json's version ${version} is not a release (x.y.z); this workflow publishes releases only`;
  }
  const want = `playwright-v${version}`;
  if (tag !== want) {
    return `the tag ${tag || '(none)'} does not name package.json's version ${version}: the tag for it is ${want}`;
  }
  return '';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const why = refusal(process.argv[2] ?? '', pkg.version);
  if (why) {
    console.error(`refusing to publish: ${why}`);
    process.exit(1);
  }
}
