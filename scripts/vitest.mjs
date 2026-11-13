// Runs Vitest from a cwd with an uppercase Windows drive letter. VS Code terminals report "d:\…", which makes
// Vitest load two copies of its runner ("Vitest failed to find the runner"). No-op on macOS/Linux.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const pkgPath = createRequire(join(cwd, 'package.json')).resolve('vitest/package.json');
const pkg = createRequire(import.meta.url)(pkgPath);
const bin = join(dirname(pkgPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.vitest);
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
process.exit(r.status ?? 1);
