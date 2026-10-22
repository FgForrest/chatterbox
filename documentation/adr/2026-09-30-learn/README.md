---
title: Learn proposes knowledge from transcripts for a person to confirm; knowledge stays encrypted and is searched in memory
date: 2026-09-30
updated: 2026-10-22 17:00
status: accepted
kind: feature
issues: []
prs: [69, 79]
areas: [src/lib/learn, src/lib/knowledge, src/lib/sharing/share-gate.ts, src/app/api/mcp/learn, src/lib/learn/auto-learn.ts]
supersedes: []
superseded-by: []
relates: [2026-09-28-agent-bridge-cli-providers, 2026-09-30-self-hosted-embeddings, 2026-09-14-speaker-identity-without-biometrics, 2026-09-30-shared-recording-edited-by-organization, 2026-10-01-almanac-and-new-records, 2026-10-01-name-matching-across-word-forms, 2026-10-02-almanac-guided-transcript-correction, 2026-10-12-calendar-meet-speaker-candidates, 2026-10-19-learn-review-one-column, 2026-09-23-shared-organization-scope, 2026-09-13-durable-job-queue, 2026-10-22-recording-language-checked-by-learn]
---

# Learn: knowledge from recordings, proposed by a model and confirmed by a person

Learn reads a timed transcript against what the instance knows about people, organizations,
projects, products and terms, and proposes names for unnamed speakers, corrections of misheard
names, and lasting work facts ("a person leads a project"). Nothing is written until a person
reviews it; what they accept becomes knowledge for the next transcript, summary and Learn run.
Knowledge has two layers: a shared one owned by the Organization account and a private one per
user, chosen by whether the recording is shared. PR #69 built the whole plan in six phases, each
reviewed by two independent model reviewers and fixed before the next; PR #79 fixed what the first
real automatic run exposed.

## Why

- PR #25 let a person name speakers by hand. Learning who and what recordings talk about, from the
  conversations themselves, was the next step, and an external feasibility analysis proposed it
  (hypotheses versus human-confirmed facts, owner review, shared and private knowledge). It was
  written without seeing the code and was reshaped decision by decision against it.
- **Constraints that made it non-obvious:**
  - Transcripts, person names and notes are encrypted at rest by the app; Postgres sees ciphertext
    and cannot search them.
  - The database is stock `postgres:16-alpine`, and the app connects as the `postgres` superuser.
  - Self-host must keep working with one `docker compose up`; a required new service or image is
    a breaking change for every installation.
  - Speaker identity must stay non-biometric (see the speaker identity record).
  - Model output is unreliable; a wrong name or fact flows into minutes, task assignment and other
    users' view.
  - Every merge reached a live instance soon after, so half-built phases had to stay inert.

## Decisions taken

