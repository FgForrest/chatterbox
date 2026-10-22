---
title: Large video uploads stream as a raw request body outside the Next proxy, with memory measured under Bun
date: 2026-09-27
updated: 2026-10-22 16:00
status: accepted
kind: fix
issues: []
prs: [62]
areas: [src/app/api/recordings/upload, src/lib/uploads/upload-body.ts, src/proxy.ts, next.config.ts, src/hooks/use-upload-queue.ts]
supersedes: []
superseded-by: []
relates: []
---

# Large video uploads stream as a raw request body outside the Next proxy, with memory measured under Bun

A video over 501 MB failed only after the whole file had been sent. Instead of raising the limit,
PR #62 changed the upload protocol: the browser sends the file itself as the request body (name and
size in headers), the upload route is excluded from the Next proxy, and videos stream to storage
with a configurable cap (`VIDEO_UPLOAD_MAX_BYTES`, default 4 GiB). The production container runs the
Next standalone server under Bun, not Node, so the streaming path was measured under Bun, and that
measurement found a buffering behaviour Node does not have.

## Why

- **The failure:** Next's proxy buffers the whole body of every request it runs on and cut this one
  off at `proxyClientMaxBodySize` (501 MB), so multipart parsing failed with "missing final boundary"
  and the user saw a generic 500.
- **Below the limit it was still wasteful:** the route held the file several times
  (`formData()`, then `arrayBuffer()`, then `Buffer.from()`), and the audio-extraction job loaded it
  whole again.
- **Production runs `bun server.js`.** A streaming change that is flat under Node and vitest can
  still buffer in production.

### Previous state

Uploads were multipart forms through the proxy, capped at 500 MB for every file type, with a
501 MB `proxyClientMaxBodySize` in `next.config.ts` that existed only for this route.

## Options considered

The three options were put to the maintainer before any code was written.

### Option A: stream uploads (chosen)

Raw request body, route excluded from the proxy matcher, stream to `storage.uploadStream` counted
against the declared size, configurable cap, extraction job streams its source to a temp file,
size check in the browser.

- **Pros:** server memory no longer grows with file size.
- **Cons:** a protocol change (open tabs from before the deploy send the old form and get a 415
  asking for a reload); the route must apply the hostname gate the proxy used to apply.

### Option B: raise the limit only (declined)

Make the cap configurable for both the proxy and the route, add the browser check.

- **Pros:** quick, no protocol change.
- **Rejected because:** memory still grows with file size, roughly two to three times the video
  size per upload.

### Option C: keep 500 MB and fail cleanly (declined)

A browser-side size check and a clean 413 instead of the 500.

- **Pros:** smallest change.
- **Rejected because:** it leaves the user to shrink every large video by hand (extract the audio
  with `ffmpeg`) before uploading.

## Decision

**Chosen: Option A.** It is the only option where memory stays flat regardless of file size. It
was accepted with one known caveat from the Bun measurement below: Bun's web `Request` body applies
no socket backpressure, so when the client outruns the storage write, memory grows. At real network
speeds onto local disk it stays flat. Revisit if uploads go to storage slower than the client's
connection (S3 was not measured) or Bun gains backpressure on `Request` bodies.

## Key technical details

- **Protocol:** `POST /api/recordings/upload` with the file as the body plus `X-Upload-Filename` and
  `X-Upload-Size` (`src/hooks/use-upload-queue.ts`). The old multipart form gets a 415.
- **Outside the proxy:** the matcher in `src/proxy.ts` excludes the route, because the proxy buffers
  every body it handles. The route applies the admin-host gate itself
  (`src/app/api/recordings/upload/route.ts`). Any route later excluded from the matcher (the MCP and
  mail ingest routes are) must likewise apply what the proxy would have.
- **No `proxyClientMaxBodySize`:** back to Next's 10 MB default. Keeping 501 MB would let any other
  route be sent half a gigabyte into memory.
- **Declared size is checked before any of the body is read**, against both the cap and the storage
  quota. A body longer or shorter than declared fails with a 400 and leaves no partial file.
- **Audio-only files keep the 500 MB cap and are still buffered**, because `saveUploadedAudio` works
  on a buffer. Only videos stream.
- **The web-to-Node adapter** is `Readable.from(<async generator>, { objectMode: false })` over the
  request body's reader (`src/lib/uploads/upload-body.ts`). A route handler receives a web `Request`,
  so the raw socket path that stayed flat in the measurement is not available to it (inferred).

## Verification

Measured under Bun 1.4.0 with a `node:http` harness that hands the body to the code the way Next
does (`new Request(url, { body: IncomingMessage })`), sent with `curl -T`, peak memory read from
`VmHWM`. A 3 GB body over loopback, which outruns the disk:

| Path | Bun peak | Node peak |
|------|----------|-----------|
| Raw `IncomingMessage` to a file | 88 MB | |
| Web `Request` body, discarded | 96 MB | |
| Web `Request` body through `Readable.from(asyncGenerator)` to a file | 1,882 MB | |
| `Readable.from` in object mode to a file | 2,175 MB | |
| `Readable.fromWeb` plus a transform to a file | 4,416 MB | |
| The Next-style web wrapper to a file | 4,461 MB | 158 MB |
| File to file copy (the extraction job's path) | 97 MB | 166 MB |

Through the finished route at realistic rates, a 2 GB upload peaked at 88 MB at about 1 Gbps and
108 MB at about 3.2 Gbps. Only loopback at about 1.2 GB/s buffered (4.5 GB peak).

Tests: `src/tests/uploads/upload-route.test.ts` (the real `LocalStorage` in a temp directory: limits,
bodies longer or shorter than declared, partial-file cleanup), `src/tests/uploads/upload-body.test.ts`,
and a matcher case in `src/tests/regressions/proxy-matcher-js-paths.test.ts`. 1698 tests passed;
`next build` compiled the matcher exclusion.

## Consequences & open follow-ups

- **Measure stream memory under Bun, not Node.** The recipe: install Bun into a scratch directory
  with npm, run a small `node:http` harness, send with `curl -T` (not `--data-binary`, which loads
  the file into curl), read `VmHWM` from `/proc/<pid>/status`, and use `--limit-rate` for realistic
  numbers.
- **Not measured:** S3 storage slower than the client, a real browser upload through the full stack,
  and `ffmpeg` extraction of a multi-gigabyte video.
- **Audio uploads still buffer** up to 500 MB; streaming them needs `saveUploadedAudio` to accept a
  stream.

## Timeline

- **2026-09-27**: upload failure reported; streaming chosen over raising the limit or failing
  cleanly; Bun buffering measured; PR #62 merged.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
