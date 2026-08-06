# Product Review & Direction

_Written 2026-08-06. Companion to [architecture-audit.md](architecture-audit.md)._

## The one-sentence diagnosis

**You built a job queue, but you want a library.** The user thinks in *books*;
the app thinks in *jobs* — and every UX pain you're feeling (progress split
across pages, cards that say "done" while the server is still working, an
archive browser that's a dead end) falls out of that mismatch.

## Where the experience breaks today

1. **A book lives in four places with four identities.** A local queue item on
   the upload page, a row on the jobs page, a directory in staging, a file in
   B2. Nothing ties them together visually. To answer "is my book safe?", you
   cross-reference three screens.
2. **The upload card lies.** It hits 100% and says "Done" the moment the server
   *receives* the file — decode, archive, and verify are still ahead, invisible
   unless you navigate away (losing your upload queue state, another TODO you
   already logged). The ProgressRing component supports the later stages; it
   just never gets fed them.
3. **Progress numbers are wrong.** The jobs page derives percentage from
   rclone's *global* cumulative `core/stats.bytes` — after the first job the
   bar is fiction. And 3-second full-loader polling is the workhorse, so
   everything feels 3 seconds stale.
4. **The destination path is a text field.** Typing `Fiction/Fantasy/` —
   trailing slash required, no validation, silent misfiling if you forget it —
   is the opposite of delight. Nobody should type paths at their own archive.
5. **The archive browser is look-but-don't-touch.** You can see files in B2 but
   not download, restore, verify, or delete them. It's a monument, not a tool.
6. **The end goal is structurally impossible right now.** Only the DRM'd AAX
   is archived. The playable M4B exists briefly in staging and is *deleted*
   after download. There is nothing in B2 you could ever stream.

## The product it wants to be

One screen: **your library.** A grid of books with cover art, each carrying a
single honest status: *Uploading → Processing → Safe ✓* (failure = one red
state with one Retry button). Drop files anywhere on the page. Click a book for
the detail drawer: full event timeline, file sizes, destination, actions
(Download, Stream, Verify, Delete). The jobs page becomes that drawer; the
archive browser dissolves into the library (books already in B2 appear
alongside in-flight ones — one namespace, reconciled from B2 + SQLite).

Design cues, since we're channeling Jobs: the AAX file is an implementation
detail — never show a filename when you have a title. `ffprobe` (already have
ffmpeg) reads title, author, narrator, duration, chapters, and embedded cover
art from the AAX during staging. That one enrichment step turns rows of
`HiveWarhammer40000_ep7.aax` into a bookshelf, and it's cheap.

### The three moves, in order

**Move 1 — Tell the truth about progress (fixes pains 1–3).**
- Add `/api/events`: a single SSE stream. Server-side, pipeline + watcher push
  job transitions and per-job rclone stats into a culvert `channel()`; the
  route is just `toReadableStream`. This is a *flagship* culvert use case —
  push-to-pull bridging is literally what `channel()` is for.
- Use rclone's per-job stats (`core/stats` with `group: "job/<id>"`) instead
  of global bytes, so the bar is real.
- Feed the existing FileCard/ProgressRing the full server lifecycle. Upload =
  0–25% of the ring — exactly what the component already encodes. The card
  reaches "Safe ✓" only at `COMPLETED`. Refresh-proof, page-proof.

**Move 2 — Kill the text field; add metadata (fixes pains 4 and half of 5).**
- Replace the destination input with a folder picker fed by the existing
  rclone listing (+ "new folder"), or go further: auto-file as
  `Author/Series/Title.m4b` from ffprobe metadata with an override. Default
  should be zero typing.
- Store title/author/duration/cover in SQLite; render covers in the library.

**Move 3 — Archive the M4B, then stream it (unlocks the end goal, pain 6).**
Decision needed (my recommendation: **first option**):
- **Archive both**: AAX as master + M4B as playable. Costs ~2× storage (B2 is
  ~$6/TB/mo — a 500-book library is maybe 15 GB × 2; irrelevant money) and
  makes streaming trivial.
- Archive only M4B: cheaper, but you lose the pristine master.
- Keep AAX-only and transcode on demand: no extra storage but every stream
  needs ffmpeg + activation bytes — wasteful and fragile.

