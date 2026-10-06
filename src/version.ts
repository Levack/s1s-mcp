import { readFileSync } from 'node:fs';

// Replaced at compile time for standalone binaries; npm builds read their manifest.
declare const S1S_BUILD_VERSION: string | undefined;
export const version: string = typeof S1S_BUILD_VERSION === 'string'
  ? S1S_BUILD_VERSION
  : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
