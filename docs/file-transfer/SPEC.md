# Blazing Fast File Transfer — implementation spec (v1)

Status: approved design, ready to implement. Branch `send`. The tool is **"Blazing Fast File Transfer" at
`/file-transfer`** (registry `id: "file-transfer"`). Page headings and the registry use the full name; running UI copy
may shorten it to "File Transfer".

This spec is written for the agents who will build the tool. It is meant to be complete on its own: every
decision already made is stated as a requirement (**MUST** / **SHOULD**), and the remaining open questions are
listed in §18 (all decided on 2026-11-27). Read `CLAUDE.md` (how to work in this repo: worktrees, ports, headless browsers, shared files,
checks) and `README.md` (stack, "Adding a tool", "How the shared room works") before starting.

---

## 1. Goal

Move **tens of GB** of photos and videos (RAWs, JPEGs, video files) between two people **as fast as their
networks allow**, using only a web page. Nothing is installed and no file data goes through any server.

Each person opens `/file-transfer`. They see everyone else on the page, click a peer, the other person accepts, and the
two browsers connect directly over WebRTC. Either side can then send files.

### Goals

- Throughput close to what the network allows, on long-distance links too. A single WebRTC connection is badly
  limited by latency (§3), so the transfer **stripes across several peer connections ("lanes")**.
- **No browser-owned prompts or dialogs** on the default path. The site owner finds them tacky and
  scam-adjacent (§9). Where one can't be avoided, it is opt-in and preceded by an in-page explanation.
- A newcomer understands the page in seconds: one peer grid, one request/accept step, one progress view.
- Respect the shared Upstash free tier: it is shared with the Room tool and other projects (§6.6).

### Non-goals (v1)

- App-layer encryption and verification codes. WebRTC's DTLS still encrypts the wire (§13).
- TURN relay. Peers that can't connect directly get a clear message (§11).
- Resuming after a page reload, or resuming a zip download (§10).
- Transfers in the background on iOS (the OS suspends the tab).
- Anything that keeps file bytes on a server.

---

## 2. Background: code to reuse

| Source | What to take | How |
|---|---|---|
| `api/rooms.ts` | `Kv` interface, `redisKv()`, `memoryKv()`, `clientIp()`, `json()`, store selection `rooms()`, rate limiter `allowWrite()`, name lists `ADJECTIVES`/`ANIMALS` | **Copy** the parts you need into `api/file-transfer.ts`; don't import (the function is self-contained on purpose) |
| `scripts/api-dev.ts` | Serves `api/*.ts` handlers from `vite` / `vite preview` | Add `/api/file-transfer` (**shared file**) |
| `src/tools/room/index.tsx`, `Room.module.css` | `useVisiblePoll()`, lobby grid and tile markup (`.grid`, `.tile`, `.emoji`, `.tileText`, `.tileName`, `.badge`, `.muted`, `.empty`) | **Copy** into the tool; don't extract a shared component |
| `src/tools/room/client.ts` | `call()` fetch wrapper, sessionStorage helpers, the `keepalive`/`sendBeacon` leave | Copy and adapt |
| `src/tools/unzip/create/collect.ts` | Folder traversal from drag and drop (`webkitGetAsEntry` + `readAll`), `fromInput()` | Copy the drag-and-drop and file-input parts (not `showDirectoryPicker`) |
| `src/lib/zipWriter.ts` | `ZipWriter.addStream(name, size)`: data descriptors, ZIP64, running CRC32, `finish()` | **Import.** Small extension needed for modified times (§8.2, **shared file**) |
| `src/lib/confirm.tsx` | `confirm()` (in-page confirmation) and `explainOnce()` (explains a browser prompt before it appears, once per device) | Import. `confirm()` comes from branch `ui-polish`, `explainOnce()` from `no-prompts`. Start once both are merged into `main` (or rebase onto them) |
| `src/lib/ui.tsx` | `Button`, `Card`, `Note`, `Progress`, `FileDrop`, `Chip` | Import |
| WebDrop (`C:\Users\Hafi\Developer\drop\webdrop`, MIT, same author) `web/src/lib/transfer.ts`, `session.ts`, `tuning.ts` | Backpressure loop (`bufferedAmount` high/low water + receiver ack window), read-ahead with `File.slice()`, `RateMeter`, `PeerSession` (negotiated channels, ICE restart, offerer-only renegotiation) | Adapt. **Remove** `SecureLink`, `crypto.ts` and `framing.ts` encryption. **Don't copy** `sinks.ts`/`download.ts` (see below) |

**Don't copy WebDrop's receive path.** It writes each file into OPFS, then hands it to the downloads manager
through an object URL. That writes every byte twice, is capped by the OPFS quota, and makes Chrome ask "This site
is trying to download multiple files". Use the sinks in §8 instead.

---

## 3. Measured basis (spike, November 2026)

Two headless Edge processes on one Windows machine (Ryzen 9 5900X) connected by raw WebRTC data channels with no
app-layer crypto. A Node UDP proxy added latency, loss and a 1 Gbit/s rate cap (CDP network emulation does not
affect WebRTC). The proxy itself tops out at about **32 MB/s**, so any figure near that understates the real
ceiling. Transfers were 0.25–1 GiB.

| Link | 1 lane | Best with more lanes |
|---|---|---|
| Same machine, discard on receive | 47 MB/s | 56 MB/s (4 lanes); 8 lanes 55 |
| 20 ms RTT, 1 Gbit/s | 14 MB/s | 37 MB/s (4) |
| 50 ms RTT, 1 Gbit/s | **5.4 MB/s** | **33.5 MB/s (8)**; 2 lanes 13.5, 4 lanes 14.4 |
| 100 ms RTT, 1 Gbit/s | 3.7 MB/s | 5.3 MB/s (4); 8 lanes 4.9 (**unexplained, needs a real-world test**) |
| 50 ms RTT + 0.1% loss | **0.9 MB/s** | 6.9 MB/s (8); 4 lanes 3.4 |
| 30 ms RTT, 100 Mbit/s, 4 MiB buffer | 6.4 MB/s | 6.4 MB/s (4) |

**WP6 benchmark (real engine and lanes, `scripts/file-transfer-bench/`, results/2026-11-28.md).** Same machine and
proxy, MB/s unordered / zip-ordered. The proxy now carries up to ~65 MB/s.

| Link | 1 lane | 4 lanes | 6 lanes (default) | 8 lanes |
|---|---:|---:|---:|---:|
| Same machine, direct | 57.0 / 37.8 | 55.8 / 53.6 | 56.1 / 55.0 | 56.3 / 54.8 |
| 20 ms RTT, 1 Gbit/s | 0.1* / 46.0 | 60.8 / 61.4 | 61.2 / 62.7 | 60.6 / 65.1 |
| 50 ms RTT, 1 Gbit/s | 0.3* / 0.3* | 15.4 / 20.2 | 64.1 / 66.3 | 65.3 / 60.3 |
| 100 ms RTT, 1 Gbit/s | 0.0* / 0.0* | 14.2 / 16.8 | 20.5 / 30.2 | 34.3 / 28.6 |
| 50 ms RTT + 0.1% loss | 0.8 / 0.8 | 3.4 / 2.8 | 5.3 / 3.5 | 7.4 / 5.7 |