Then streaming is: app route → rclone rcd range read from the crypt remote →
`Response` with `Accept-Ranges`/206 → plain `<audio>` element. rclone's crypt
format supports random access, so seeking works. Add chapters (from ffprobe,
already in DB after Move 2) and persist playback position per book — now it's
an audiobook player, not a demo. A phone-friendly PWA wrapper comes almost
free since it's already a web app behind Tailscale.

### The AAX transform step (your audible-tools idea)

Today `ACTIVATION_BYTES` is a manually-provisioned env var (the .env.example
even points at kamsker's site). The audible-tools approach derives activation
bytes from the AAX file's checksum via rainbow-table lookup. Concretely:

- Extract the file checksum from the AAX header during staging (it's in the
  first bytes of the file — readable with a culvert-style byte reader).
- Look up activation bytes (their public API, or vendor the table) → store per
  file → decode no longer depends on a hand-configured secret, and books from
  *any* Audible account work.
- Long-term culvert angle: AAX header parsing is a clean
  `Transform<Uint8Array, ParsedHeader>` story, and the decode step itself can
  present as a pipeline stage (file-based under the hood — ffmpeg needs
  seekable input — but jobs compose as source → transform → sink with `tap`
  progress, same mental model as the rest of the app).

And the encryption end-game: today privacy rests entirely on rclone's crypt
remote. An `@culvert/cipher` package (chunked AES-GCM transform, seekable
block layout) would let this app encrypt in the pipe *before* bytes leave the
box and decrypt during streaming — culvert grows a package with a real
production consumer, which is exactly the "real friction" bar your north-star
doc sets for new packages.

## What to delete (simplicity is subtraction)

- The **jobs page as a destination** — becomes a drawer/panel in the library.
- The **archive page** — merged into the library.
- The **download-selected implementation** — becomes 5 lines sharing
  download-all's culvert path (audit C1).
- The **npm `archiver` dependency** — culvert does this job.
- The **destination text field** — picker/auto-organize.
- The **two design systems** — the upload page is inline-styles + CSS vars,
  everything else is Tailwind. Pick Tailwind (the ui.sh skills will help);
  keep the ring/card visual language, it's the best part of the current UI.
- The **polling revalidator** — SSE.

Three nav items become one screen. Every click that exists today to answer
"is my book okay?" goes away.

## Proposed roadmap (for discussion)

| Phase | Theme | Contents | Size |
|---|---|---|---|
| 0 | Make it correct | Audit fix-order items 1–6 (dead recovery, ffmpeg -y, download rewrite, Dockerfile, phantom dep, store-mode zip) | ~2 days |
| 1 | Tell the truth | SSE events endpoint (culvert `channel()`), per-job rclone stats, unified library page with honest lifecycle cards, jobs→drawer | ~3 days |
| 2 | Make it beautiful | ffprobe metadata + covers, auto-organize destination, folder picker, one design system (Tailwind + ui.sh skills), empty states | ~3 days |
| 3 | Make it the goal | M4B-to-B2 (decision above), Range streaming route, `<audio>` player with chapters + resume, restore-from-B2 | ~1 week |
| 4 | Make it culvert | activation-bytes auto-derivation from AAX header, `@culvert/cipher` design + integration, write the case-study blog post | open-ended |

Phase 0 is non-negotiable before anything else — several fixes (recovery,
retry, Docker) are prerequisites for trusting the app with the only copies of
your books. Phases 1–2 are pure product; 3 is the payoff; 4 feeds culvert.

## Open questions for you

1. Archive M4B alongside AAX (my rec), M4B-only, or AAX-only + on-demand
   transcode?
2. Is download-as-ZIP still a real need once streaming exists, or does it
   become "download this one book" (no ZIP at all — just stream the M4B file
   as an attachment, simpler and resumable)?
3. Auth: stay Tailscale-only, or add a passkey/simple login so it can ever
   leave the tailnet (streaming from a friend's wifi)?
4. Should the library reconcile *existing* B2 content (books uploaded via
   rclone CLI before this app existed) into SQLite, so day one shows your
   whole collection?
