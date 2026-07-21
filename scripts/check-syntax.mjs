// check-syntax.mjs — repo-wide lint/type gate (no external deps, ESM).
// 1) node --check every server/*.js module (syntax)
// 2) esbuild-parse every src/**/*.{js,jsx} (JSX syntax + import resolution smoke)
// Exits non-zero on the first failure. This is the repo's established stack:
// zero-dependency checks + vite build as the type/lint gate.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'data'].includes(name)) continue;
      walk(p, exts, out);
    } else if (exts.includes(extname(name))) out.push(p);
  }
  return out;
}

let failures = 0;

// -- server + scripts + shared src .js: node --check --
const serverFiles = [...walk(join(root, 'server'), ['.js']), ...walk(join(root, 'src'), ['.js'])];
for (const f of serverFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failures++;
    console.error(`SYNTAX FAIL ${f}\n${e.stderr?.toString().slice(0, 500)}`);
  }
}
console.log(`node --check: ${serverFiles.length - failures}/${serverFiles.length} OK`);

// -- src JSX: esbuild transform (ships with vite) --
const { transformSync } = await import('esbuild');
const jsxFiles = walk(join(root, 'src'), ['.jsx']);
let jsxFail = 0;
for (const f of jsxFiles) {
  try {
    const { readFileSync } = await import('node:fs');
    transformSync(readFileSync(f, 'utf8'), { loader: 'jsx', jsx: 'automatic' });
  } catch (e) {
    jsxFail++; failures++;
    console.error(`JSX FAIL ${f}\n${String(e.message).slice(0, 500)}`);
  }
}
console.log(`esbuild jsx parse: ${jsxFiles.length - jsxFail}/${jsxFiles.length} OK`);

if (failures) { console.error(`CHECK FAILED: ${failures} file(s)`); process.exit(1); }
console.log('CHECK PASSED');