\* Single-lane proxied runs stalled (SCTP back-off after packets lost between the proxy and the browser; the proxy
counted none); the spike measured 5.4 MB/s for 1 lane at 50 ms. Hedging (§7.4) is what lets zip-ordered match
unordered: without it, 6 lanes at 100 ms measured 0 MB/s. The default of 6 lanes holds up. Still to do: one real
long-distance test between two machines.

Other findings:

- **One connection keeps only about 250–400 KB in flight**, no matter how fast the link is, which is why
  latency hurts so much. Striping is the main lever.
- **Chrome throws `OperationError: RTCDataChannel send queue is full` above 16 MiB buffered.** The send
  high-water mark MUST stay ≤ 12 MiB.
- A 64 MiB ack window (instead of 16 MiB) gave nothing.
- **Disk writes:** writing into OPFS with 1 lane kept up (46.9 MB/s). With 4 lanes interleaving ranges of the
  same files it fell to **31 MB/s**. Avoid many lanes writing into one file at once (§7.4).
- **Per-file cost:** about 10 ms per 4 MB file in OPFS, `close()` 5–30 ms; about 50 ms per 25 MB file. Fine for
  10,000 photos. Not yet verified for a real user folder (Chrome may scan on close).
- Chunk size: Chrome's `sctp.maxMessageSize` is 262144.

---

## 4. User flows

### 4.1 Newcomer

1. Opens `/file-transfer`. Within about a second they see **"You're Brisk Fox 🦊"** with an *Edit* link and a
   *Visible / Hidden* switch (visible by default), and a grid of other people on the page, nearest first. Peers
   on the same network carry a **"Same network"** badge.
2. Empty grid: "No one else is here yet. Open this page on the other device, or send someone your invite link."
   plus a **Copy invite link** button.

### 4.2 Connecting

1. Bob clicks Alice's tile. Tile reads "Asking Alice…" with a *Cancel* button. Others now see Alice as busy
   ("In a transfer"), greyed out and not clickable.
2. Alice sees an in-page panel (not a browser dialog): **"Brisk Fox wants to connect"** · *Accept* / *Decline*.
   When her tab is hidden, the tab title becomes "(1) Request from Brisk Fox · File Transfer". No
   `Notification` permission is used, because that is a browser prompt.
3. After Alice accepts, both see "Connecting…", then **"Connected to Brisk Fox · Direct"** (§11 for failures).
   This takes 1–3 s after the accept.
4. Invite link: `/file-transfer?to=<peerId>` opens the page with that peer highlighted at the top and a **Connect to Calm
   Otter** button. If they're offline or hidden: "Calm Otter isn't here right now."

### 4.3 Sending (either side, once connected)

1. Drop files or folders anywhere on the connected panel, or click **Choose files** (`<input type=file multiple>`).
   Both are prompt-free. Folders are only prompt-free when dropped (§9).
2. The sender sees "Waiting for Calm Otter to accept 214 files (38.4 GB)…" with *Cancel*.
3. Progress: total bar, MB/s, time remaining, files done of total, current file names, "Direct · 8 lanes".
4. Done: "Sent 214 files (38.4 GB) in 9 min 12 s · avg 69.6 MB/s".

### 4.4 Receiving

1. In-page offer card: **"Calm Otter is sending 214 files (38.4 GB)"**, expandable file list, and:
   - **Accept** (primary): saves everything as one download, `Photos from Calm Otter.zip`, which keeps folders and
     dates. No browser prompt.
   - **Save into a folder…** (secondary, Chromium desktop only, §8.3): an in-page explainer first, then the
     browser's folder picker and its "allow editing" prompt.
   - *Decline*.
2. Progress as for sending.
3. Done (zip): "Saved 214 files to your downloads as Photos from Calm Otter.zip". Done (folder): "Saved 214 files
   to *Pictures/Trip* · 3 already there were skipped".

### 4.5 Leaving

There is no browser "Leave site?" prompt (no `beforeunload` `preventDefault`). While a transfer runs, an in-page
banner says "Keep this tab open until the transfer finishes. Closing it stops the transfer." *Disconnect* asks
through `confirm()` from `src/lib/confirm.tsx` when a transfer is active.

---

## 5. Architecture

```
            Vercel                                      Browsers
┌───────────────────────────────┐        ┌──────────────┐      ┌──────────────┐
│ /file-transfer (SPA chunk)    │        │  Peer A tab  │      │  Peer B tab  │
│ public/ft-sw.js (zip stream)  │        │              │      │              │
│ api/file-transfer.ts ─► Redis  │◄─poll──┤ presence,    │      │ presence,    ├─poll─►
│   presence hash, claims,      │        │ claim,       │      │ claim,       │
│   handshake mailbox (KB)      │        │ lane 0 SDP   │      │ lane 0 SDP   │
└───────────────────────────────┘        └──────┬───────┘      └──────┬───────┘
                                                │  WebRTC, DTLS, N lanes │
                                                │  lane 0: ctrl + data   │
                                                └──── lanes 1..N-1 ──────┘
                                                   all file bytes, all
                                                   later signaling
```

Redis carries presence, the request/accept claim and **only lane 0's offer and answer**. Everything after lane 0
opens goes over the ctrl channel: extra lanes, ICE restarts, manifests, acks, cancels.

---

## 6. Server: `api/file-transfer.ts`

A single Vercel Function. Every call is a `POST` with a JSON body, so peer secrets never appear in URLs or logs.
It is self-contained, like `api/rooms.ts`: it imports only from npm.

### 6.1 Identity

- `peerId`: 16 hex characters, random, stored in `localStorage` (`toolbox.send.peer`), so invite links survive
  reloads. It is public.
- `secret`: 32 hex characters, random, stored with it. The server keeps `sha256(secret)` (first 32 hex) in the
  presence entry. Every write proves ownership with the secret. If the stored hash doesn't match, the request is
  refused with 403. A peer whose entry expired just re-registers on its next poll.
- `name`: at most 24 characters after NFC normalization, with control and bidi characters stripped (reuse the
  `cleanFileName` approach from `api/rooms.ts`). The default is a random `ADJECTIVE + ANIMAL` and emoji from the
  room lists. `emoji` MUST be one of the `ANIMALS` emojis.

### 6.2 Redis keys

All keys start with `toolbox:ft:`, all have TTLs, and none are found by SCAN or KEYS.

| Key | Type | Content | TTL |
|---|---|---|---|
| `toolbox:ft:peers` | hash | field `<peerId>` → JSON `PeerEntry`; field `claim:<targetId>` → JSON `Claim` | `EXPIRE 180` on every write |
| `toolbox:ft:sig:<pairId>:<toPeerId>` | string | one handshake message (≤ 16 KiB JSON) | `EX 60` |
| `toolbox:ft:rl:<ipHash>:<minute>` | string counter | writes per IP per minute | `EX 90` |

