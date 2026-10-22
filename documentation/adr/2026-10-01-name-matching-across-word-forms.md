---
title: Names are matched across word forms in memory, with ported accent-free stemmers and Snowball stemmers
date: 2026-10-01
updated: 2026-10-22 17:05
status: accepted
kind: feature
issues: []
prs: [72]
areas: [src/lib/knowledge/stemming, src/lib/knowledge/name-match.ts, src/lib/learn/name-match.ts, scripts/snowball-stemmers.sh, NOTICE]
supersedes: []
superseded-by: []
relates: [2026-09-30-learn, 2026-10-01-almanac-and-new-records, 2026-10-11-dependency-supply-chain-policy, 2026-10-22-almanac-curator-desk]
---

# Names are matched across word forms in memory, with ported accent-free stemmers and Snowball stemmers

Learn looks up the names it hears in the Almanac. In languages with case endings a name is rarely
said in its base form (a company name in the genitive, a first name in the vocative), and the
lookups found nothing. Lookups now stem both sides in the transcript's language: Czech, Slovak,
Polish and Romanian with variant stemmers ported from a Java project credited in `NOTICE`, which read
words without accents and
return every stem the word could have had; about twenty other languages with Snowball's stemmers;
English not at all. Nicknames that no stemmer can join are learned from the reviewer's links. PR #72
built it (Block 4); a follow-up under the dependency policy, PR #113, replaced the third-party
Snowball package with Snowball's official release, vendored and rebuilt from pinned source.

## Why

- An evaluation round showed the no-tools fallback missing names it was given, because it looked
  them up in the form the transcript used: inflected company names, vocative first names, a name
  in the instrumental case.
- The existing matcher (exact, all words, length-scaled edit distance, trigram similarity at least
  0.4) already tolerated typos. Endings on short names dropped the trigram score below the floor.
- **The constraint:** people's and things' names, nicknames and vectors are encrypted at rest with
  the app's key. Postgres sees ciphertext, so matching has to happen in the app, on the decrypted
  per-scope cache Learn already keeps (see the Learn record).

### Previous state

The Learn design ruled that server code holds no per-language rule: word forms, nicknames and
addressing were left to the model, and the matcher compared normalized words the same way for
every language. The 2026-09-13 speaker plan had instead proposed a rule-based Czech declension
plus a seed table of the fifty most common Czech diminutives; Learn's language-neutral rule
replaced that before it was built.

## Options considered

### Option A: Postgres full-text search or `pg_trgm` (declined)

- **Pros:** standard, indexed.
- **Cons:** Postgres has no built-in Czech stemmer (Snowball has none; a Czech ispell dictionary
  would have to be installed), and full-text search tolerates no typos.
- **Rejected because:** the names are encrypted, so Postgres cannot index them at all. It would need
  plaintext names in the database, which the encryption rule forbids.

### Option B: strip endings from Learn's own Czech ending list as a second try (declined)

Proposed as the cheapest fix, next to asking the model for base forms: the ending list in
`src/lib/learn/name-match.ts` already existed.

- **Rejected because:** the maintainer pointed to those Java variant stemmers, which are verified
  against large word lists, and asked for more languages than Czech. (The ending list remains, for
  Learn's own checks of whether transcript words are a known name.)

### Option C: meaning search with embeddings (declined)

- **Rejected because:** for short names it is a weak signal and costs an embedding call per lookup;
  the embedding service is optional; and the Learn ruling is that names are matched by their words,
  never by vectors.

### Option D: a clean port of Lucene's `CzechStemmer` with home-made accent handling (declined)

- **Pros:** Apache-2.0, no licence question.
- **Cons:** Lucene's stemmer needs the accents, which people and transcription often leave out; it
  would not reuse the variant logic the Java original had already verified.
- **Rejected because** the port of the Java stemmers was the better algorithm and their copyright holder
  contributed the ports under this project's licence (recorded in `NOTICE`; the original files carry
  a different licence header).

### Option E: ported variant stemmers plus Snowball (chosen)

Czech, Slovak, Polish and Romanian use the Java variant stemmers ported to TypeScript. Other
languages Snowball supports stem the word as written, then drop its accents. English is not
stemmed: its names take no case endings, and stemming would turn "Hughes" into "Hugh" and
"Williams" into "William".

### Option F: where Snowball comes from

PR #72 used the `snowball-stemmers` npm package (ISC), a third-party port. PR #113 replaced it with
the JavaScript that Snowball 3.1.1 itself generates, vendored in
`src/lib/knowledge/stemming/snowball` and rebuilt by `scripts/snowball-stemmers.sh` from
snowballstem.org's sha256-pinned source.

