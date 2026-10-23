---
paths:
  - "documentation/adr/**"
---

# Architectural decision records

A feature, optimization, non-trivial fix or refactor that clears the bar below ends with **one record
in `documentation/adr/`** saying what was done, when, why, and how it relates to the rest. The
record replaces the plan it grew out of. Template: `documentation/adr/TEMPLATE.md`. Index and
conventions summary: `documentation/adr/README.md`. `AGENTS.md` carries the short version of this
file; this file is the full rule set.

## Before starting work

Search `documentation/adr/` for the area you are about to touch (`rg -l "src/lib/sync"
documentation/adr/`, or a term) and read the **Consequences & open follow-ups** section of every
hit. Prior decisions and knowingly deferred work live there; a change that contradicts one needs a
new record that `supersedes` it, not a silent reversal. That holds for a change to a single rule of
an older record too (see *Partial reversals supersede* below). A record marked `superseded` may
still be mostly in force: read its opening note to see which rule changed.

## When a record is required: the bar

**The default is no record.** Most work does not clear this bar, and that is the intended outcome:
every low-value record dilutes the folder and trains the next reader to skim past the ones that
matter. A thin ADR is worse than none.

Write one only when **all three** hold. If you are arguing yourself into one of them, the answer is
no.

1. **There was a genuine fork.** A competent engineer might reasonably have chosen a different
   option, and it was rejected for a reason the code does not show. No fork, no decision, no
   record. "It was hard" is not a fork; "we picked B over A because A breaks X" is.
2. **The reasoning outlives the change.** It constrains or informs work *beyond the files you
   touched*: a contract others code against (the `/api/v1` surface, webhook payloads, the deploy
   surface), an invariant a future change could silently break (user scoping, encryption, job
   claiming), an option someone will otherwise re-propose. If the reasoning only matters to someone
   already reading that file, it does not need a record.
3. **Nothing cheaper carries it.** The commit message, and the JSDoc of an exported API, are the
   first choice. Reach for an ADR only when the reasoning has to be findable by someone who does
   not yet know which file to open.

**Size is not the test, in either direction.** A one-line change can clear it: a per-user cap in a
job claim query, chosen over a global cap because one user's backlog starved everyone else, with
the rejected alternatives written down. A two-thousand-line mechanical refactor with no fork in it
does not clear it at all.

### Never a record

Typo and formatting fixes; renames; dependency bumps; regenerated files (migrations, message
catalogs); test fixture tweaks; single-call-site refactors; config changes whose rationale is
obvious from the value itself; documentation edits; copy and translation changes; anything a reader
of the diff plus its commit message would already understand.

### Where sub-threshold reasoning goes

It still gets written down, just not here. `AGENTS.md` decides where (JSDoc on exported APIs only,
no narrative or strategy comments in source, design rationale in the commit message, plus one
exception for constraint comments), so:

- *Why this change*: the commit message, where `git blame` reaches it from the line.
- *Why this exported API behaves this way*: its JSDoc, when the reasoning is part of the contract a
  caller needs.
- *Why this line must stay as it is*: a one-line comment at the site, when a future change could
  silently break a constraint there (a lock order, a literal a partial index depends on, a
  deliberate omission). The next person to touch that line sees it; a record in a folder they do not
  know to open would not stop them. One line, the constraint and not the story.

### Batching

**One record per line of work, not per commit or per PR.** A campaign spanning several PRs gets one
record covering all of them. Several small related changes in one area get **one** record at the
end, if they clear the bar together, not one each. If a sub-threshold change later turns out to
matter, fold it into the next record that covers its area rather than back-filling its own.

## Where and what to name it

- **Default, one file:** `documentation/adr/YYYY-MM-DD-<slug>.md`. The slug is lower-case words
  joined by hyphens.
- **Only when justified, a directory:** `documentation/adr/YYYY-MM-DD-<slug>/README.md` plus
  supporting files, when the work produced *several independent decisions* **and** evidence worth
  keeping. Keep no file that cannot be given a one-line reason in the record's *Supporting
  material* section.
- The record id used in `supersedes`, `superseded-by` and `relates` is the filename without `.md`,
  or the directory name.

**Which date.** The date the decision was **accepted**: normally the merge date of the implementing
PR into `dev` (`git log -1 --format=%ad --date=short <merge-commit>`). Not the date the document was
written, not the day the work started. Tie-breaks: several PRs, the last one that completed the
line of work; decision accepted but not yet implemented, the date it was accepted, with
`status: proposed`; never merged, the date it was abandoned, with `status: rejected`.