```ts
interface PeerEntry {
  name: string; emoji: string;
  seen: number;         // ms, last poll
  hidden: boolean;      // not listed, but keeps its claims and invite link working
  busy: boolean;        // in a connection (set by the client in its poll)
  net: string;          // 12-hex HMAC of the network (IPv4 address or IPv6 /64), never sent to clients
  ip: string;           // 12-hex HMAC of the full IP, for the per-IP cap, never sent to clients
  auth: string;         // sha256(secret), 32 hex, never sent
}
interface Claim {       // field "claim:<targetId>"
  pair: string;         // 16 hex, the handshake id
  from: string;         // requester peerId
  at: number;           // ms; refreshed by the target's polls while state is "connected"
  state: "pending" | "accepted" | "connected";
}
```

Claims are fields of the same hash, so one `HGETALL` returns everything a poll needs. Hash fields have no TTL,
so the function enforces them in logic:
- A `pending` claim expires 30 s after `at`; `accepted` after 30 s; `connected` 90 s after the target's last
  poll.
- A peer field expires 150 s after `seen`. That is more than twice the hidden-tab poll of 60 s.

Stale fields are removed with `HDEL` when a request notices them.

**Atomic claim:** use `HSETNX peers claim:<target>`. If an existing claim is stale, `HDEL` it and retry
`HSETNX` once. Only one of several racing requesters can win.

**IP hashing:** HMAC-SHA-256 keyed with env `FILE_TRANSFER_IP_SALT`. Without it in dev, use a random per-process salt;
in production without it, return 503 `no-salt`. `net` uses the IPv4 address, or the first 4 hextets of an IPv6
address (/64). Read the IP as `api/rooms.ts` `clientIp()` does.

### 6.3 Actions

Every response is JSON with `cache-control: no-store`. Errors are `{ error: <code> }` with the status shown.

| `action` | Body (besides `peer`, `secret`) | Response | Redis commands |
|---|---|---|---|
| `poll` | `name, emoji, hidden, busy` | `PollResult` | 3 (`HGETALL`, `HSET`, `EXPIRE`), +1 `HDEL` when stale fields found |
| `request` | `to` | `{ pair }` or error `busy`/`gone`/`self`/`slow-down` | rate 1–2, `HGETALL` 1, `HSETNX` 1 (+`HDEL`+`HSETNX` on stale) ≈ 4–6 |
| `respond` | `pair, accept: boolean` | `{ ok }` | rate 1–2, `HGETALL` 1, `HSET` or `HDEL` 1 ≈ 3–4 |
| `connected` | `pair` | `{ ok }` (sets claim state `connected`) | `HGETALL` 1, `HSET` 1 |
| `release` | `pair` | `{ ok }` (either side; deletes the claim) | `HGETALL` 1, `HDEL` 1 |
| `signal` | `pair, to, payload` | `{ ok }` | rate 1–2, `HGETALL` 1, `SET EX` 1 ≈ 3–4 |
| `read` | `pair` | `{ payload } \| { payload: null }` | `HGET` peer field 1 (auth), `GETDEL` 1 |
| `leave` | — | `{ ok }` (removes own field and own claims; sent with `keepalive`/`sendBeacon` on `pagehide`) | `HGETALL` 1, `HDEL` 1 |

```ts
interface PollResult {
  you: { id: string; name: string; emoji: string; hidden: boolean };
  peers: Array<{ id: string; name: string; emoji: string; busy: boolean; near: boolean; seen: number }>;
  // A claim on me (someone asked to connect), or null.
  incoming: { pair: string; from: { id: string; name: string; emoji: string }; state: Claim["state"]; at: number } | null;
  // My own request, so the requester learns accept/decline from its poll.
  outgoing: { pair: string; to: string; state: Claim["state"] | "declined" | "expired" } | null;
  limits: { pollMs: { active: number; idle: number; hidden: number } };
}
```

Rules:
- `peers` excludes me and hidden peers. `busy` is true when the peer reports busy or has a live claim. The list
  is sorted by `near` first, then by `seen`, newest first, and capped at **50 entries**.
- A declined claim is deleted. The requester sees `outgoing: null` with its `pair` gone. The client then shows
  "Calm Otter declined". To tell "declined" from "expired", keep a short field `gone:<pair>` →
  `"declined"|"expired"` for 30 s; it is written by `respond`/expiry and read by the requester's poll.
- **Mutual request:** if A requests B while B already has a pending claim on A, the server accepts it at once.
  Both see `accepted`, and the peer with the **lower `peerId`** makes the offer.
- `signal` checks that `pair` matches a live claim and that sender and `to` are its two ends. Payload is at most
  16 KiB. At most 8 `signal` writes per pair.
- **Caps:** at most **100 peer fields** in total (a new peer gets 503 `full`) and at most **6 peers per IP
  hash** (429 `too-many-here`). `request`, `respond` and `signal` share a per-IP limit of **60 per minute**.
  Polls are not rate-limited, so they cost no extra commands; the peer caps bound them.
- **Kill switch:** env `FILE_TRANSFER_DISABLED=1` makes every action return 503 `disabled` without touching Redis. The UI
  shows "File Transfer is paused right now."

### 6.4 `Kv` subset

Copy from `api/rooms.ts`: `hset`, `hgetall`, `hdel`, `expire`, `incr`, `get`. Add, with both the Upstash and the
memory implementation:
- `hsetnx(key, field, value): Promise<boolean>`
- `hget(key, field): Promise<string | null>`
- `set(key, value, seconds): Promise<void>`
- `getdel(key): Promise<string | null>`

Keep `automaticDeserialization: false`, as rooms does. Store selection mirrors `rooms()`: env
`ROOM_KV_REST_API_URL`/`TOKEN` (the same shared database), memory when not on Vercel, 503 `no-store` when
deployed without a store.

### 6.5 Client poll state machine (`src/tools/file-transfer/presence.ts`)

