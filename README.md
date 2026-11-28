# Toolbox

Small, fast tools that run entirely in the browser. No uploads, no accounts, no size limits. (The exceptions: the shared room, whose whole point is to pass text and files between devices through a server, and File Transfer, which uses a server only to find the other device; the files go directly between the two browsers.)

| Tool | Path | What it does |
|---|---|---|
| **EPUB ⇄ PDF** | `/epub-pdf` | Converts ebooks to PDF and PDFs to ebooks (reflowable text or fixed pages), powered by [MuPDF](https://mupdf.com) compiled to WebAssembly. |
| **EPUB Reader** | `/read` | A light, dark-mode ebook reader: pages or scrolling, contents, typography settings, and a library of recent books kept on the device. |
| **PDF → TXT** | `/pdf-txt` | Turns a book of poems or prose into plain text (one verse line or one sentence per line), shown beside the printed page so you can check and edit it before saving. Reads scanned pages with OCR on demand. |
| **Zip / Unzip** | `/unzip` | Browse ZIP, 7z, RAR and other archives, preview text and images, and extract files locally. Or pack files and folders into a new ZIP, 7z or TAR.GZ, optionally with an AES-256 password. |
| **PDF Editor** | `/pdf-edit` | Signs, fills in forms, and adds text, drawings, marks and images to PDF pages. Rearranges, rotates, duplicates and deletes pages, merges several PDFs, and splits or extracts pages (into one .zip or separate PDFs). Opens password-protected PDFs, and downloads a new copy. |
| **Shared room** | `/room` | A text box and files every device can see: make a room, open the page on another device, tap the room, and paste or add files. Rooms are public and end when their creator leaves, or after 2 hours. |
| **Blazing Fast File Transfer** | `/file-transfer` | Sends photos, videos and whole folders straight to another device over WebRTC, striped across several connections. The other person accepts and gets one .zip download (or, opt-in, the files in a folder). Nothing is uploaded. Fastest on Wi-Fi or wired; mobile data limits the speed. |
| **Photo Converter** | `/photo` | Converts iPhone HEIC photos to JPEG or PNG, and JPEG ⇄ PNG, one photo or a whole folder (one .zip). Keeps the pixel size, orientation, Display P3 colors and EXIF (date, camera, location, with a switch to remove the location). |

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
| Shared room | One Vercel Function (`api/rooms.ts`) + Upstash Redis, polled | Vercel Functions can't hold WebSockets open; a room is tiny state, so polling a key-value store is enough |
| File Transfer | WebRTC data channels, several peer connections per pair; one Vercel Function (`api/file-transfer.ts`) + the same Redis for presence and the first handshake | No relay and no file bytes on a server; striping beats the per-connection limit on long links |
| Tests | Vitest (unit), Playwright (headless e2e) | |

## How "no size limit" works

- **Input** is never loaded whole. MuPDF reads byte ranges on demand: the worker serves them from the `File` with `FileReaderSync`, through a small LRU cache of 1 MB blocks (`src/lib/pdf/fileStream.ts`).
- **EPUB output** is streamed. Results up to 512 MB are collected and downloaded directly, with no save dialog. Larger ones stream from the worker straight to a file the user picks, through the File System Access API (Chromium); other browsers collect a Blob and download it.
- **No browser pop-ups for ordinary use.** Confirmations are in-page dialogs (`src/lib/confirm.tsx`). Where the browser must ask permission (choosing a folder to read or extract into), the page explains it first, once per device; dragging folders in needs no permission.
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

## How Zip / Unzip works

- The tool opens archives in a Web Worker using `7z-wasm`, a WebAssembly build of 7-Zip 24.09. The worker reads file ranges through WORKERFS and streams the extracted bytes. Compressed TAR archives are scanned from the decompressed stream. [7z-wasm 1.2.0](https://www.npmjs.com/package/7z-wasm/v/1.2.0)
- Choose individual files or folders and preview UTF-8 text or supported images. 7-Zip handles encrypted archives locally. Saved paths have unsafe characters and parent segments removed, and collisions get distinct names.
- Browsers with a folder picker can stream files into a new subfolder. Other browsers build a download in memory, so available memory limits the size of that output. The ZIP fallback also streams through the shared writer in `src/lib/zipWriter.ts` when the browser provides a save-file picker.
- Multi-volume archives require companion files and are unsupported. The library's WebAssembly heap has a 2 GB ceiling. The worker can temporarily queue data when extraction outruns disk writes.
- **Create** packs files and folders (file picker, folder picker, or drag and drop) into ZIP (default), 7z or TAR.GZ. The worker runs `7zz a` over a WORKERFS tree built from the picked `File` objects, so inputs are read in ranges on demand, never copied in whole. The archive is written to a device node that forwards each positioned write (7-Zip patches headers it wrote earlier): Chromium streams it to the file you choose, other browsers collect it in memory and download it, capped at 2 GB. TAR.GZ is 7-Zip's tar stream gzipped by `fflate`. Levels map to `-mx0/1/5/9`; a password gives AES-256 (`-mem=AES256` for ZIP, `-mhe=on` for 7z so names are hidden too). ZIP names carry the UTF-8 flag. Paths keep their folders, are NFC-normalised, and repeated names get a ` (2)` suffix.
- 7-Zip's own working memory is what grows: ZIP and TAR.GZ stay small, 7z Normal and Max allocate a few hundred MB for the LZMA2 dictionary (the WASM heap tops out at 2 GB). ZIP rewrites an entry that didn't compress and truncates the file, so targets also take truncation.
- iPhone and iPad Safari can't pick folders, so Create offers files only there.
- 7-Zip is distributed under the LGPL with the unRAR restriction. [7-Zip license](https://unpkg.com/7z-wasm@1.2.0/License.txt), [unRAR license](https://unpkg.com/7z-wasm@1.2.0/unRarLicense.txt), [build source](https://github.com/use-strict/7z-wasm)

## How the PDF editor works

- Open a PDF, choose a page, then place text, ink, checkmarks, crosses, dots, images, or a drawn, typed, or uploaded signature. Move and resize items in Select mode or use Undo and Redo. Saved signatures stay in this browser when you choose to remember them.
- **Pages:** reorder pages by dragging (on touch screens by the ⠿ handle) or with Move left / Move right, rotate, duplicate and delete them, merge more PDFs (each page shows which file it came from), extract the selected pages, or split by ranges ("1-3, 4-10") or every N pages into separate PDFs or one .zip. Placed items stay with their page; rotating a page turns its items with it. Undo and Redo cover page changes. Form fields of merged PDFs stay as they look but only the first PDF's fields are fillable; a duplicated page keeps no form fields.
- **Fill form:** AcroForm text, check box, radio, combo and list fields are listed beside the page and highlighted on it; read-only fields are locked and empty required ones are flagged before download. Signature fields take a drawn, typed or uploaded signature (an image, not a certificate signature). Values are written through MuPDF, which regenerates the field appearances; the fields stay fillable unless you choose Flatten form. Dynamic XFA-only forms are reported as unsupported.
- Download a new copy. Flattening draws edits into the page. Editable annotations retain their PDF annotation types, including text boxes, ink, and stamps. The original file stays untouched. A signed PDF loses the validity of its digital signature when edited.
- A worker reads the input on demand and builds the edited output in WASM memory. Very large exports may exceed the browser's available memory.
- Noto Sans and Dancing Script are distributed under the [SIL Open Font License 1.1](public/pdf-editor-font-licenses.txt) via the MIT-licensed Expo Google Fonts packages. Typed text supports the bundled fonts' Latin, Greek, Cyrillic and Vietnamese coverage. The editor flags unavailable characters when saving. Complex-script shaping and right-to-left layout are outside the current editor's scope.

## How the shared room works

- **One function, polled.** `api/rooms.ts` is a Vercel Function: list, create, read, write, heartbeat, leave, end. Pages poll it (every second while the text is moving, every 4 s when quiet, not at all in a hidden tab) and only download the text when its version changed.
- **State in Upstash Redis, shared with other projects.** Every key starts with `toolbox:`, rooms are listed from one sorted set (never by scanning keys), and nothing flushes the database. Credentials come from `ROOM_KV_REST_API_URL` / `ROOM_KV_REST_API_TOKEN` (the names Vercel set when the store was connected).
- **Rooms end on their own.** The creator's page sends a heartbeat every 20 s; a room lives 2 minutes past the last one. When the creator's page goes away it says so, and the room ends 15 s later unless the page comes back (a reload). No room outlives 2 hours.
- **Open by design.** Anyone on the site can see and edit any room, and download its files. Text is capped at 100 KB, writes are rate-limited per IP, and at most 50 rooms exist at once.
- **Files ride along.** Anyone in a room can add files (picker, drag and drop, paste), download and delete them. They go through the server and live in the same Redis database, base64-encoded, only as long as the room: ending a room deletes them, every file key expires no later than the room's 2-hour cap, and listing the lobby sweeps the files of rooms that timed out. Pages learn about changes from a files version (`fver`) in the room poll they already make, and fetch the file list only when it moves.
- **Files in chunks, checked twice.** A file travels in 2 MiB chunks, one request each. The uploader declares every chunk's SHA-256 (and the whole file's) up front; the server stores a chunk only if its size and hash match, so once all chunks are in, the file is exactly what was hashed, and only then is it offered. The downloader checks each chunk and the reassembled file again. An upload that doesn't finish within 15 minutes expires and gives its space back.
- **File limits**, from Upstash's free tier (250 MB data, 10 MB per request, 500K commands and 10 GB bandwidth a month; [pricing](https://upstash.com/pricing/redis.md), [request size](https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded)) and Vercel Hobby functions (4.5 MB request and response bodies, 300 s; [limits](https://vercel.com/docs/functions/limitations)):
  - **2 MiB chunks**: a 2 MiB upload body and download response (under half of Vercel's 4.5 MB), and a 2.8 MB base64 value in Redis (under a third of the 10 MB request limit). Smaller chunks would cost more commands per MB.
  - **20 MiB per file, 40 MiB and 20 files per room, 64 MiB for all rooms together.** The database is shared with other projects, so the site-wide cap keeps toolbox files to about 85 MB of the 250 MB once base64-encoded. Space is reserved in a counter hash (`toolbox:files:bytes`, room → bytes) before the first chunk is sent, so racing uploads can't overshoot.
  - **Cost:** about 4 Redis commands and 1.33 MiB of Redis bandwidth per MiB uploaded, about 2 commands and 1.33 MiB per MiB downloaded. 10 GB of bandwidth a month is roughly 3.7 GiB of files shared and downloaded once each. Chunk requests count toward the same per-IP limit as other writes.
- **Local dev and tests need no database.** `scripts/api-dev.ts` serves `/api/rooms` from `npx vite` and `vite preview` with an in-memory store that mimics Redis, expiry included. With `ROOM_KV_*` set in the environment, the same code talks to Upstash.

## How File Transfer works

Design and decisions: [docs/file-transfer/SPEC.md](docs/file-transfer/SPEC.md). Code: `src/tools/file-transfer/`, `api/file-transfer.ts`, `public/ft-sw.js`.

- **Finding each other.** Each tab polls `api/file-transfer.ts` (`presence.ts`): every 3 s while someone uses the page, 10 s when idle or with the *Hidden* switch on (so invite-link requests still arrive), 60 s in a hidden tab, 1 s while a request waits for an answer, and not at all after 2 hours without use. A device keeps a random id and secret in `localStorage`; the server stores only a hash of the secret. Peers on the same IPv4 address (or IPv6 /64) get a "Same network" badge; IPs are kept only as salted HMACs and never reach other clients.
- **Connecting.** A click asks the other person; their *Accept* turns an atomic claim (`HSETNX`) into a handshake. Only the first connection's offer and answer go through Redis (a 60 s mailbox, ≤ 16 KiB each, non-trickle ICE, STUN only, no TURN). Everything after that travels over that connection's `ctrl` channel: 5 more connections ("lanes", 6 in all), ICE restarts, file lists, accepts and cancels.
- **Moving bytes** (`engine/`). Files are cut into ranges that the lanes pull one after another. Frames are 256 KiB (or the connection's SCTP max message size, if smaller) with a 16-byte header; each lane keeps ≤ 8 MiB buffered and ≤ 16 MiB unacknowledged, and the receiver acks what it has written. A lost lane's unacked ranges go to the others.
- **Receiving, by default: one streamed .zip, no prompt.** The page feeds a store-only ZIP64 archive (folders and modified dates kept, CRC32 as it goes) to a service worker (`public/ft-sw.js`), which answers a hidden download URL with an exact `Content-Length`: one ordinary download per batch, `Transfer from <name> <date> <time>.zip` (for example `Transfer from Calm Otter 2026-11-28 10.11.zip`), started by the click on *Accept*. The zip must be written in order, so the lanes work through the batch as one stream in 1 MiB ranges within a 64 MiB reorder window. When the range at the head stalls for a second (an SCTP connection backing off after losses), its lane's unacknowledged ranges are offered to the other lanes as well. WebKit (every browser on iOS, and Safari on the Mac) never takes that path: its page reads the service worker's response, but the download "Save…" then starts stays at 0 KB. It builds the same zip in memory instead, up to 1 GiB, and the browser asks where to keep it, so the page says "Received", not "Saved". The zip stays on the page with **Save .zip** and **Share…** (the share sheet's "Save to Files") in case that prompt doesn't come or doesn't finish.
- **Receiving into a folder** (opt-in, Chromium desktop): an in-page explanation, then the browser's folder picker and its permission prompt. Files land at their sanitized paths, identical files already there are skipped, and lanes write ranges in any order (at most 16 files open at once, more only while the disk catches up, so a slow lane can't deadlock it). Browsers can't set modified dates on files they write; the zip keeps them.
- **Prompt policy.** No `confirm`/`alert`, no "Leave site?", no notification permission (a hidden tab shows "(1) Request from …" in its title instead), exactly one download per batch, and the folder picker only after the page explains it. Folders are sent by drag and drop (no prompt); the *Choose folder* button (where the browser asks) exists only on touch devices.
- **Browser support.** Chrome and Edge on a computer: everything. Firefox: send and zip receive. Safari and iOS: send, and receive through the memory fallback (≤ 1 GiB; iOS only while the tab stays in front). Feature detection only.
- **Speed.** `node scripts/file-transfer-bench/bench.ts` runs the real engine and lanes between two headless Edge processes, directly or through a Node UDP proxy that adds delay, loss and a 1 Gbit/s cap. The proxy itself tops out around 65 MB/s on this machine (the spike measured ~32), so figures near that are its ceiling rather than the transfer's. MB/s, unordered (folder) / zip-ordered, November 2026 on a Ryzen 9 5900X; details in [`scripts/file-transfer-bench/results/`](scripts/file-transfer-bench/results/):

  | Link | 1 lane | 4 lanes | 6 lanes (default) | 8 lanes |
  |---|---:|---:|---:|---:|
  | Same machine, direct | 57.0 / 37.8 | 55.8 / 53.6 | 56.1 / 55.0 | 56.3 / 54.8 |
  | 20 ms RTT, 1 Gbit/s | 0.1* / 46.0 | 60.8 / 61.4 | 61.2 / 62.7 | 60.6 / 65.1 |
  | 50 ms RTT, 1 Gbit/s | 0.3* / 0.3* | 15.4 / 20.2 | 64.1 / 66.3 | 65.3 / 60.3 |
  | 100 ms RTT, 1 Gbit/s | 0.0* / 0.0* | 14.2 / 16.8 | 20.5 / 30.2 | 34.3 / 28.6 |
  | 50 ms RTT + 0.1% loss | 0.8 / 0.8 | 3.4 / 2.8 | 5.3 / 3.5 | 7.4 / 5.7 |

  \* A single connection through the proxy stalled for most of the run (SCTP backing off after packets were lost on the way into the browser); with several lanes those stalls disappear in the total. A real long-distance test between two machines is still to do.

- **Server limits.** At most 100 peers on the page (503 `full`), 6 per IP (429 `too-many-here`), 60 requests, answers and handshake messages per IP per minute, 8 handshake messages per pair, 50 peers listed per poll. Every key starts with `toolbox:ft:` and expires (peers hash 180 s, mailbox 60 s, rate counters 90 s).
- **Quota.** Upstash's free tier (500K commands a month) is shared with the room and other projects, so File Transfer aims to stay under ~150K: an active tab costs ~3,600 commands an hour, an idle one ~1,080, a hidden (or connected and hidden) one ~180, one connection ~100–130. For example 30 active, 20 idle and 100 hidden tab-hours plus 50 connections come to about 154K. A poll returns at most ~20 KB (typically under 2 KB).
- **Environment** (Vercel project settings):
  - `FILE_TRANSFER_IP_SALT`: **required in production**; without it every call answers 503 `no-salt`. Any long random secret (`openssl rand -hex 32`); it keys the IP hashes, and changing it only resets the per-IP counters and "Same network" matching. Local dev uses a random per-process salt.
  - `FILE_TRANSFER_DISABLED=1`: kill switch. Every call answers 503 `disabled` without touching Redis; the page says "File Transfer is paused right now."
  - `ROOM_KV_REST_API_URL` / `ROOM_KV_REST_API_TOKEN`: the same Upstash database as the room. Local dev and the e2e tests use the in-memory store in `scripts/api-dev.ts`.
- **Privacy.** Connecting shows each side's IP addresses to the other (inherent to WebRTC; the page says so). WebRTC encrypts every connection (DTLS); there is no extra app-level encryption or verification code, so the signaling server could in principle sit in the middle.

## How the photo converter works

- **One photo at a time, in a worker.** `src/tools/photo/photo.worker.ts` decodes and encodes each photo off the main thread, then hands the bytes back (transferred, not copied). A 48 MP photo is about 195 MB of pixels, so photos are never processed side by side. One photo downloads as itself; several stream into one store-only zip (`src/lib/zipWriter.ts`), each entry dated with the photo's date taken. Cancel stops the worker.
- **Codecs load per format.** Each WebAssembly codec is fetched the first time a photo needs it: libheif (`libheif-js`, HEVC decoding via libde265, 1.46 MB, about 490 KB gzipped) for HEIC, MozJPEG (`@jsquash/jpeg`) and the PNG codec (`@jsquash/png`). A JPEG → PNG batch never downloads libheif. The canvas is never used: it would drop the color profile and EXIF, flatten everything to 8-bit sRGB, and iPhone Safari caps it near 16.7 MP.
- **Decoding.** HEIC: the primary image through libheif's C API (`heif.ts`), with its rotation and mirroring applied, at 8 bits or, for 10/12-bit files, as 16-bit values; plus its ICC profile or nclx color description, its EXIF block, and whether it carries an HDR gain map. JPEG and PNG: raw pixels, then the EXIF orientation is applied by `rotate.ts`. The ICC profile and EXIF are read from the file's own segments (`containers.ts`).
- **Color.** The source color space is kept and its profile embedded: iPhone photos stay Display P3, which every current phone, Mac, Windows photo viewer and browser shows correctly. *sRGB for maximum compatibility* (off by default) converts Display P3 exactly (sRGB curve, one 3×3 matrix, clamp) for sites that strip profiles. Profiles are recognized by their colorants and curves (`color.ts`); when a HEIC names its space only through nclx, a compact ICC profile written by `iccProfile()` is embedded instead.
- **Metadata.** EXIF is copied with three edits made in place (`exif.ts`): Orientation becomes 1, the embedded thumbnail is removed, and with *Remove location* the GPS directory is unlinked and every byte of it zeroed, so no coordinates remain. XMP isn't copied.
- **Output.** JPEG: MozJPEG, quality 92 by default, baseline, 4:4:4 (no chroma subsampling, so colored edges stay sharp); transparency is filled with white, with a note. PNG: 8-bit, or 16-bit when the source has more than 8 bits. A file already in the chosen format is handed back untouched unless a switch requires a change.
- **HDR.** iPhone HEIC photos are a standard image plus an HDR gain map. The standard image is saved and the list says HDR brightness isn't kept; gain-map output is future work.
- **Tests** use synthetic fixtures only (`e2e/fixtures/photo`, made once by `scripts/photo-fixtures.py` with Pillow and pillow-heif, since the bundled libheif can't encode). `src/tools/photo/nodeCodecs.ts` loads the same codecs in Node for the unit and e2e checks.
- **Licenses.** libheif and libde265 are LGPL-3.0 (via `libheif-js`); the jSquash codecs (MozJPEG, the Rust `png` crate) are Apache-2.0 / BSD-style. HEVC is patent-encumbered; decoding it with libde265 is what nearly every web HEIC converter ships, and nothing is encoded to HEVC here.

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
node scripts/file-transfer-bench/bench.ts [--quick] # File Transfer throughput matrix in headless Edge (~15 min) → results/<date>.md
```

## Deploy

Push to GitHub and import the repo in Vercel; it detects Vite automatically. `vercel.json` adds the SPA fallback and long-lived caching for hashed assets, including the WASM. The SPA fallback skips `/api/`, where Vercel serves the shared-room function; it needs the Upstash Redis integration (Storage tab) connected with the `ROOM_` prefix. File Transfer's function (`api/file-transfer.ts`) uses the same store and also needs `FILE_TRANSFER_IP_SALT` (see above). `vercel.json` serves `/ft-sw.js` with `Cache-Control: no-cache`, so a new service worker is picked up at once.

`SOURCE_URL` in `src/app/config.ts` points users of the site to this repo, as AGPL-3.0 requires.

## License

AGPL-3.0-or-later, as required by MuPDF. See [LICENSE](LICENSE).
