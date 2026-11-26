# Toolbox

README.md covers the stack, how the tools work, adding a tool, and commands.

## Working alongside other agents (toolbox)

Several agents may work in this repo at once, each on its own feature branch. To keep out of
each other's way:

- **Never work in the main checkout** (`toolbox/`). It belongs to Hafi. Make your own worktree
  and branch: `git worktree add ../toolbox-<topic> -b <topic> origin/main`, then work only
  there. Run `npm ci` in it; don't link `node_modules` from another checkout.

- **Use your own ports.** Hafi keeps the defaults (dev 5173, e2e 4317).
  - Dev server: `npx vite --port <5174, 5175, …> --strictPort`. Run vite directly, not through
    npm, so stopping it frees the port. Stop only the server you started.
  - End-to-end tests: `npx vite build`, then `E2E_PORT=<4318, 4319, …> npx playwright test`.
    The e2e run serves your worktree's `dist/` with `vite preview`, so build first.
  - On Windows, stopping a background `npx vite` can leave the Vite child holding the port and
    locking your worktree folder. Find leftovers with `Get-CimInstance Win32_Process` filtered
    on your worktree path and `Stop-Process` them. A "taken" port may be your own orphan; a port
    you freed may be grabbed by another agent. Check that your server really started before
    trusting a test run against it.

- **Browsers stay headless.** Playwright runs headless Edge. Ask Hafi before any headed run.

- **Check before any git command:** `git branch --show-current`, `git status`, `git fetch`. If you
  find changes you didn't make, leave them: don't commit, stash, revert or overwrite them.

- **Never use bare `git stash`.** The stash is shared by every worktree. Set work aside with a
  temporary commit instead.

- **Don't push to `main` yourself.** Push your branch (Vercel builds a preview) and report back.
  Merging happens only when Hafi asks:
  1. `git fetch`, then check for conflicts with `git merge-tree origin/main <topic>`.
  2. From your worktree: `git checkout --detach origin/main`, then `git merge --no-ff <topic>`,
     so main stays the first parent. `git merge` won't read `-F -`; write the message to a file.
  3. Rerun the checks below on the merged result.
  4. `git fetch` once more (main may have moved), then `git push origin HEAD:main`.

- **Checks before reporting or merging:**
  `npm run typecheck`, `npm run check`, `npm test`, `npx vite build`,
  `E2E_PORT=<port> npx playwright test`.
  Known failure on main as of 2026-11-26: `e2e/reader.spec.ts:64` ("contents, font size keeps
  the passage, scroll mode"). It isn't yours; don't report it as a regression, and don't fix it
  unless that's your task.

- **Stay in your files.** A new tool lives in `src/tools/<id>/` and adds one entry to
  `src/tools/registry.ts` (see README "Adding a tool"). Say so before editing shared files:
  - `src/tools/registry.ts`: every new tool touches it. Add only your own entry, at the end.
  - `src/lib/` (`ui.tsx`, `ui.module.css`, `Icon.tsx`, `worker.ts`, `saveFile.ts`, …) and
    `src/app/` (`tokens.css`, `global.css`, `App.tsx`)
  - `src/lib/pdf/`: the shared PDF engine. EPUB ⇄ PDF depends on it. If you change it, convert a
    PDF with `node scripts/spike.ts <file.pdf> reflow` before and after, and confirm the EPUB is
    unchanged or that every difference is intended.
  - `package.json` / `package-lock.json`: say before adding a dependency. On a conflict, take
    main's lock file and rerun `npm install <your packages>`; never hand-merge the lock.
  - `README.md` (tool table), `vite.config.ts`, `playwright.config.ts`, `vercel.json`

- **Public repo (AGPL-3.0).** Never commit test books, their text, personal files or secrets.
  Real books live outside the repo (in the parent folder) and conversion output goes to `out/`,
  which git ignores. Unit tests use small synthetic fixtures.

- **Clean up when your branch is merged:** `git worktree remove ../toolbox-<topic>` (if it fails
  with "Permission denied" because your shell is inside it: `git worktree prune`, then delete the
  empty folder), and delete your branch locally and on GitHub. Before deleting, confirm the merge
  with `git merge-base --is-ancestor <topic> origin/main`, then use `git branch -D`.