| State | When | Poll every |
|---|---|---|
| `active` | tab visible and the user interacted within 2 min | **3 s** |
| `idle` | visible, no interaction for 2 min | **10 s** |
| `hidden` | `document.hidden` | **60 s** (browsers throttle further; that's fine) |
| `pending` | an outgoing request is pending, or an incoming request is shown | **1 s**, for at most 60 s |
| `handshake` | between accept and lane 0 open | `poll` every 3 s, **plus `read` every 700 ms**, at most 30 s |
| `connected` | lanes open | 10 s (keeps `busy` and refreshes the claim), 60 s when hidden |
| `away` | 2 h since the last interaction | **no polling**. Send `leave`, then show "You're hidden after 2 hours away. **Be visible again**" |
| `off` | the user switched to Hidden | 10 s while the tab is visible, 60 s in a hidden tab, with `hidden: true`, so incoming invite-link requests still arrive (WP6: 60 s missed half of them, since a request expires after 30 s). No polling in `away` |

"Interaction" means `pointerdown`, `keydown`, or `visibilitychange` to visible. On `pagehide`, send `leave`.

### 6.6 Quota budget

Upstash free tier, per `README.md`: **500K commands/month**, 10 GB/month bandwidth, 250 MB data. It is shared
with the Room tool and other projects. Vercel Hobby allows about 1M function invocations a month.

| Usage | Commands |
|---|---|
| One tab, `active` | ~3,600 per hour |
| One tab, `idle` | ~1,080 per hour |
| One tab, `hidden` / `connected` hidden | ~180 per hour |
| One connection (request → lanes open) | ~100–130 |

**Target: File Transfer stays under ~150K commands/month.** For example: 30 active tab-hours (108K), 20 idle
tab-hours (22K), 100 hidden tab-hours (18K), and 50 connections (6K) add up to about 154K.

The safeguards are the tiers, the 2-hour `away` cutoff, the caps, `FILE_TRANSFER_DISABLED`, and polling only while
visible.

**Bandwidth:** `HGETALL` returns at most about 100 fields of ~200 bytes, so at most 20 KB per poll; typical use
is under 2 KB.

---

## 7. Peer to peer

### 7.1 Connections ("lanes")

- `RTCPeerConnection({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }] })`.
  No TURN.
- **Lane 0** has two negotiated channels: `ctrl` (`{ negotiated: true, id: 0, ordered: true }`, JSON text) and
  `data` (`{ negotiated: true, id: 1, ordered: true }`, `binaryType = "arraybuffer"`).
- **Lanes 1..N-1** have only `data` (`id: 1`).
- The **offerer** is the requester (or the lower `peerId` on a mutual request). It creates every offer, ICE
  restarts included, as WebDrop's `PeerSession` does, so there is no glare.
- **Non-trickle ICE:** `setLocalDescription()`, then wait for `iceGatheringState === "complete"` or **3 s**,
  then send `localDescription.sdp` whole.
- Lane 0's offer and answer go through `api/file-transfer.ts` (`signal`/`read`). Lanes 1..N-1 are negotiated over `ctrl`
  (`lane-offer` / `lane-answer`), and so are ICE restarts (`restart-offer` / `restart-answer`).
- **Lane count:** `N = tuning.lanes` (**default 6**, decided; see §18). All extra lanes are opened in parallel right after
  `hello`. A transfer may start as soon as lane 0 is open and uses lanes as they open.
- **Connect timeout:** lane 0 not open after **15 s** → `failed-direct` (§11). An extra lane not open after 15 s
  is dropped quietly.
- **Lost lane:** ICE `disconnected` → ICE restart over `ctrl` after 3 s. `failed` for 20 s → close the lane and
  requeue its work (§7.5). Losing lane 0 ends the session (§10).
- **Path type** for the UI: read `getStats()` for the selected candidate pair. `host` on both sides →
  "Direct · same network"; otherwise "Direct".

### 7.2 Control messages (`ctrl`, JSON, one object per message, ≤ 64 KiB)

```ts
type Ctrl =
  | { t: "hello"; v: 1; name: string; emoji: string; caps: { folder: boolean; zip: boolean; memoryMax: number; lanes: number } }
  | { t: "lane-offer"; lane: number; sdp: string } | { t: "lane-answer"; lane: number; sdp: string }
  | { t: "restart-offer"; lane: number; sdp: string } | { t: "restart-answer"; lane: number; sdp: string }
  | { t: "lane-close"; lane: number }
  // A batch is one "send" of many files. `dir` is implicit: the sender owns the batch id it made.
  | { t: "manifest"; batch: number; part: number; last: boolean; files: ManifestFile[]; count: number; total: number }
  | { t: "accept"; batch: number; mode: "zip" | "folder" | "memory"; skip: number[] }
  | { t: "decline"; batch: number; reason: "declined" | "unsupported" | "too-big" }
  | { t: "file-done"; batch: number; file: number }        // receiver: file fully persisted
  | { t: "done"; batch: number }                           // receiver: everything persisted
  | { t: "cancel"; batch: number; by: "sender" | "receiver"; reason: "cancelled" | "error" | "protocol" }
  | { t: "bye" };
interface ManifestFile { i: number; path: string; size: number; mtime: number } // path: "Trip/Day 1/IMG_0001.CR3"
```

- A manifest bigger than 64 KiB is split into parts of about 500 files, with `last: true` on the final part.
  `count`/`total` describe the whole batch.
- **Batch ids:** each side counts its own batches from 1. Frames carry `batch` and a direction bit (§7.3), so A's
  batch 1 and B's batch 1 don't collide.
- **One active batch per direction.** A and B may each send at the same time; their frames share lanes.

### 7.3 Binary frames (`data` channels)

Sender → receiver. 16-byte header, big-endian `DataView`, then the payload:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | version = 1 |
| 1 | 1 | flags: bit 0 = sender is the offerer (direction), bit 1 = last frame of its range |
| 2 | 2 | batch (u16) |
| 4 | 4 | file index (u32) |
| 8 | 8 | byte offset in the file (u64; `getBigUint64` → `Number`, must be ≤ 2^53) |

Payload: `1 .. chunk - 16` bytes, where `chunk = min(tuning.chunk, sctp.maxMessageSize) = 256 KiB`. The session
exposes lane 0's `RTCSctpTransport.maxMessageSize` as `PeerSession.maxMessageSize` (WP6).

**Acks** go receiver → sender on the **same lane's** `data` channel as text, so acks for that lane's bytes ride
the same path:

```ts
type Ack = { a: number /* batch */, d: 0 | 1 /* direction bit of the batch */, w: number /* bytes from this lane persisted (cumulative) */, c?: number /* zip mode: contiguous stream bytes persisted */ };
```

The receiver acks every `tuning.ackEvery` bytes persisted, and at the end of each range.

**Validation (receiver):** the batch must be the active incoming one, the file index must be in the manifest and
not skipped, and `offset + len ≤ size`. Duplicates are allowed, because ranges get requeued: folder writes are
idempotent, and zip mode drops bytes below the contiguous mark. Anything else sends
`cancel { reason: "protocol" }` and ends the batch. Bytes queued but not yet persisted MUST stay below
`lanes × (laneWindow + chunk)`, or the batch is cancelled ("sender ignored flow control").

### 7.4 Scheduler (`engine/scheduler.ts`)

Work is a list of **ranges** `{ file, start, end }`, built in manifest order with skipped files removed. Each lane
runs a loop: **pull the next range → stream it → pull again**. The sink decides the mode:

**Unordered sinks (folder, test):**
- Files ≤ `rangeMax` (32 MiB) are **one range**, so each small file has a single writer.
- Bigger files are split into 32 MiB ranges, but **at most `maxWritersPerFile = 2` lanes may hold ranges of the
  same file at once**. A lane that would be a third writer takes the next file instead. This guards against the
  spike's 31 MB/s slowdown; tune it in the benchmark.

**Ordered sink (zip):**
- The batch is treated as **one byte stream**: the files concatenated in manifest order, with global offsets.
  It is cut into `zipRange` (1 MiB) ranges, handed to lanes as they ask.
- A lane MUST NOT start a range whose end exceeds `ackedContiguous + reorderWindow` (64 MiB). `ackedContiguous`
  comes from the acks' `c` field. The receiver holds out-of-order ranges in a reorder buffer of at most
  `reorderWindow` bytes and feeds the zip strictly in order.
- One slow lane stalls the others (head-of-line). That is the price of a prompt-free single download; measure it.
- **Hedging (WP6).** The WP6 benchmark found SCTP associations that stop for 10–25 s after burst losses
  (retransmission back-off), which froze the whole zip stream. So when `ackedContiguous` hasn't moved for
  `hedgeMs` (1 s) and no lane holding the byte at the mark has been acked in that time, those lanes' unacked
  ranges (from the mark on) are requeued as well; other lanes deliver them and the receiver drops whichever copy
  arrives second. At 100 ms RTT this took zip mode from a stall (0 MB/s) to the proxy's ceiling.

**Per lane, the send loop** is adapted from WebDrop `Outgoing.run`:

```
for each range pulled:
  for each chunk in range (read ahead tuning.readBlock bytes with File.slice().arrayBuffer()):
    while dc.bufferedAmount > highWater: await "bufferedamountlow" (threshold = lowWater)
    while sentOnLane - ackedOnLane > laneWindow: await next ack
    dc.send(frame)              // header + payload; reuse one frame buffer per lane
```

### 7.5 Constants (`src/tools/file-transfer/tuning.ts`, mutable for the benchmark)

| Name | Value | Why |
|---|---|---|
| `lanes` | 6 (max 8) | §3: big gains to 4–8 lanes on long links; 8 lanes cost nothing locally |
| `chunk` | 256 KiB incl. header | Chrome's max message size; WebDrop's fastest |
| `highWater` | 8 MiB | Chrome throws above 16 MiB; **never above 12 MiB** |
| `lowWater` | 2 MiB | WebDrop default |
| `laneWindow` | 16 MiB unacked per lane | 64 MiB gave nothing |
| `ackEvery` | 1 MiB | WebDrop default |
| `readBlock` | 4 MiB | read-ahead per lane |
| `rangeMax` | 32 MiB | unordered sinks |
| `maxWritersPerFile` | 2 | §3 OPFS slowdown |
| `zipRange` | 1 MiB | ordered sink |
| `reorderWindow` | 64 MiB | receiver memory bound in zip mode |
| `coalesce` | 4 MiB | folder sink: join contiguous chunks before `write()` |
| `maxOpenFiles` | 16 | folder sink: open writables at once |
| `memoryMax` | 1 GiB | memory fallback cap |
| `hedgeMs` | 1 s | ordered sink: re-offer the head range when the contiguous mark stalls this long (WP6, §7.4) |

**Requeue on lane loss:** a lane's ranges are sent in order, so its cumulative `w` ack tells which ranges are
complete. The rest go back to the front of the queue, from the first unacked byte. In zip mode they go back by
global offset.

**Progress:** a `RateMeter` (copy from WebDrop) over persisted bytes, from acks on the sender side and sink
writes on the receiver side. React state updates **at most 4 times a second**. Never render per chunk.

**Wake lock:** `navigator.wakeLock.request("screen")` while a batch is active and the tab is visible. Re-acquire
on `visibilitychange`. Ignore it where unsupported.

---

## 8. Receive sinks

```ts
interface ReceiveSink {
  readonly mode: "zip" | "folder" | "memory" | "test";
  readonly ordered: boolean;   // zip: true
  /** Called after accept; folder mode returns files it already has (same relative path and size). */
  begin(files: ManifestFile[]): Promise<{ skip: number[] }>;
  /** Unordered sinks: any offset. Ordered sinks: called strictly in stream order by the reorder buffer. */
  write(file: number, offset: number, data: Uint8Array): Promise<void>;
  finishFile(file: number): Promise<void>;
  finish(): Promise<{ location: string }>;   // for the done message
  abort(reason: string): Promise<void>;
}
```

### 8.1 Path safety (`paths.ts`, used by every sink)

- Split on `/` and `\`. Drop empty, `.` and `..` segments.
- Strip control and bidi characters (as `cleanFileName` in `api/rooms.ts`) and replace `<>:"|?*` with `_`.
- Rename Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without an extension) to
  `_CON` and so on. Trim trailing dots and spaces.