`date:` never changes once set, and must match the date in the filename; the index generator fails
when they disagree. `updated:` carries date **and** time (`YYYY-MM-DD HH:MM`, local time) and moves
with every substantive edit.

## Front matter

Required on every record. It is what makes the folder greppable (`rg -l "status: proposed"
documentation/adr/`) and the index generated rather than hand-maintained:

```yaml
title, date, updated, status, kind, issues, prs, areas, supersedes, superseded-by, relates
```

- `status`: `accepted` | `partially-implemented` | `proposed` | `superseded` | `rejected` | `reverted`
- `kind`: `feature` | `optimization` | `fix` | `refactor` | `infrastructure` | `process`
- `issues`, `prs`: plain numbers of this repository's GitHub issues and PRs (`[214]`). A reference
  to upstream Riffado goes in the body as `riffado/riffado#203`, never in these lists.
- `areas`: repository paths the decision lives in (`src/lib/sync`, `src/db/schema.ts`,
  `docker-compose.yml`), at least one, so `rg` finds the record from a file path.
- Use `[]` for empty lists rather than omitting the key. Values are flat: one `key: value` per line,
  lists as `[a, b]`. Quote a title that contains ` #`, or YAML reads the rest as a comment.

## Content rules

Sections and their required/omit-if-empty status are defined in `documentation/adr/TEMPLATE.md`.
Beyond that:

- **Delete sections you have nothing for.** Never leave "N/A": a record padded with empty headings
  teaches the next reader to skim past them.
- **Options considered must be honest.** Record the alternative that was genuinely on the table
  with its real advantages. Do not invent a strawman to fill the section; if there was one viable
  path, say so in a sentence.
- **Every rejection carries its reason, next to the option it rejects.** A declined option gets a
  **Rejected because** line; a campaign's *Rejected outright* table gets a filled *Rejected
  because* column. Name the concrete blocker (it breaks `docker compose up` for self-hosters, it
  needs a second service, it is not multi-process safe, a measurement came back flat), not a
  preference, and say what would have to change for it to be worth revisiting. An unexplained veto
  is worse than no entry: the next agent re-proposes it, or worse, obeys it without knowing whether
  it still applies.
- **Key technical details stay shallow.** Entry points, invariants, and anything that will look
  like a bug to someone who wasn't here. Pointers to code, not a re-description of it: the code is
  the source of truth and the record must not rot alongside it.
- **Quote numbers in Verification.** Name the test that proves it; for optimizations give
  before/after and the conditions they were measured under.
- **Cross-link in both directions.** Adding `relates`/`supersedes` to a new record means editing the
  older one too, and bumping the older record's `status` to `superseded` plus its `superseded-by`.
  The generator fails on a one-sided link.
- **Partial reversals supersede.** As soon as a later decision changes any rule of a record, even
  one rule among many, the older record gets `status: superseded` and the newer record in
  `superseded-by`, and the newer record lists the older one in `supersedes` (not in `relates`). A
  record may be superseded by several records. Both sides say in prose which rule changed: the older
  record in a short **Superseded in part** note after its opening paragraph that names the changed
  rule, links the newer record and says the rest still holds; the newer record next to the link in
  *Related work*. A follow-up that only adds to a record, or implements one of its deferred items,
  is `relates`.
- **Regenerate the index** in the same commit: `node scripts/generate-adr-index.mts` (or
  `pnpm adr:index`). Never hand-edit the table between the `ADR-INDEX` markers; it is overwritten.
  Issue and PR refs link to the GitHub repository named in `package.json`; `--plain` renders them
  as plain `#n`. `--check` (`pnpm adr:index:check`) verifies that the index is current and that
  every record is valid, writes nothing, and runs in CI's lint job.

## No real names, company name or production identifiers in records

**A record must contain no detail that identifies a person, the operating company, or a production
system.** The measurement stays; the attribution goes. This applies to the record, its supporting
files, its *filenames*, and the **commit messages** that carry it: a name scrubbed from the prose
but left in `git log` has not been scrubbed.