| Date | Decision | Why | Detail |
|------|----------|-----|--------|
| 2026-09-27 | No row-level security; visibility lives in shared query predicates backed by leakage tests | The app connects as a superuser, which bypasses RLS; the analysis proposed it without grounds | `src/tests/knowledge/leakage.integration.test.ts` |
| 2026-09-27 | Names are matched lexically, in memory, over a decrypted per-scope cache; never by vector similarity | Names are encrypted; the maintainer ruled that vectors are for facts and meaning, not names | `src/lib/knowledge/name-match.ts`, `memory-store.ts` |
| 2026-09-27 | Vectors are stored encrypted and searched brute force in memory; no pgvector, no Postgres upgrade | 50,000 vectors of 1,024 dimensions take 205 MB and 33-38 ms per query; pgvector would need readable vectors and a new image for every self-hoster | `src/lib/knowledge/vector-search.ts`; runtime in the embeddings record |
| 2026-09-27 | Evidence is anchored to audio time (start and end ms), not to transcript revisions | Every transcript of a recording shares the audio timeline; see below | `src/lib/knowledge/fact-evidence.ts` |
| 2026-09-27 | Facts die with their transcript: retention is knowledge decay | Without the transcript nobody can tell which recording a fact came from | `src/lib/knowledge/fact-chains.ts` |
| 2026-09-27 | Share gate: a recording joins the Organization only with every speaker answered (a person or an explicit unknown) and every Learn review finished | Suggestions are private to the owner; what the Organization receives must be confirmed | `src/lib/sharing/share-gate.ts` |
| 2026-09-28 | Every knowledge name, alias, description, quote, literal and vector is encrypted; SQL holds ids, keys, times and keyed HMACs only | Reverses the 2026-09-13 rule that organization and project names stay plaintext: that rule existed so SQL could search them, and in-memory search removes the reason | `src/lib/knowledge/entities.ts`, `lookup-hash.ts` |
| 2026-09-28 | Self-hosted only; inert without a chat provider; lexical-only without the embedding service | The maintainer is not an upstream contributor and cannot commit the hosted service's plans | `src/lib/knowledge/availability.ts` |
| 2026-09-28 | No time-bound or recurring-meeting facts | Temporary things are action items in the summary; recurrence will come from Calendar | design boundary |
| 2026-09-28 | Two review defaults; only almost-sure corrections of non-person terms are pre-ticked | See below | `src/lib/learn/validate.ts` |
| 2026-09-28 | Two execution paths: the agent bridge with Riffado's read-only MCP tools, and a no-tools fallback for any provider; the native API-key tool loop is cut | See below | `run-bridge.ts`, `run-fallback.ts`, `src/app/api/mcp/learn` |
| 2026-09-28 | Vocabulary in three layers (core in code, Organization, private); a user can build a complete private knowledge base, relation types included | The maintainer wanted users to grow their own knowledge without the Organization | `src/lib/knowledge/vocabulary.ts` |
| 2026-09-28 | The Organization account is a super user; every knowledge table records the owner and the acting user | Delegated roles may later act on its behalf, and then the acting human must already be recorded | `src/db/schema.ts` |
| 2026-09-29 | With automatic Learn on, title, summary and topics wait for the review, at most 72 hours | See below | `src/lib/learn/auto-learn.ts` |
| 2026-09-29 | A share adopts the owner's private types it needs into the Organization; the curator tidies afterwards; a type the curator deleted is remembered as refused | See below | `adoptTypesForShareInTx` in `vocabulary.ts` |
| 2026-09-29 | A person heard only by first name is suggested with a mark and never pre-ticked; one that two known people share is dropped | In the pilot every wrongly named speaker had been resolved from a first name alone | `validate.ts`, `evaluation.md` |
| 2026-09-29 | A provider can be marked "Use for Learn" | The maintainer accepted a separate, stronger model for Learn; the evaluation recommended Opus 5.5 for Learn and a cheaper model for summaries | migration 0078 |
| 2026-10-02 | A correction of a thing spreads to every other place its words stand alone; a person's correction does not | A person's name may belong to a namesake elsewhere in the recording | `occurrences` in `validate.ts` (PR #79) |

### Evidence anchored to audio time

Re-transcription rewrites a transcript in place (new provider, Plaud re-import, forced re-run). Three
answers were on the table for what happens to evidence that points into it:

- **Keep revisions** (the analysis's proposal): every read path would have to pick the current
  version, retention would have to delete all versions, backups grow, and evidence would point at
  text the user can no longer see.
- **Drop evidence on rewrite**, as topics are dropped: simple, but with facts dying with their
  evidence, switching providers would wipe every fact learned from those recordings.
- **Anchor to audio time** (chosen): after a rewrite the quote is cut again from the turns in that
  time range and compared; a speaker dependency is re-resolved through label matching by speech
  overlap. A changed wording or speaker becomes a review item, never a silent move.

The same overlap technique replaced the old rule that kept speaker names only when the speaker
count matched (`src/lib/knowledge/label-mapping.ts`). Measured on the two recordings that had both a
Plaud and a Riffado transcript: one timeline, median offset +0.1 s and +0.26 s, no drift (0.16 s per
hour).

### Two review defaults

The first design auto-applied almost-sure corrections. Both reviewers called that a breach of "only
a person confirms". Two answers were offered: narrow it, or drop auto-apply entirely (the second
reviewer's version). The maintainer narrowed it: pre-ticked ("yes unless you say no") are only a
correction of a **non-person** term whose heard form a person already confirmed for that record, in
the same language and from the same transcription provider, and known facts mentioned again.
Everything else is unticked: speaker names, anything targeting a person (namesakes), new records,
new facts, relation phrases. "Almost sure" is this fixed rule, never the model's confidence. The
evaluation tightened it once more: a pre-tick must write exactly the record's name, because four of
seven pre-ticks in a measured pass had rewritten an inflected heard form to the base name, which is
wrong in a language with case endings.

### Execution paths

The plan had three: the bridge with MCP tools, a native tool loop on API-key providers, and a
no-tools fallback in which the server does the lookups and two fixed calls carry the results. One
reviewer found the native loop had no runner at all (iterative tool calls, tool-result messages,
budget enforcement, capability detection), and both advised shipping one tool path and one fallback
until an evaluation showed the need. The native loop was cut. The tool path runs the CLIs through
the hardened agent bridge, restricted to the exact Riffado tool names, with a token bound to the run
and kept out of argv; user, recording and scopes come from the run, never from tool arguments.

### Summary waits for the review

Corrections change what a summary says, so with automatic Learn on, writing the transcript sets
`summaryDueAt` and the summary, title and topics are held. Options put to the maintainer: wait for
the review with a cap (chosen), or wait only for the Learn pass (titles arrive within minutes but
read the uncorrected names); caps of 72 hours (chosen, it covers a weekend), 24 hours or 8 hours.
Without automatic Learn, summaries are made from the plain transcript as before; a manual Learn
whose review changes the text regenerates the summary when auto-summarize is on and marks it
possibly stale otherwise. The hold is released at once when Learn fails, is rate-limited or finds
nothing, and nothing is parked in the job queue, so the summary panel never shows a phantom running
job.

### Auto-adopt at share

A private correction that links a word to a private type the Organization does not have could not
be published on share. The proposal was to withhold the Organization view's summary until it was
regenerated. The maintainer asked instead for optimistic publication: a share adopts every private
entity or relation type the recording needs (an existing Organization type of the same name and
shape, or a copy marked "adopted from a share"), so knowledge accumulates at the Organization level
even when no curator acts; the curator later renames, merges or deletes. When the curator deletes an
adopted type, the member types it came from are marked refused (migration 0077), or every later
share would bring it back; the refusal lifts when the Organization has a type of that name again.

## Rejected outright

| Option | Rejected because | Revisit if |
|--------|------------------|------------|
| Row-level security | The app connects as the `postgres` superuser, which bypasses it; making it work needs a new database role, a per-transaction identity and escape hatches for every cross-user worker (sync, retention, exports) | The app stops connecting as a superuser for other reasons |
| pgvector with a Postgres upgrade (pgvector image, 16 to 18) | Stock `postgres:16-alpine` lacks the extension; the switch forces a dump and restore on every self-hoster (major version and C library collation change) and a hand-written migration; pgvector indexes only readable vectors, and a cited study recovered 92% of short texts from their embeddings | Semantic search over whole transcript history (hundreds of thousands of chunks) becomes a requirement and readable vectors are accepted |
| Homomorphic encryption for search | The app holds the key and decrypts anyway; at-rest encryption guards a stolen dump or backup; it is thousands of times slower and nothing integrates it with Postgres | Never, under this threat model |
| Rotating vectors with a secret so pgvector can index them | Obfuscation, not encryption | Never |
| A blind index (keyed hashes of each name's words and trigrams) queried in SQL | Not needed at one company's scale, where a few thousand names decrypt in milliseconds; it also leaks which values share fragments | The directory grows to tens of thousands of names, or names are needed in SQL joins |
| Matching names by vector similarity | The maintainer's ruling: names are matched by their words, vectors narrow facts and meaning for the model | None given |
| Sending the whole knowledge base to the transcription provider | Too wide for the initial transcription call; hence a correction pass by an agent with MCP tools | Partly revisited: a ranked subset of at most 500 names is sent as key terms (see the transcript correction record) |
| A native API-key tool loop as a third path | No runner existed, and it multiplied failure modes before the basic slice was proven | An API-key provider must run Learn with tools and the fallback proves too weak |
| Dropping pre-ticks entirely | Narrowed instead: a pre-tick repeats a decision a person already made for that exact heard form, so it stays human-confirmed; without it every recurring mishearing of a known term needs a manual tick (inferred) | Pre-ticked correction precision falls below the 95% threshold |
| Evidence pinned to transcript revisions | Every read path, retention and backups would carry old versions, and evidence would point at invisible text | None |
| Dropping evidence on every rewrite | Switching transcription provider would erase every learned fact | None |
| Time-bound and recurring-meeting facts | Temporary things belong in the summary's action items; recurrence comes from Calendar | Calendar integration needs a stored fact it cannot derive |
| Learn on the hosted service | The maintainer cannot speak for the hosted service's plans | Upstream decides to adopt it |
| Withholding the Organization's summary until regenerated, for unpublishable private corrections | Replaced by auto-adopt, so every correction publishes | Auto-adopted types prove too noisy for curators |
| Holding title and summary only until the Learn pass ends | Titles and summaries would still read the uncorrected names | None given |

## Key technical details

- **Entry points:** job `learn.run` (`src/lib/learn/learn-job-handler.ts`); tool path
  `src/lib/learn/run-bridge.ts` with the MCP endpoint `src/app/api/mcp/learn/route.ts` and the run
  token `run-token.ts`; fallback `run-fallback.ts`; server-side validation `validate.ts`; Finish
  `review.ts`; hold and release `auto-learn.ts`, `hold.ts`; sharing `share-knowledge.ts` and
  `src/lib/sharing/share-gate.ts`.
- **Suggestions never reach summaries, exports, the API or other users.** The one exception:
  pre-ticked corrections of an unfinished review are used in the text sent to models, which is what
  "yes unless you say no" means when the hold times out.
- **Cache correctness does not depend on `NOTIFY`.** Every knowledge-writing transaction bumps its
  scope's row in `knowledge_scope_generations` (`scope-generation.ts`); each run and each tool call
  compares generations and reloads a stale scope. A writer that forgets the bump serves erased or
  withdrawn knowledge from memory.
- **Only `supported` evidence keeps a fact alive**; evidence cascades with its transcript; a fact with
  no evidence left is deleted unless it was entered by hand.
- **Transcript text is data.** Instructions inside it are never followed, and the bridge offers only
  read-only Riffado tools, so there is nothing dangerous to follow.
- **Only timed transcripts** (turns with times) offer Learn; Gemini, chat-style and legacy transcripts
  do not.
- **Learn is off on hosted** (`isLearnDeploymentAvailable` returns `!env.IS_HOSTED`).
- **Breaking change shipped with PR #69:** sharing into the Organization has requirements, and an API
  client removing a recording from its last Organization folder must send `withdraw: true`.
- **Looks like a bug, is intended:** `summary.completed` can arrive up to 72 hours after
  `transcription.completed`; Organization facts mentioned again on a private recording are dropped,
  not proposed; a pre-tick whose grounds were taken back while the review waited stays ticked
  (rare, accepted); renaming a linked record marks summaries stale without regenerating them (cost).

## Verification

- PR #69: 2,523 tests passed (12 skipped) with the Postgres integration tests; `tsc` and Biome clean.
  Key suites: `src/tests/knowledge/leakage.integration.test.ts`, `scope-generations.integration.test.ts`,
  `memory-store.test.ts`, `label-mapping.test.ts`, `src/tests/sharing/share-gate.test.ts`,
  `src/tests/learn/validate.test.ts`, `review-finish.integration.test.ts`, `auto-learn.integration.test.ts`,
  `mcp.integration.test.ts`.
- Evaluation on 9 Czech meeting recordings (18 to 107 minutes), judged by hand; final round, Opus 5.5
  on the tool path: speakers named 14 of 14 right, 35 of 35 hidden speakers left unnamed, corrections
  46 of 47 right and 1 partly right with none wrong, facts 23 of 24 useful, at most 1.7 minutes per
  60 minutes of recording. Thresholds and every round are in `evaluation.md`.
- Browser checks on the end-to-end stack: review panel and inline marks, vocabulary page, curator
  suggestions, "Use for Learn".

## Consequences & open follow-ups

- **Coverage is low.** 14 of 70 speaker labels were named in the final round; meetings rarely say
  names. Learned nicknames and calendar rosters are the levers (see the Calendar/Meet record).
- **Cold start was missed.** Nothing in the app could create a project, product or term, so the first
  real runs found nothing; the Almanac record fixed it.
- **Known limits at merge, not fixed in PR #69:** people stored surname first are matched as if the
  first word were the first name; the topics job dedupes per recording, so a queued Plaud topics job
  can absorb the other transcript's; names copied between a recording's two transcripts ignore the
  audio each was made from; suggested relation phrases are grouped by words, not meaning; a run's
  tool token stays valid across its job's attempts.
- The last commit of PR #69 fixed the final review round and was not reviewed again; the maintainer
  chose not to.
- `LEARN_AUTO` (the operator flag in PR #69) was removed a day later; see the Almanac record.

## Related work

- [2026-09-14-speaker-identity-without-biometrics](../2026-09-14-speaker-identity-without-biometrics.md):
  the non-biometric boundary Learn inherits.
- [2026-09-28-agent-bridge-cli-providers](../2026-09-28-agent-bridge-cli-providers.md): the bridge the
  tool path runs through.
- [2026-09-30-self-hosted-embeddings](../2026-09-30-self-hosted-embeddings.md): the optional embedding
  service behind vector search.
- [2026-09-30-shared-recording-edited-by-organization](../2026-09-30-shared-recording-edited-by-organization.md)
  and [2026-09-23-shared-organization-scope](../2026-09-23-shared-organization-scope/README.md): who may
  change a shared recording, decided during this work.
- [2026-10-01-almanac-and-new-records](../2026-10-01-almanac-and-new-records.md) and
  [2026-10-01-name-matching-across-word-forms](../2026-10-01-name-matching-across-word-forms.md): the
  cold start and the lookups that followed the first real runs.
- [2026-10-02-almanac-guided-transcript-correction](../2026-10-02-almanac-guided-transcript-correction.md):
  the correction pass after Learn.
- [2026-10-12-calendar-meet-speaker-candidates](../2026-10-12-calendar-meet-speaker-candidates.md): the
  follow-up assignment for calendar context.
- [2026-10-19-learn-review-one-column](../2026-10-19-learn-review-one-column.md): the later review
  layout and its language.
- [2026-09-13-durable-job-queue](../2026-09-13-durable-job-queue.md): the queue Learn runs on, made generic with the knowledge base in mind.
- [2026-10-22-recording-language-checked-by-learn](../2026-10-22-recording-language-checked-by-learn.md): Learn also reports the transcript's language and asks when the provider's is wrong.

## Supporting material

- `evaluation.md`: the thresholds and every evaluation round, per model and path, with the decision
  each round drove. The evaluation accounts and stack were deleted after PR #72 and the recordings
  are private, so the numbers cannot be regenerated.

## Timeline

- **2026-09-24**: the external feasibility analysis reviewed against the code.
- **2026-09-27**: rulings on RLS, shared speakers, the Organization account, fact lifetime, audio-time
  evidence, in-memory matching, vectors and the share gate.
- **2026-09-28**: design and plan written; review round 1 (two reviewers) and the maintainer's
  decisions on it; the shared-recording ownership rule; Phase 1 built.
- **2026-09-29**: Phases 2 to 6 built; thresholds set; auto-adopt and refusals decided; pilot on 9
  recordings with four models; the first-name rule.
- **2026-09-30**: three tuning rounds overnight; PR #69 merged.
- **2026-10-02**: PR #79 merged: the page follows released work, speaker guesses, spreading
  corrections, the recorder as "you".
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