- Each segment is at most 120 characters; the whole path at most 400.
- Duplicate paths within a batch get ` (2)`, ` (3)` and so on before the extension.
- Applied on the **receiver**, whatever the sender claims.

### 8.2 Zip stream, the default and prompt-free (`sinks/zipStream.ts` + `public/ft-sw.js`)

One download, `Photos from <peer name>.zip`, stored (method 0, no compression) and ZIP64. It is written through
`ZipWriter.addStream(path, size)` from `src/lib/zipWriter.ts`, which already computes CRC32 as data arrives and
writes data descriptors and ZIP64 records.

- **Service worker** `public/ft-sw.js`: plain JS, not bundled, served at `/ft-sw.js`, registered with
  `scope: "/file-transfer/dl/"`. On `fetch` for `/file-transfer/dl/<id>/<name>.zip`, it answers with
  `new Response(readableStream, { headers })`:
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename*=UTF-8''…` (reuse `attachment()` from `api/rooms.ts` as a
    reference)
  - an exact `Content-Length` (below)
  - `Cache-Control: no-store`
- **Page ↔ service worker:** the page posts `{ type: "open", id, name, length, port }` with a `MessageChannel`,
  then starts the download by setting a hidden `<iframe>`'s `src` to the URL. Chunks go page → service worker
  with ownership transferred (`port.postMessage(buf, [buf])`). Backpressure is a credit scheme: the service
  worker's `pull()` posts `{ want: bytes }` and the page sends at most that much.
- The page pings every 10 s, because Firefox stops idle service workers.
- **Download-started check:** the service worker posts `{ type: "started", id }` when its `fetch` handler runs.
  If that hasn't arrived within **5 s**, treat the browser as unsupported. If nothing has been written yet, fall
  back to the memory sink; otherwise fail with `zip-unsupported`.
- **Exact length:** `zipSize(files)` in `sinks/zipSize.ts` is a pure function computing the archive's byte
  length from paths and sizes. It MUST match `ZipWriter`'s output exactly: unit test it against real output,
  including entries ≥ 4 GiB (`addStream` adds a ZIP64 extra) and offsets ≥ 4 GiB. If they disagree, omit
  `Content-Length` rather than send a wrong one.
- **Modified times (shared-file edit):** `ZipWriter` writes a fixed 1980 date today. Add an optional
  `modified?: number` (ms) to `addStream` that writes the DOS date/time and an extended-timestamp extra field
  `0x5455` (UTC mtime), keeping existing callers byte-identical. Photos keep their dates when unzipped; the folder
  sink can't do that (§8.3). Update `zipSize` to match.
- **CRC32 speed:** the existing table CRC runs byte by byte on the main thread. Measure it at 60+ MB/s. If it
  costs throughput, move zip writing to a worker or use a slice-by-8 table. Both stay inside the tool, except a
  faster `crc32` in `zipWriter.ts`, which is a flagged shared edit.
- Zip mode **cannot resume**: the download stream is gone once the connection breaks (§10).
- The **vercel.json SPA rewrite** must not swallow the service worker or its URLs. Static files win over rewrites
  on Vercel, so `/ft-sw.js` is served as-is. `/file-transfer/dl/*` is only ever answered by the service worker.
  Optionally add `Cache-Control: no-cache` for `/ft-sw.js` (**shared file** `vercel.json`).

### 8.3 Folder, opt-in, Chromium desktop only (`sinks/folder.ts`)

The fastest mode: no unzip, and identical files are skipped. **It causes browser prompts:** the folder picker,
then Chrome's "Let site edit files?". So:

- **Show an in-page explainer first:** "Your browser will ask you to pick a folder, then ask permission to save
  files into it. File Transfer only writes the files Calm Otter is sending." *Continue* / *Back*.
- Then `showDirectoryPicker({ mode: "readwrite", id: "file-transfer-receive" })`.
- Offer it only when `typeof showDirectoryPicker === "function"` and the device isn't touch-only.
- `begin()`: for each file, if the sanitized relative path exists with the same size, add it to `skip`.
  Otherwise, if the name exists, write `name (1).ext`.
- Writes: one `createWritable({ keepExistingData: false })` per file, opened lazily, at most `maxOpenFiles` at a
  time (WP6: a soft limit; while a lane waits for the disk, waiting files get a writable at once, otherwise a
  lane could wait for a file that waits for a slot held by a file whose missing bytes are behind that lane). Each lane coalesces contiguous chunks into `coalesce` buffers, then
  `write({ type: "write", position, data })`. Writes are serialized per file through a promise chain. `close()`
  runs when all ranges of a file are persisted, then `file-done` is sent.
- **Limitation (show it in the UI's details):** the browser can't set file modified times. Received files are
  dated when they were saved. EXIF dates inside photos are unchanged.
- **To verify by hand** (headless tests can't drive the picker): `close()` cost on a real folder with 1,000
  photos, because Chrome may run safety checks.

### 8.4 Memory fallback (`sinks/memory.ts`)

For browsers where the zip stream fails: build the same zip into a `Blob` in memory, up to `memoryMax` (1 GiB),
then trigger **one** download with an object URL. A bigger batch is declined with `too-big`. The sender sees
"Calm Otter's browser can't receive this much. Ask them to use Chrome, Edge or Firefox on a computer."

### 8.5 Test sink (`sinks/test.ts`)

Selected when `window.__sendTestSink === true` (set by Playwright's `addInitScript`). It keeps a running SHA-256
per file (in chunks, with a small JS SHA-256 or by hashing on `finishFile` from kept chunks for small test files)
and exposes `window.__sendReceived`: `{ path, size, sha256 }[]`. It is unordered by default; with
`__sendTestSinkOrdered` it is ordered, to exercise the zip path's scheduler.

---

## 9. Prompt policy (browser-owned UI)

The site owner finds browser prompts tacky. This table is binding.

| Browser UI | Triggered by | Policy |
|---|---|---|
| `window.confirm/alert/prompt` | — | **Never.** Use `src/lib/confirm.tsx` and in-page panels |
| "Leave site?" | `beforeunload` `preventDefault` | **Never.** Use the in-page banner (§4.5) |
| Notification permission | `Notification.requestPermission` | **Never.** Use the tab title badge |
| "This site is trying to download multiple files" | several automatic downloads | **Avoid.** Exactly one download per batch (zip or memory) |
| Save As / folder picker + "Let site edit files?" | `showSaveFilePicker`, `showDirectoryPicker` | **Opt-in only** (folder mode), after an in-page explainer |
| "Upload N files to this site?" | `<input webkitdirectory>` | **Avoid.** Folders come in by drag and drop (`webkitGetAsEntry`, no prompt). A **Choose folder** button exists only for touch devices with no drag and drop, behind an in-page explainer |
| "Let site view files?" | `showDirectoryPicker({ mode: "read" })` | **Don't use** for sending |
| Clipboard | `navigator.clipboard.writeText` in a click | Fine (no prompt). Never `read()` |
| Wake lock | `navigator.wakeLock.request` | Fine (no prompt) |

---

## 10. Failure and resume

| Event | Behaviour |
|---|---|
| Lane 1..N-1 lost | Requeue its unacked ranges; the transfer continues on the remaining lanes; the UI lane count drops |
| ICE `disconnected` on lane 0 | ICE restart over `ctrl` (WebDrop `PeerSession.onIceState`); the transfer pauses ("Reconnecting…") |
| Lane 0 lost for 20 s, or `bye`, or the tab closes | The session ends. Batches end as **interrupted**. Both sides show "Connection lost". The claim is released |
| Interrupted, folder mode | "Send again" re-sends the same batch after reconnecting; `begin()` skips files already complete (same path and size). Partial files restart from 0 |
| Interrupted, zip mode | The download is incomplete (with `Content-Length`, the browser marks it failed). "Send again" starts a fresh zip. Copy: "The download stopped partway. Send again to start a new one." |
| Receiver cancels / sender cancels | `cancel` message; sinks `abort()`; other batches and the connection stay up |
| Sink error (disk full, permission revoked) | `cancel { reason: "error" }`; message from §12 |
| Protocol violation | `cancel { reason: "protocol" }` and `bye`; "Something went wrong with the connection." |

No `localStorage`/IndexedDB persistence of transfer state in v1.

---

## 11. Connection failures

| Code | When | Copy |
|---|---|---|
| `declined` | the target declined | "Calm Otter declined." |
| `expired` | no answer in 30 s | "Calm Otter didn't answer." |
| `busy` | already in a transfer | "Calm Otter is in another transfer." |
| `failed-direct` | lane 0 not open in 15 s | "Couldn't connect directly. One of you is probably on a network that blocks this, which is common on mobile data, work and school networks. Try another network, such as home Wi-Fi." |
| `signal-error` | API errors during the handshake | "Couldn't reach the server. Check your connection and try again." |
| `disabled` | `FILE_TRANSFER_DISABLED` | "File Transfer is paused right now." |
| `full` / `too-many-here` | caps | "Too many people are on File Transfer right now. Try again in a few minutes." / "Too many devices from your network are here. Close File Transfer on one of them." |

---

## 12. UI

Files: `index.tsx` (page shell, routing by state), `Peers.tsx` (grid), `Connected.tsx` (send and receive panels),
`OfferCard.tsx`, `ProgressView.tsx`, `Send.module.css` (with the copied lobby tile styles).

Use the shared kit (`Card`, `Button`, `Note`, `Progress`, `FileDrop`, `Chip`) and tokens. Add an Icon entry
`send` only if needed (**shared file** `src/lib/Icon.tsx`).

Screens and copy:
- **Header:** h1 "Blazing Fast File Transfer"; lead "Send photos and videos straight to another device. Nothing is uploaded: files
  go directly between your browsers."
- **Me bar:** `🦊 You're Brisk Fox` · *Edit name* (inline input, Enter saves) · switch *Visible* / *Hidden*
  (when hidden: "Others can't see you. People with your invite link can still connect.") · *Copy invite link*
  ("Copied" for 2 s).
- **Grid tiles:** emoji, name, "Same network" badge, "here now" or "seen 1 min ago". Busy tiles are greyed with
  "In a transfer", `aria-disabled`. Pending tile: "Asking…" + *Cancel*.
- **Incoming request panel:** pinned at the top, focus moves to it: "**Brisk Fox** wants to connect" ·
  *Accept* · *Decline*, plus a countdown bar for the 30 s.
- **Connected panel:** "Connected to 🦦 Calm Otter · Direct · 6 lanes" · *Disconnect*. A large drop zone: "Drop
  photos, videos or folders here" · *Choose files*. The receive card or the outgoing batch shows below.
- **Offer card (receiver):** "Calm Otter is sending 214 files · 38.4 GB" · *Show files* · **Accept** ("Saves as
  one .zip in your downloads") · *Save into a folder…* (Chromium desktop) · *Decline*. Explainer text before
  folder mode as in §8.3. Unsupported browser and over `memoryMax`: decline automatically with `too-big`, and
  explain on both sides.
- **Progress:** big percentage, `Progress` bar, "38.4 GB of 38.4 GB · 71.2 MB/s · 2 min left", "212 of 214
  files", the current file names (at most 3), *Cancel* (asks through `confirm()`: "Stop sending to Calm Otter?",
  *Stop*, danger).
- **Done:** a success `Note` with totals, average speed, the location (zip filename or folder name), and skipped
  count.
- **Mobile layout:** single column; the drop zone becomes the *Choose files* button.

Accessibility: tiles are buttons; the request panel is `role="alertdialog"`; progress uses `aria-live="polite"`
at most every 5 s.

---

## 13. Security and abuse

- **Wire:** DTLS (mandatory in WebRTC) between the two browsers. The signaling server *could* swap SDP and sit in
  the middle, because there's no verification code. This is accepted by decision.
- **Exposure:** the presence list shows only name, emoji, busy, near and seen. IPs and network hashes never
  reach clients. Connecting reveals each side's IP addresses to the other, which is inherent to WebRTC. Mention
  it in the page's small print: "Connecting shares your network address with that person."
- **Receiver safety:** nothing is saved before *Accept*. Paths are sanitized (§8.1). Memory is bounded (§7.3).
  Frames are validated. Files are offered only as downloads or written inside the chosen folder.
- **Server abuse:** request validation (id regexes as in `api/rooms.ts`), caps, per-IP rate limits on writes,
  16 KiB signal payloads, TTLs on everything, and the `FILE_TRANSFER_DISABLED` kill switch. Any public endpoint can be used
  to burn quota. The Room tool has the same exposure; watch the Upstash console.
- **Public repo:** no secrets in code; `FILE_TRANSFER_IP_SALT` lives only in the Vercel env.

---

## 14. Browser support (v1)

| Browser | Send | Receive: zip (default) | Receive: folder | Notes |
|---|---|---|---|---|
| Chrome / Edge desktop | ✓ | ✓ | ✓ (opt-in, prompts) | Full speed target |
| Firefox desktop | ✓ | ✓ (service worker ping) | — | WebRTC speed unmeasured (usrsctp) |
| Safari macOS | ✓ | unverified → started-check → memory fallback ≤ 1 GiB | — | Test on a real Mac |
| iOS / iPadOS (all browsers are WebKit) | ✓ while the screen is on and the tab is in front | as Safari | — | The OS suspends background tabs; warn |
| Chrome Android | ✓ | likely ✓ | feature-detect | Keep the screen on |

Feature detection only, never user-agent sniffing:
- Zip: `"serviceWorker" in navigator && "ReadableStream" in window` plus the started-check.
- Folder: `typeof showDirectoryPicker === "function" && matchMedia("(pointer: fine)").matches`.
- Wake lock: `"wakeLock" in navigator`.

---

## 15. Repo layout

New files:

```
api/file-transfer.ts                         Vercel Function (self-contained; copied Kv subset)
public/ft-sw.js                   zip streaming service worker (plain JS)
src/tools/file-transfer/index.tsx            default export: the page
src/tools/file-transfer/Peers.tsx, Connected.tsx, OfferCard.tsx, ProgressView.tsx, Send.module.css
src/tools/file-transfer/types.ts             shared contracts: Ctrl, Ack, ManifestFile, ReceiveSink, Signaling, DataChannelLike
src/tools/file-transfer/client.ts            api/file-transfer.ts calls (Signaling implementation)
src/tools/file-transfer/presence.ts          poll state machine (§6.5)
src/tools/file-transfer/rtc/lanes.ts         lane creation, in-band negotiation, ICE restart, path type
src/tools/file-transfer/engine/frame.ts      frame + ack codec
src/tools/file-transfer/engine/scheduler.ts  ranges, unordered/ordered policies, requeue
src/tools/file-transfer/engine/sender.ts     per-lane send loops, read-ahead, backpressure
src/tools/file-transfer/engine/receiver.ts   validation, reorder buffer, acks, progress
src/tools/file-transfer/engine/meter.ts      RateMeter
src/tools/file-transfer/sinks/zipStream.ts, zipSize.ts, folder.ts, memory.ts, test.ts, paths.ts
src/tools/file-transfer/collect.ts           drag-and-drop folder traversal + file input (copied from unzip/create/collect.ts)
src/tools/file-transfer/tuning.ts
src/tools/file-transfer/*.test.ts            unit tests (vitest only picks up src/**/*.test.ts)
e2e/file-transfer.spec.ts
scripts/file-transfer-bench/                 benchmark harness (§16.3)
docs/file-transfer/SPEC.md                   this file
```

**Shared files touched.** Say so in the PR, as CLAUDE.md requires.
- `src/tools/registry.ts`: one entry at the end (`id: "file-transfer"`, `path: "/file-transfer"`, `title: "Blazing Fast File Transfer"`, icon,
  tags `["Files", "P2P"]`).
- `scripts/api-dev.ts`: serve `/api/file-transfer`.
- `src/lib/zipWriter.ts`: optional `modified` on `addStream` (existing output byte-identical; existing tests
  must pass); maybe a faster `crc32`.
- `README.md`: tool table row plus a "How File Transfer works" section, including the quota numbers.
- Possibly `vercel.json` (`/ft-sw.js` cache header) and `src/lib/Icon.tsx` (`send` icon).
- **No new dependencies.** If a test needs SHA-256 over chunks, use `crypto.subtle` per file in the test sink.

---

## 16. Testing

### 16.1 Unit (vitest, `src/tools/file-transfer/*.test.ts`)

- **`api/file-transfer.ts` with `memoryKv`** (pattern: `src/tools/room/server.test.ts`): registration and auth; tiers
  don't matter server-side; list filtering (hidden, self, busy, near, sort, cap 50); staleness; atomic claim races
  (two requesters → one wins); stale claim takeover; mutual request; respond accept/decline and `gone:` markers;
  signal pair checks, size limit and count limit; `read` with `GETDEL`; caps and rate limits; `FILE_TRANSFER_DISABLED`;
  missing salt in production. Count commands per action against the §6.3 table with a counting `Kv` wrapper.
- **frame.ts:** header round trip, u64 offsets above 4 GiB, rejects.
- **scheduler.ts:** small files are single ranges; the ≤ 2 writers per big file rule; ordered mode never exceeds
  `reorderWindow`; requeue after lane loss, partial ranges included.
- **sender/receiver** over fake `DataChannelLike` pairs (in-memory, with configurable `bufferedAmount` behavior,
  delay and drops of whole lanes): every byte arrives exactly once in the sink; backpressure holds;
  flow-control violation is detected; two directions at once.
- **zipSize** equals `ZipWriter` output for many shapes, including ZIP64; the output unzips with the repo's
  `zipReader.ts` (CRCs checked).
- **paths.ts:** traversal, reserved names, bidi, duplicates, lengths.

### 16.2 End to end (`e2e/file-transfer.spec.ts`, headless Edge, your own `E2E_PORT`)

- Two contexts → two pages on `/file-transfer`, with `addInitScript(() => { window.__sendTestSink = true })` on the
  receiver. If host candidates are hidden behind mDNS in headless runs, launch with
  `--disable-features=WebRtcHideLocalIpsWithMdns` in a project override inside the spec (don't change
  `playwright.config.ts`).
- Flows: presence shows each other; request → accept → connected; send 30 generated files (0 B, 1 B, 255 KiB,
  33 MiB, 5 MiB × n) from nested folders via `setInputFiles` → hashes match; decline; cancel mid-transfer; busy
  tile greyed for a third page; hidden toggle; invite link; zip mode in Chromium via Playwright's `download`
  event (parse with `zipReader.ts` and compare hashes).
- No console errors (pattern from `e2e/pdf-txt.spec.ts`).

### 16.3 Benchmark (`scripts/file-transfer-bench/`)

Port the spike harness: two persistent Edge profiles (separate processes, headless), signaling through Node, and a
**UDP impairment proxy**. For each lane, a `dgram` socket stands in for the offerer's host candidate: the answerer
is given only that candidate, and the offerer learns the answerer as peer-reflexive. The proxy adds one-way delay
of rtt/2, random loss, a shared per-direction token-bucket rate cap and a tail-drop buffer.

Matrix: lanes {1, 2, 4, 6, 8} × RTT {0, 20, 50, 100 ms} × loss {0, 0.1%} × sink {discard, folder-like OPFS,
ordered}. Record MB/s to `scripts/file-transfer-bench/results/<date>.md`.

As built (WP6): `node scripts/file-transfer-bench/bench.ts` drives the real `rtc/lanes.ts` + `engine/engine.ts`
(served by Vite from `bench.html`/`page.ts`) for links {direct, 20/50/100 ms at 1 Gbit/s, 50 ms + 0.1% loss} ×
lanes {1, 4, 6, 8} × {unordered discard sink, zip-ordered into `ZipWriter`}, 10 s steady state each after a 3 s
warm-up, about 12 minutes in all. The answerer's `RTCPeerConnection` is wrapped so every lane, including those
negotiated over `ctrl`, goes through the proxy. Sources are virtual in-memory files; OPFS writes were not
repeated (the spike's numbers in §3 stand).

The proxy caps at about 32 MB/s on Node, so also run **one real long-distance test** before tuning the defaults:
two machines, different networks.

---

## 17. Work packages

Interfaces live in `src/tools/file-transfer/types.ts`. **WP0 lands first** and the others build on it in parallel, each
agent in its own worktree and branch, merged in order WP1 → WP2/WP3/WP4 → WP5 → WP6.

| WP | Scope | Depends on | Done when |
|---|---|---|---|
| WP0 | `types.ts`, `tuning.ts`, registry entry with a placeholder page | — | typecheck passes |
| WP1 | `api/file-transfer.ts`, `scripts/api-dev.ts` route, `client.ts`, `presence.ts`, server tests | WP0 | §16.1 server tests |
| WP2 | `engine/*` with fakes | WP0 | §16.1 engine tests |
| WP3 | `sinks/*`, `public/ft-sw.js`, `zipWriter.ts` `modified`, `zipSize` | WP0 | sink tests; zip verified with `zipReader.ts` |
| WP4 | `rtc/lanes.ts` (lane 0 via `Signaling`, lanes 1..N via `ctrl`, ICE restart, path type) | WP0 (WP1 for real use) | two-page smoke in e2e |
| WP5 | UI (all screens and copy in §4, §11, §12) against mocked `Signaling`/engine | WP0 | screenshots at 1100 px and 390 px |
| WP6 | Integration, `e2e/file-transfer.spec.ts`, `scripts/file-transfer-bench/`, README, tuning from bench results | all | all repo checks + e2e + bench table (done; see §3) |

Repo checks before reporting: `npm run typecheck`, `npm run check`, `npm test`, `npx vite build`,
`E2E_PORT=<port> npx playwright test`.

---

## 18. Decisions (made by the site owner on 2026-11-27)

1. **Default receive mode: the prompt-free streamed zip** (§8.2), in every browser. "Save into a folder…" stays an
   opt-in on Chromium desktop, behind the in-page explanation.
2. **Name and path: "Blazing Fast File Transfer" at `/file-transfer`.** Tool id and folder `file-transfer`, function
   `api/file-transfer.ts`, Redis prefix `toolbox:ft:`, service worker `public/ft-sw.js`.
3. **Default lane count: 6** (max 8). The WP6 benchmark and one real long-distance test still run, to report numbers
   and catch regressions, not to choose the default. Adaptive lane counts are out of scope for v1.
4. **No TURN relay.** Not in v1 and not planned. Peers that can't connect directly get the clear message in §11.
5. **Usage guard: the `FILE_TRANSFER_DISABLED` kill switch plus watching the Upstash console.** No daily command
   counter.
6. **iOS: the in-memory fallback, up to 1 GiB** (`memoryMax`). No share-sheet path in v1.
7. **Folder mode stays opt-in until it is verified.** Before folder mode could become a default anywhere, someone must
   run the manual check of write cost into a real folder (1,000 photos, timing `createWritable` and `close()` per
   file) and record the result here. Until then, the default stays the zip stream (decision 1).