This is the ADR-specific half of the public-repository rule in `AGENTS.md`, which also covers code,
fixtures, tests, docs and PR text and lists what is deliberately exempt (upstream Riffado
attribution, the repository's own GitHub and image identifiers). Recording, mail and Almanac
content is personal data by nature, so this folder is where it most often leaks: reconstructed
history quotes meetings, screenshots and production rows.

A record is written to be read by someone who was not there, and a person's identity is never the
part that helps them. What helps is the workload: how many recordings, how long, how the data was
shaped, what the pipeline did with it.

**Forbidden**: names of real people (colleagues, meeting participants, speakers, Almanac entries,
mail senders), whether standalone or embedded in an identifier, fixture or branch name; the company
name and its domain; production hostnames, server paths, account e-mails, recording, mail or user
ids, and the titles or content of real recordings, mails, summaries and tasks; anything a person
could paste into a search box and hit a real record; and private operations material (cite it as
"(internal, §X)", never link or quote it).

**Keep, always**: every number, ratio and distribution. Recording counts and durations, transcript
lengths, token counts and costs, queue depths, latency and speedup, test counts. None of it
identifies anyone, and stripping it would gut the record.

**How to say it instead.** Describe the workload, not the people: "a self-hosted production
instance with about 1,200 recordings and 40 Organization members", "a 90-minute Czech meeting with
six speakers". Where two cases must be told apart across a record, label them by shape or by letter
("the lecture recording" and "the board meeting", or "user A"/"user B") and define the label once.
For sample data, give the *shape* and never the value ("a Czech surname with diacritics", "a
13-digit number"), or an invented stand-in that keeps the property the reader needs (`Jitka
Dvořáková`, `Acme s.r.o.`, `example.com`).

**Generic vocabulary is fine.** Domain words (`recording`, `speaker`, `summary`, `task`, `folder`,
`Organization`) and vendor names used factually (Plaud, OpenAI, Keycloak) tell the reader which
shape of problem the finding applies to. A folder, profile or Almanac name that carries a real
customer's or person's identity is not: rename it to a generic equivalent and say you did.

**When you find a violation in an existing record**, say so rather than fixing it silently: the
anonymization may need a decision about which label to use, and a record whose history quietly
diverges from its content is worse than one that is openly wrong. Anonymizing history is a
rewrite, and a rewrite is the maintainer's call, not yours.

## Plans, and the two ways they end

Plans and TODOs that must survive a session go into GitHub Issues (`AGENTS.md`). In-flight working
notes (design drafts, implementation plans, agent briefs, review outputs) live in **`docs/plans/`**,
and nowhere else, one file or folder per line of work, prefixed with the date
(`docs/plans/2026-10-22-<slug>.md`). That folder holds *intent*, never outcome: nothing in it is
evidence of what shipped, and it must never be read as such.

**Plans are never committed.** `.gitignore` excludes every `plans/` directory, so a plan is working
notes on disk and nothing more, and it exists only in the checkout where it was written: a worktree
does not see the main checkout's plans. This is mechanical rather than a matter of discipline on
purpose: a rule that a routine command silently violates is not a rule.

**Every plan must leave the disk when its work finalizes**: merged, abandoned, or decided against.
Once its work is implemented, a plan has no value of its own; only its lasting content does (the
whys, the rejected options and why they lost, measurements), and that moves into a record or the
commit message. There are exactly two exits, and no third:

1. **It becomes a record**, if the work clears the bar above. Write the ADR, then delete the plan.
2. **It is deleted outright**, if the work does not. The commit message of the last change carries
   anything worth keeping.

**Because the plan is not in git, deleting it is irreversible.** Nothing can be recovered from
history afterwards, so everything of lasting value must be inside the record *before* the plan
goes: the rejected options and why they lost, measurements that cannot be regenerated, ordering
hazards a future step could trip over. Read the plan through once against the finished record and
ask what would be unrecoverable, rather than deleting on the assumption it was all captured.

**A plan left behind is worse than no plan at all.** It reads as current intent, and the next reader
cannot tell whether it shipped, half-shipped, or was dropped; they have to re-derive that from git,
which is the exact cost this convention exists to remove.

**A partially implemented plan is usually a record, not a deletion.** When some items shipped and
others were dropped, the dropped ones carry a rejection reason that git cannot show and that someone
will otherwise re-propose. That is a genuine fork, and it clears the bar. Write down *why* they
lost, not merely that they did.

Keep only material with future value that a record cannot absorb: measurements that cannot be
regenerated, reproduction scenarios, review verdicts that were relied on. Never keep raw logs, HAR
files, profiler output, or screenshots of production data; capture their conclusions and drop the
bytes.

## Commit

Commit the record together with the implementation (preferred), or as
`docs: record <decision> as an ADR` in the same PR. The record must not land in a later PR than the
work it describes, except when it is reconstructed for work that merged before this convention.
Follow the Git rules in `AGENTS.md`: specific paths only, `fixes #<n>`/`closes #<n>` when the commit
closes an issue.
