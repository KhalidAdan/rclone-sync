# Decision: AAX player + pull-based streaming, on culvert

**Status:** Decided (scope + posture). Not yet implemented — awaiting explicit go-ahead per repo convention.
**Date:** 2026-08-29
**Owner:** Khalid

This records two settled decisions and the guardrails around them. It is a
decision doc, not an implementation plan; the staged scope below is deliberately
high-level so the eventual build doc can refine it.

---

## 1. Context

The app currently decodes AAX → M4B with an `ffmpeg -c copy` remux
([decoder.server.ts](../app/lib/decoder.server.ts)), archives the **DRM'd AAX
master** to B2, and serves decoded M4Bs transiently from staging. Two gaps drove
this decision:

- **The decoded M4B is never in B2** (only the AAX master is), so "stream
  playback from B2" is impossible with the current data layout — see
  [architecture-audit.md](architecture-audit.md) and
  [features.md](features.md).
- culvert is used in exactly two places today (upload pipe, download-all zip).
  The audit flags random-access Range streaming out of B2 as the natural next
  culvert use case, using `ZipSeekable`'s pattern as the mental model.

Separately: the software is single-user today but may host a second user (a
family member) bringing **their own** Audible activation bytes for **their own**
purchased books.

## 2. What an AAX player actually is

AAX is an MP4 container with AAC audio where each sample is AES-128-CBC encrypted
(the `aavd` scheme). The key/IV derive from the account's activation bytes via
SHA-1 rounds — the same public algorithm ffmpeg's `-activation_bytes` already
invokes in our pipeline. The crypto is small; the real work is MP4 box parsing
(`moov` → `stts`/`stsc`/`stsz`/`stco` sample tables → "sample N is at byte offset
X, length Y"). MP4 is a **random-access** format: a player reads the index, then
pulls exactly the byte ranges the playhead needs. That is a *pull* model, which
is why this is a strong culvert fit rather than a linear-stream fit.

## 3. Decision A — build it, on a new `Seekable` primitive

**Decided.** Build AAX playback, structured around a small random-access
interface rather than a one-off route:

```ts
interface Seekable {
  size(): Promise<number>;
  read(offset: number, length: number): Source<Uint8Array>;
}
```

`Seekable` is backed interchangeably by a local file handle, an HTTP Range
request, or rclone serving B2. Proposed layering (each independently useful and
testable):

- **`@culvert/seek`** (or folded into `stream`) — the `Seekable` interface +
  local-file and HTTP-Range backings.
- **`@culvert/mp4`** — box reader over a `Seekable`. Pure parsing, no crypto.
- **`@culvert/aax`** — activation-bytes key derivation + a per-sample decrypt
  `Transform<Uint8Array, Uint8Array>`.

Rationale: `Seekable` is the reusable gateway. Once it exists, `openZip` over
Range, remote metadata reads, and resumable backups all reuse it — the AAX
player is simply its second consumer, which is where the abstraction earns its
place.

### Staged scope (each stage ships value even if we stop there)

1. **v1 — `@culvert/mp4` reader over `Seekable`.** Pull only the `moov` atom from
   B2 to read metadata / chapters / cover. Zero crypto, zero playback state
   machine. Immediately useful; de-risks the parser.
2. **v2 — `@culvert/aax` decrypt transform + a server route** that streams a
   decrypt-on-the-fly M4B, so the existing player v2 works against AAX masters
   in B2 with nothing materialized on disk. This is what dissolves the
   "M4B-not-in-B2" gap: the archived AAX becomes directly playable.
3. **v3 — fully client-side.** WebCrypto + Range requests + MediaSource; the
   server becomes a dumb byte server.

### Honest cost notes (so the build doc plans realistically)

- A TS player buys **no conversion speedup** — the pipeline is already `-c copy`
  (remux, not transcode). What it buys is direct-from-B2 playback with nothing
  on disk.
- The hard ~60% is the **playback sink, not the decryption.** Browsers can't play
  raw AAC frames; v3 needs an MP4 *writer* to remux into fragmented MP4 for MSE,
  plus MSE state-machine work. Decryption itself is the easy part.

## 4. Decision B — multi-user is allowed, bring-your-own-bytes only

**Decided.** A second user with their **own** activation bytes decrypting their
**own** purchased books is an acceptable posture. It is materially the same
position as today's single user, multiplied — not a new category of risk.

### The rule that governs everything

**Each account decrypts only what that account bought.** The software is a
convenience wrapper over something each user could do themselves with one ffmpeg
command; it is a *tool*, not a service granting access.

### Guardrails (these define the line)

- **Self-hosted, invite-only, bring-your-own-activation-bytes.** Stay on the
  *tool* side of DMCA §1201, not the *service* side. Do **not** turn this into a
  public/hosted decryption endpoint for strangers — that is the posture shift
  that actually gets enforced.
- **No cross-account file flow.** Never keep one user's decrypted books playable
  by another; never use one account's bytes against another account's files.
- **Prefer users proving they hold their own bytes** over the software deriving
  bytes for arbitrary files. This is *more* defensible than the checksum →
  rainbow-table activation-bytes lookup floated in
  [product-review.md](product-review.md); that idea is shelved under this
  decision.

_Not legal advice; this is the team's risk posture, not a legal opinion._

### Design implications

1. **Per-user activation bytes, not the global env var.** Today
   `ACTIVATION_BYTES` is a single env secret
   ([env.server.ts:18](../app/lib/env.server.ts:18)) that implicitly assumes one
   account. Multi-user requires bytes stored per user (or per file), supplied by
   each user.
2. **Treat activation bytes as a credential.** Per-user row, not shared config,
   **never logged.** Low-sensitivity relative to a password, but still a
   per-account secret.

## 5. Adjacent pull-based directions (noted, not scheduled)

Same `Seekable` primitive pays rent again in each:

- `openZip` over HTTP Range — extract one file from a ZIP in B2 without pulling
  the whole archive.
- `@culvert/cipher` — chunked AES-GCM `Transform` for end-to-end encryption
  composed into the pipe, instead of trusting rclone's crypt layer (from the
  audit). **Does not exist on npm yet (checked 2026-08-29); likely authored
  from this repo.**
- `@culvert/tar` (0.1.2) + `@culvert/gzip` (0.1.0) — **published May 2026**
  (the "planned" note in stream 0.1.1's README is stale) — + `Seekable` →
  incremental / resumable backup reads.

## 6. Non-goals

- Public or multi-tenant hosting for users who are not bringing their own bytes.
- Cross-account sharing of decrypted content.
- Re-encoding / transcoding (pipeline stays lossless remux).
- Deriving activation bytes for files whose owner can't supply them.

## 7. Open questions for the build doc

- Where do per-user activation bytes live — new `users` table, or a column on
  jobs? How are they entered and validated?
- Does v1's `@culvert/mp4` reader supersede the current `metadata.server.ts`
  path, or run alongside it?
- v2 route auth: how is "this user owns this job" enforced before decrypt?
- Do the `@culvert/*` packages get vendored in this repo first and extracted
  later, or authored as separate packages from the start?
