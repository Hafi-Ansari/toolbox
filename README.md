# Toolbox

Small, fast tools that run entirely in the browser. No uploads, no accounts, no size limits.

**First tool: EPUB ⇄ PDF.** It converts ebooks to PDF and PDFs to ebooks (reflowable text or fixed pages), powered by [MuPDF](https://mupdf.com) compiled to WebAssembly.

## Stack

| Piece | Choice | Why |
|---|---|---|
| App | Vite + React + TypeScript | Static SPA; nothing needs a server |
| Routing | wouter (~2 KB) | The tool registry does the real work |
| Conversion | `mupdf` (WASM) in a Web Worker | One engine for both directions; UI never blocks |
| Worker calls | Comlink | Function calls instead of postMessage plumbing |
| Zip | own writer in `zip.ts` + `fflate` deflate | Correct EPUB `mimetype` entry, ZIP64, streaming |
| Styling | CSS Modules + `tokens.css` | Zero runtime |
| Tests | Vitest (unit), Playwright (headless e2e) | |

## How "no size limit" works

- **Input** is never loaded whole. MuPDF reads byte ranges on demand: the worker serves them from the `File` with `FileReaderSync`, through a small LRU cache of 1 MB blocks (`engine/fileStream.ts`).
- **EPUB output** is streamed. Chunks flow from the worker straight to disk through the File System Access API (Chromium). Other browsers collect a Blob and download it.
- **PDF output** is built in WASM memory, which tops out at 2 GB. That is far beyond any real EPUB→PDF result.
- Vercel only serves static files, so its 4.5 MB function body limit never applies.

## Adding a tool

1. Create `src/tools/<id>/index.tsx` with a default-export component.
2. Add one entry to `src/tools/registry.ts`.

The tool becomes its own lazy chunk and shares the UI kit in `src/lib/ui.tsx`.

## Commands

```sh
npm install
npx vite                    # dev server (run directly, not via npm, so stopping it frees the port)
npm test                    # unit tests
npm run typecheck
npm run check               # Biome lint + format check
npx vite build              # production build → dist/
npx playwright test         # headless end-to-end tests (uses installed Edge)
node scripts/spike.ts [file] # convert a real file from the command line → out/
```

## Deploy

Push to GitHub and import the repo in Vercel; it detects Vite automatically. `vercel.json` adds the SPA fallback and long-lived caching for hashed assets, including the WASM.

`SOURCE_URL` in `src/app/config.ts` points users of the site to this repo, as AGPL-3.0 requires.

## License

AGPL-3.0-or-later, as required by MuPDF. See [LICENSE](LICENSE).
