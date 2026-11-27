# Toolbox

Small, fast tools that run entirely in the browser. No uploads, no accounts, no size limits.

| Tool | Path | What it does |
|---|---|---|
| **EPUB ⇄ PDF** | `/epub-pdf` | Converts ebooks to PDF and PDFs to ebooks (reflowable text or fixed pages), powered by [MuPDF](https://mupdf.com) compiled to WebAssembly. |
| **EPUB Reader** | `/read` | A light, dark-mode ebook reader: pages or scrolling, contents, typography settings, and a library of recent books kept on the device. |
| **PDF → TXT** | `/pdf-txt` | Turns a book of poems or prose into plain text (one verse line or one sentence per line), shown beside the printed page so you can check and edit it before saving. Reads scanned pages with OCR on demand. |
| **PDF Editor** | `/pdf-edit` | Adds text, drawings, marks, signatures and images to PDF pages and downloads a new copy. |

## Stack

| Piece | Choice | Why |
|---|---|---|
| App | Vite + React + TypeScript | Static SPA; nothing needs a server |
| Routing | wouter (~2 KB) | The tool registry does the real work |
| Conversion | `mupdf` (WASM) in a Web Worker | One engine for both directions; UI never blocks |
| OCR | `tesseract.js` (WASM) in its own Web Worker, English `best_int` model | Loaded only when OCR is asked for; every file is served from `/assets/`, no CDN |
| Worker calls | Comlink | Function calls instead of postMessage plumbing |
| Zip | own writer (`zip.ts`) and reader (`src/lib/zipReader.ts`) | Correct EPUB `mimetype` entry, ZIP64, random access; native `DecompressionStream` for reading |
| Styling | CSS Modules + `tokens.css` | Zero runtime |
| Tests | Vitest (unit), Playwright (headless e2e) | |

## How "no size limit" works

- **Input** is never loaded whole. MuPDF reads byte ranges on demand: the worker serves them from the `File` with `FileReaderSync`, through a small LRU cache of 1 MB blocks (`src/lib/pdf/fileStream.ts`).
- **EPUB output** is streamed. Chunks flow from the worker straight to disk through the File System Access API (Chromium). Other browsers collect a Blob and download it.
- **PDF output** is built in WASM memory, which tops out at 2 GB. That is far beyond any real EPUB→PDF result.
- Vercel only serves static files, so its 4.5 MB function body limit never applies.

## How PDF → TXT works

- **Read once, convert instantly.** The worker reads every page into positioned lines with the shared engine (`src/lib/pdf/`), then keeps them: switching between poetry and prose re-converts in milliseconds.
- **Works from bookmarks or layout.** Each poem or chapter starts at a bookmark when the PDF's outline marks works; otherwise at titles recognized from the book's own typography. Page numbers and running heads are removed; front and back matter is left out unless asked for.
- **Every line knows its page.** The text sits beside the rendered page; the caret, the works menu and the review list all show the source line on the page. Review flags point at what needs a human: scanned pages without text, uncertain titles, likely OCR misreadings, lines that may be wrapped verse.
- **Poetry or prose is guessed** from the book's shape: prose lines fill their column, verse lines mostly stop short.
- **Manual overrides belong to the source.** Verse quoted in prose can be marked "Keep printed lines", a prose passage in poetry "Reflow as prose", and a possibly wrapped verse line joined from the Review list. Each is keyed to its page and position, not to TXT line numbers, so it survives re-conversion and mode switches; it is kept per file in the browser and can be undone from "Your changes".
- **OCR on demand.** For scanned pages (all of them, or one page at a time) tesseract.js reads the page rendered at 300 dpi, in its own worker, loaded on first use (about 4 MB, once; then cached). It runs with PSM 4: the default PSM 3 dropped a title and a whole row on a test page, and PSM 6 and 11 invent rows on blank pages. The results stay with the book, so switching modes keeps them.
- **OCR fills gaps; it doesn't replace pages.** On a scan's existing text layer OCR is no better overall, and on born-digital pages it only adds errors, so `engine/ocr.ts` keeps every text-layer line, adds confident OCR lines the layer lacks, swaps a line only when the layer's reading is garbled beyond resemblance, and flags other material differences for review. A scan without a text layer takes OCR's text (confident lines only). The model and recognizer are self-hosted: `?url` imports make Vite emit them as hashed assets.
- `node scripts/pdf-txt.ts <file.pdf> poetry|prose` runs the same conversion from the command line.

## How the reader stays light and safe

- **Native rendering.** Chapters are the book's own XHTML/CSS, rendered by the browser in an iframe, with no WASM involved. Opening a book reads only the zip's central directory; each chapter is inflated on demand.
- **Untrusted content is inert.** Book scripts, frames, forms, event handlers and `javascript:` URLs are stripped, and the frame's CSP allows no script and no network request, so images and fonts come only from the book itself as `blob:` URLs. The iframe's sandbox does include `allow-scripts`: WebKit (every iPhone browser) runs no event listener in a frame without it, not even the reader's own, so taps and swipes would do nothing there.
- **Pagination** uses CSS columns, one per page. Positions are saved as a text anchor, not a page number, so font, width and window changes keep your place.
- **Library** books live in the Origin Private File System: private to the site, never uploaded, streamed in so large files never sit in memory.

## How the PDF editor works

- Open a PDF, choose a page, then place text, ink, checkmarks, crosses, dots, images, or a drawn, typed, or uploaded signature. Move and resize items in Select mode or use Undo and Redo. Saved signatures stay in this browser when you choose to remember them.
- Download a new copy. Flattening draws edits into the page. Editable annotations retain their PDF annotation types, including text boxes, ink, and stamps. The original file stays untouched. A signed PDF loses the validity of its digital signature when edited.
- A worker reads the input on demand and builds the edited output in WASM memory. Very large exports may exceed the browser's available memory.
- Noto Sans and Dancing Script are distributed under the [SIL Open Font License 1.1](public/pdf-editor-font-licenses.txt) via the MIT-licensed Expo Google Fonts packages. Typed text supports the bundled fonts' Latin, Greek, Cyrillic and Vietnamese coverage. The editor flags unavailable characters when saving. Complex-script shaping and right-to-left layout are outside the current editor's scope.

## Adding a tool

1. Create `src/tools/<id>/index.tsx` with a default-export component.
2. Add one entry to `src/tools/registry.ts`.

The tool becomes its own lazy chunk and shares the UI kit in `src/lib/ui.tsx`.

Tools that read PDFs share the engine in `src/lib/pdf/`: opening and inspecting documents (`document.ts`), reading each page into positioned lines (`extract.ts`), and layout heuristics such as stripping running heads, rejoining OCR fragments and rebuilding paragraphs (`heuristics.ts`). Output formats stay with their tool; EPUB chapters and XHTML live in `src/tools/epub-pdf/engine/`.

## Commands

```sh
npm install
npx vite                    # dev server (run directly, not via npm, so stopping it frees the port)
npm test                    # unit tests (via scripts/test.ts, which fixes Windows drive-letter casing)
npm run typecheck
npm run check               # Biome lint + format check
npx vite build              # production build → dist/
npx playwright test         # headless end-to-end tests (uses installed Edge)
node scripts/spike.ts [file] # convert a real file from the command line → out/
node scripts/pdf-pages.ts <file.pdf> [22|20-24] [--json] # print the positioned lines the engine reads
node scripts/pdf-txt-ocr.ts <file.pdf> poetry|prose [scans|22|20-24] [--flags] [--show 22] # PDF → TXT with OCR merged in
```

## Deploy

Push to GitHub and import the repo in Vercel; it detects Vite automatically. `vercel.json` adds the SPA fallback and long-lived caching for hashed assets, including the WASM.

`SOURCE_URL` in `src/app/config.ts` points users of the site to this repo, as AGPL-3.0 requires.

## License

AGPL-3.0-or-later, as required by MuPDF. See [LICENSE](LICENSE).
