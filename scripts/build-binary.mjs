import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const [target, output = '.s1s/bin/s1s-mcp'] = process.argv.slice(2);
mkdirSync(path.dirname(path.resolve(root, output)), { recursive: true });
execFileSync('bun', ['build', '--compile', '--minify',
  ...(target ? [`--target=${target}`] : []),
  '--define', `S1S_BUILD_VERSION=${JSON.stringify(version)}`,
  'src/cli.ts', '--outfile', output], { cwd: root, stdio: 'inherit' });
