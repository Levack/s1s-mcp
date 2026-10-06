import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temporary = await mkdtemp(path.join(tmpdir(), 's1s-installer-'));
const fixture = path.join(temporary, 'assets');
const commands = path.join(temporary, 'commands');
const installDir = path.join(temporary, 'install with spaces');
const platform = `${process.platform}-${process.arch}`;
const asset = `s1s-mcp-${platform}.tar.gz`;
const exec = promisify(execFile);
const env = { ...process.env, PATH: `${commands}:${process.env.PATH}`, S1S_INSTALL_DIR: installDir,
  S1S_VERSION: '', FIXTURE_ASSETS: fixture, FIXTURE_VERSION: version };
const run = () => exec('sh', [path.join(root, 'scripts/install.sh')], { env, cwd: temporary, timeout: 30000 });
try {
  await mkdir(fixture);
  await mkdir(commands);
  await exec('tar', ['-czf', path.join(fixture, asset), '-C', path.join(root, '.s1s/bin'), 's1s-mcp']);
  const archive = await readFile(path.join(fixture, asset));
  const checksum = createHash('sha256').update(archive).digest('hex');
  await writeFile(path.join(fixture, 'SHA256SUMS'), `${checksum}  ${asset}\n`);
  // Route curl to local release fixtures so this checks the actual shell installer offline.
  await writeFile(path.join(commands, 'curl'), `#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -w|--proto) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  https://github.com/Levack/s1s-mcp/releases/latest)
    printf 'https://github.com/Levack/s1s-mcp/releases/tag/v%s' "$FIXTURE_VERSION" ;;
  https://github.com/Levack/s1s-mcp/releases/download/v"$FIXTURE_VERSION"/*)
    cp "$FIXTURE_ASSETS/\${url##*/}" "$output" ;;
  *) exit 22 ;;
esac
`, { mode: 0o755 });
  assert.match((await run()).stdout, /Installed s1s-mcp/);
  const installed = path.join(installDir, 's1s-mcp');
  assert.equal((await exec(installed, ['--version'], { cwd: temporary })).stdout.trim(), version);
  env.S1S_VERSION = `v${version}`;
  await run();
  assert.deepEqual(await readFile(installed), await readFile(path.join(root, '.s1s/bin/s1s-mcp')));
  await writeFile(path.join(fixture, 'SHA256SUMS'), `${'0'.repeat(64)}  ${asset}\n`);
  await assert.rejects(run(), error => /Checksum mismatch/.test(error.stderr));
  assert.deepEqual(await readFile(installed), await readFile(path.join(root, '.s1s/bin/s1s-mcp')),
    'A rejected download must preserve the installed binary');
  console.log('Installer: latest release, pinned version, paths with spaces, updates, and checksum rejection passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