- **Rejected (the npm port) because:** it came from a small third-party source, and the maintainer's
  rule is that no future malicious version may slip in from an untrusted publisher. Porting it by
  hand was too many lines; building from the official source was the safe option.
- **Slovene:** the old package had a Slovene stemmer, Snowball and the Java stemmers have none. Copying only
  that one file (ISC, not Snowball's code) was offered and declined; Slovene names are now matched
  without stemming, as English is.

## Decision

**Chosen: E.** Snowball's source was switched to the official release in a follow-up (F). The ported stemmers fit the
matcher, which strips accents before comparing, and the encryption rule leaves in-memory matching as
the only place to do it. The fallback also asks the model for each mention's base form and for the
full name a nickname stands for, and looks those up only when the words themselves find nothing.

Nicknames (a diminutive such as "Bob" for "Robert"), compounds and sound-alikes are not word forms, so no stemmer joins
them. The reviewer teaches the Almanac instead: when a review links a proposal to a known record,
Finish saves the heard name as that record's nickname, unless the lookups would already find it by
that name. The 2026-09-13 diminutive table was not revived; the maintainer's answer to nicknames
was that a user adds one once and it matches from then on.

## Key technical details

- **Entry points:** `src/lib/knowledge/stemming/index.ts` (language to stemmer, ISO 639-2/-3 codes
  and English names accepted as aliases), `czech.ts`, `slovak.ts`, `polish.ts`, `romanian.ts`, the
  vendored `snowball/`; `NameIndex` in `src/lib/knowledge/name-match.ts` adds the `stem` and `part`
  match reasons. `detect-language.ts` supplies a language where the content has none.
- **Stems are computed at lookup and never stored**, so changing a stemmer needs no migration. They
  are memoized in a bounded cache.
- **Never edit the Snowball files by hand.** `scripts/snowball-stemmers.sh --check` compares them
  with what the pinned release generates; `--write` replaces them. A new release means changing the
  version, checksums and commit in the script.
- **Licences:** `NOTICE` credits the Java variant stemmers, Apache Lucene (the Czech ending tables) and Snowball
  (BSD 3-Clause, text in `snowball/COPYING`).
- **Looks like a bug, is intended:** English and Slovene are compared without stemming.

## Verification

- Polish and Romanian ports byte-identical to the Java originals on 2.2 million and 1.5 million
  words; Czech and Slovak covered by declension tables (PR #72). Tests:
  `src/tests/knowledge/stemming/` (one file per ported language plus `index.test.ts`),
  `src/tests/knowledge/name-match.test.ts`, `src/tests/learn/name-match.test.ts`.
- Evaluation on the account with 61 known things, fallback path: precision of new records 64%
  before the word-form lookups, 72% after; duplicates of known records 15 before, 7 after, all
  sound-alikes or nicknames (judged by hand, PR #72).
- PR #113: `scripts/snowball-stemmers.sh --check` reports the committed stemmers are Snowball
  3.1.1's; stemming tests pass on Node 24, Node 22 and under Bun 1.4. On Snowball's own vocabulary
  lists the share of words whose stem changed with Snowball 3.x: Dutch 46% (a new Dutch algorithm),
  Turkish 10%, Italian 6%, French 4%, German 3.5%, Swedish 2%, others under 1%.

## Consequences & open follow-ups

- **The language-neutral rule is relaxed for lookups.** Server code now holds per-language stemming,
  and `src/lib/learn/name-match.ts` holds Czech-specific rules for Learn's own name checks. The
  model still judges nicknames and addressing.
- Sound-alikes stay unmatched until a reviewer links one; the warm evaluation account kept 7 such
  duplicates.
- Matching stays in memory; a directory of tens of thousands of names would need the blind-index
  option the Learn record lists as deferred.

## Related work

- [2026-09-30-learn](2026-09-30-learn/README.md): the in-memory, encrypted knowledge store and the
  "names by words, never by vectors" rule this builds on.
- [2026-10-01-almanac-and-new-records](2026-10-01-almanac-and-new-records.md): Blocks 1 to 3 of the same
  PR; new-record precision is where the gain was measured.
- [2026-10-11-dependency-supply-chain-policy](2026-10-11-dependency-supply-chain-policy.md): the policy
  under which the Snowball package was replaced by its official source.
- [2026-10-22-almanac-curator-desk](2026-10-22-almanac-curator-desk.md): reuses this matcher's signals to rank duplicate candidates.

## Timeline

- **2026-10-01**: an evaluation round shows lookups missing inflected names; the ported stemmers and
  Snowball built as Block 4, re-evaluated and merged with PR #72.
- **2026-10-11**: follow-up PR #113 merged under the dependency policy: official Snowball 3.1.1
  vendored, Slovene dropped.
- **2026-10-22**: reconstructed from session history, memories and PR descriptions.
