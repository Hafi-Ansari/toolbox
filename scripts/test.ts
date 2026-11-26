// Runs Vitest with a normalized working directory.
// Windows shells (VS Code's, for one) can start with a lowercase drive letter
// ("c:\…") while Vite resolves paths to "C:\…"; Vitest then loads two copies of
// itself and every suite fails with "Cannot read properties of undefined
// (reading 'config')". Restarting from an uppercase cwd avoids that.
//   node scripts/test.ts [vitest args]   (npm test runs this with "run")
import { spawnSync } from "node:child_process";
import path from "node:path";

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const bin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(result.status ?? 1);
