---
title: Learn's embeddings come from an optional self-hosted Ollama service serving bge-m3, not text-embeddings-inference
date: 2026-09-30
updated: 2026-10-22 17:05
status: accepted
kind: infrastructure
issues: []
prs: [69]
areas: [docker-compose.yml, src/lib/knowledge/embeddings.ts, src/lib/knowledge/availability.ts, src/lib/knowledge/knowledge-embed.ts, src/lib/env.ts]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn]
---

# Learn's embeddings come from an optional self-hosted Ollama service serving bge-m3, not text-embeddings-inference

Learn uses vectors to find knowledge by meaning and narrow what it sends to the model. The vectors
come from an opt-in compose service, `embeddings` under the `learn` profile, running Ollama with the
multilingual BAAI/bge-m3 model on CPU behind an OpenAI-compatible `/v1/embeddings` endpoint. Ollama
won a measured comparison against Hugging Face's text-embeddings-inference (TEI): same vectors and
speed at a fraction of the memory. The app takes any OpenAI-compatible embeddings endpoint, and Learn
works without one, matching words only. A later evaluation of EmbeddingGemma 2 as a leaner
replacement was rejected, and a timeout failure on a small CPU-only host was fixed in the client
rather than by giving the host more CPU.

## Why

- **Learn needs search by meaning**, for knowledge items and for aligning misheard words in
  corrected transcripts. Names are matched lexically, never by vector; that and keeping vectors
  encrypted and searched in memory instead of pgvector are Learn decisions
  ([2026-09-30-learn](2026-09-30-learn/README.md)).
- **The chat providers cannot produce embeddings.** Anthropic offers no embeddings API, so Claude,
  directly or through the agent bridge, cannot do this job.
- **Learn is language-neutral**, so the model has to place the same meaning in different languages
  close together (a Czech and an English sentence, for example).
- **Self-host constraints:** Learn is self-hosted only; the runtime must be a pullable Linux CPU
  image that starts with `docker compose --profile learn up`, with no GPU assumed.

## Options considered

Spike 0.2 served bge-m3 (1024 dimensions) through both runtimes on the same machine (24 CPUs, no
GPU), via `/v1/embeddings`, medians of 5 runs over short knowledge-like texts:

| | Ollama 0.34.4 (GGUF) | TEI cpu-1.9.4 (ONNX) |
|---|---|---|
| Image | 3.75 GB, amd64 and arm64 | 239 MB, amd64 only |
| Model download | 1.2 GB, 70 s | 2.3 GB, about 4 min |
| Batch of 1 / 32 / 128 | 25 ms / 623 ms / 2.44 s | 40 ms / 653 ms / 2.76 s |
| Memory | 38 MB idle, 1.28 GB with the model loaded | 16 GB RSS idle at the default `--max-batch-tokens` 16384; 5 to 7.8 GB at 2048 |
| Cold start | server 0.2 s, model load 1.3 s on first request | 31 s (5 s at 2048 tokens) |
| Czech and English, same meaning | 0.957, 0.949 | 0.956, 0.950 |
| Unrelated pair (cross-language / Czech only) | 0.471 / 0.422 | 0.471 / 0.422 |

### Option A: Ollama serving bge-m3 (chosen)

- **Pros:** about 1.3 GB of memory loaded; arm64 too; near-instant cold start; same vectors as TEI.
- **Cons:** the larger image; the model unloads after five idle minutes unless kept alive.

### Option B: text-embeddings-inference (declined)

- **Pros:** a much smaller image.
- **Cons:** refuses more than 32 inputs per request by default.
- **Rejected because:** identical vectors and speed at five to sixteen gigabytes of memory instead of
  about 1.3 GB, and no arm64 image. Revisit if its CPU memory footprint drops
  to the same order as Ollama's.

### Option C: EmbeddingGemma 2 as a replacement, evaluated 2026-10-12 (declined)

A Gemma-based 768-dimension embedding model, released days earlier, raised as a leaner option.

- **Pros:** smaller vectors; in bf16 slightly less memory than bge-m3 (1.24 GB against 1.37 GB peak).
- **Cons:** no pullable Linux CPU runtime: on Linux, Ollama refuses every tag of it ("requires MLX
  support"), so it ran only through a PyTorch stack. Lower retrieval quality on a synthetic set of
  54 Czech and English queries: MRR 0.991 for bge-m3, 0.935 for EmbeddingGemma 2 raw and 0.960 with
  query and document prefixes. Its cosine floor is high: wrong-entity similarities sat around 0.62
  to 0.70, so meaning hits would outrank name matches in `src/lib/knowledge/find-entities.ts`
  without recalibrating scores. In fp32 it needs 2.07 GB; the bf16 figure was measured only on a CPU
  with AVX512-BF16.
- **Rejected because:** the self-host contract needs a pullable Linux CPU runtime, and switching
  would change ranking behaviour, not just swap a model. Revisit when Ollama supports it on Linux
  (tracked upstream as ollama/ollama#18825), and then only with score calibration and prefixes in the
  client. The generative Gemma 4 models were ruled out in the same exchange: none is an embedding
  model, and the smallest has about 5B parameters against bge-m3's roughly 568M.

## Decision

**Chosen: Option A**, as an optional service. Ollama gives the same vectors as TEI for a fraction of
the memory, which is what decides it on self-hosted hardware, and the cross-language gap (about 0.95
for the same meaning against about 0.47 for unrelated text) makes matching meaning across languages
workable.

When a small CPU-only host could not finish a batch inside the fixed 20 s timeout (PR #155), the fix
went into the client rather than the hardware: that host could not be given more CPU. Batches are
now bounded by size as well as count, the timeout is configurable, and finished batches are kept.

## Key technical details

- **Service:** `embeddings` in `docker-compose.yml`, profile `learn`, Ollama pinned by digest, no
  published port, the model pulled into its volume on first start, `OLLAMA_KEEP_ALIVE` 24 h by
  default, 3 GB memory limit. The app points at it with `EMBEDDING_BASE_URL=http://embeddings:11434/v1`
  and `EMBEDDING_MODEL=bge-m3`.
- **Any OpenAI-compatible `/v1/embeddings` endpoint works** (`EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`,
  `EMBEDDING_API_KEY`, `EMBEDDING_TIMEOUT_MS` in `src/lib/env.ts`).
- **Off unless configured, and always off on hosted:** `src/lib/knowledge/availability.ts` reports
  embeddings unavailable without a base URL or when `IS_HOSTED`, and Learn then runs lexical-only and
  says so.
- **Client** (`src/lib/knowledge/embeddings.ts`): at most 32 inputs (TEI's default limit, kept) and
  6,000 characters per request, 60 s timeout by default, and a circuit breaker that pauses calls for
  60 s after failures so a run degrades to lexical matching instead of failing.
- **What is embedded:** rendered facts, entity descriptions and term definitions, never names alone
  and never stored transcripts; transcript passages are embedded at query time only. Task
  candidates' content vectors use the same client.
- **A model change re-embeds everything:** vectors carry the model and render version, and
  `src/lib/knowledge/knowledge-embed.ts` writes each finished batch, so an interrupted run resumes
  where it stopped.

## Verification

- Spike 0.2 numbers above; the compose service was verified healthy and answering by service name
  before PR #69 merged.
- `src/tests/knowledge/embeddings.test.ts` (batching by count and size, per-batch callback),
  `embedding-client-config.test.ts`, `embedding-client-hosted.test.ts`,
  `src/tests/knowledge/knowledge-embed.integration.test.ts` and
  `src/tests/tasks/candidates.integration.test.ts` (per-batch persistence, the same-owner update).
- PR #155's case: bge-m3 F16 on 4 vCPUs at about 380 tokens/s; a batch of 32 long chunks exceeded the
  20 s timeout, so every Learn and task-candidate embedding run failed and restarted from scratch,
  storing nothing.

## Consequences & open follow-ups

- **Cost of opting in:** about 1.3 GB of memory and a 1.2 GB first download. A first start without
  network access leaves the service unhealthy and Learn matching words only.
- **Swapping the model is not a configuration tweak.** Everything is re-embedded, and a model with a
  different similarity distribution needs its score thresholds recalibrated before name matches and
  meaning matches rank correctly together.
- **Slow hosts may still need a longer `EMBEDDING_TIMEOUT_MS`**; the default rose from 20 s to 60 s.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): the feature these vectors serve, including the
  decision to keep vectors encrypted and search them in memory instead of using pgvector.

## Timeline

- **2026-09-29**: Spike 0.2 compared Ollama and TEI; Ollama chosen; compose `embeddings` service
  added on the Learn branch.
- **2026-09-30**: Learn merged with the optional embeddings service (PR #69).
- **2026-10-12**: EmbeddingGemma 2 evaluated as a replacement and rejected.
- **2026-10-18**: follow-up: size-bounded batches, configurable timeout and kept partial progress (PR #155).
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
