# Architectural decision records

A change to Chatterbox that made a real decision (a feature, optimization, non-trivial fix or
refactor where a competent engineer could have gone another way) leaves one record here explaining
**what was done, when, why, and what it relates to**. A record replaces the plan it grew out of:
plans describe intent that may never have shipped, records describe what actually happened. Most
changes need no record; the commit message carries them.

- **Writing one:** [`TEMPLATE.md`](TEMPLATE.md), in two shapes: point decision and campaign.
- **Rules** (when a record is required, which date it carries, what to keep and what to delete,
  what must never appear in one): [`.claude/rules/adr.md`](../../.claude/rules/adr.md).
- **Starting new work?** Search here first: `rg -l "<path or term>" documentation/adr/`, then read
  the **Consequences & open follow-ups** section of every hit. That is where the known traps and
  the deliberately deferred work live.

## Conventions in one paragraph

A record is `YYYY-MM-DD-<slug>.md` in this folder. The date is when the decision was **accepted**,
normally the merge date of the implementing PR, so `ls` reads chronologically. When a line of work
produced several decisions *and* evidence worth keeping, it becomes `YYYY-MM-DD-<slug>/` with the
record at `README.md` and the evidence beside it, never more files than earn their place. Every
record opens with YAML front matter (`title`, `date`, `updated`, `status`, `kind`, `issues`, `prs`,
`areas`, `supersedes`, `superseded-by`, `relates`), which is what makes this folder greppable
(`rg -l "status: proposed" documentation/adr/`, `rg -l "areas:.*src/lib/sync" documentation/adr/`)
and the index below generated rather than hand-maintained. Records are public: no real names, no
company name, no production identifiers.

## Index

Newest first. **Generated** by `node scripts/generate-adr-index.mts` from each record's front
matter: edit the records, then re-run it; edits made directly to the table are overwritten.
`node scripts/generate-adr-index.mts --check` writes nothing and fails when the table is stale, a
record misses a front-matter field, a filename date disagrees with `date:`, a value is not one of
the allowed ones, or a `supersedes`/`relates` link is not mirrored by the record it names.

<!-- ADR-INDEX:START -->

| Date | Record | Kind | Status | Refs |
|------|--------|------|--------|------|
| 2026-10-22 | [AGENTS.md stays the single source of agent rules, area rules move to path-scoped files, and decisions are recorded as ADRs with a generated, checked index](2026-10-22-agent-instructions-and-decision-records.md) | process | accepted | PR #245 |
| 2026-10-22 | [Curators get a duplicate queue in the Almanac and every folder shows its knowledge read-only](2026-10-22-almanac-curator-desk.md) | feature | partially-implemented | #240, PR #244, PR #247 |
| 2026-10-22 | [An arriving recording or e-mail never moves the selection; one corner notice offers to open the newest](2026-10-22-arrivals-never-move-selection.md) | feature | accepted | PR #235, PR #236 |
| 2026-10-22 | [Every Learn run uses the Calendar and Meet roster to guess speakers for the user to confirm](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md) | feature | accepted | PR #250 |
| 2026-10-22 | [The dashboard's library column browses by location, with a folder rail from 1280 px, walk-in folders below it, and one Organization colour](2026-10-22-library-column/README.md) | feature | accepted | PR #226, PR #228, PR #237 |
| 2026-10-22 | [Meeting Recorder 0.7.0 asks inside the meeting page and points at its own icon, because only an extension invocation records a tab without Chrome's dialog](2026-10-22-meeting-recorder-banner.md) | feature | accepted | PR #249 |
| 2026-10-22 | [A finished private Learn review becomes Organization knowledge on share, without asking; curators clean up](2026-10-22-organization-almanac-grows-on-share.md) | feature | accepted | #240, PR #248 |
| 2026-10-22 | [The owner keeps editing a recording shared with the Organization, as a curator of that recording](2026-10-22-owner-edits-shared-recording.md) | feature | accepted | PR #221 |
| 2026-10-22 | [The owner reviews a summary's tasks, the assignee never has to accept anything, and sharing does not wait for the review](2026-10-22-owner-reviews-tasks-sharing-ungated.md) | fix | accepted | PR #238 |
| 2026-10-22 | [Private recordings and mail reach colleagues only through accepted invitations, separately from Organization sharing](2026-10-22-person-to-person-sharing.md) | feature | partially-implemented | #260 |
| 2026-10-22 | [A pipeline step names its job and the worker settles both, one reconciler repairs drift, and the server says what each step waits for](2026-10-22-pipeline-steps-settle-their-jobs.md) | fix | accepted | PR #209, PR #216, PR #220, PR #221 |
| 2026-10-22 | [Generated text follows the language the transcript is written in; Learn asks when the provider's language is wrong, and the answer is stored per recording](2026-10-22-recording-language-checked-by-learn.md) | fix | accepted | PR #246, PR #251 |
| 2026-10-22 | [Summaries and titles read the same transcript the pipeline chose, own first, then the user's edit, then Plaud's](2026-10-22-summary-reads-the-preferred-transcript.md) | fix | accepted | PR #243 |
| 2026-10-21 | [Curators manage existing Organization Almanac entries; their new entries stay private](2026-10-21-curators-manage-organization-almanac.md) | fix | accepted | PR #222 |
| 2026-10-21 | [Meeting Recorder as a Chromium extension with encrypted buffering, released ahead of the servers it talks to](2026-10-21-meeting-recorder-extension/README.md) | feature | accepted | PR #108, PR #123, PR #124, PR #125, PR #130, PR #132, PR #163, PR #180, PR #188, PR #193, PR #195, PR #198, PR #207, PR #213 |
| 2026-10-21 | [A summary's tasks are accepted automatically and sharing no longer waits for a task review](2026-10-21-tasks-accepted-automatically.md) | feature | superseded by [2026-10-22-owner-reviews-tasks-sharing-ungated](2026-10-22-owner-reviews-tasks-sharing-ungated.md) | PR #224 |
| 2026-10-20 | [The Learn review is one column of stacked sections, written in the reviewer's language](2026-10-20-learn-review-one-column.md) | feature | accepted | PR #82, PR #172, PR #173, PR #175, PR #194, PR #199 |
| 2026-10-20 | [Mail search reads forwarded and quoted parts but never more than the caller may already see](2026-10-20-mail-search-respects-visibility.md) | feature | accepted | PR #185, PR #186, PR #191, PR #197 |
| 2026-10-19 | [AI cost is priced from the provider card that made the call, recorded once and never repriced, and shown for every payer](2026-10-19-ai-cost-per-provider-card.md) | feature | accepted | PR #77, PR #78, PR #85, PR #170, PR #179 |
| 2026-10-19 | [The setup wizard on a self-hosted Organization is built for employees, skips what the Organization provides, and reads readiness from the pipeline's own resolver](2026-10-19-employee-first-onboarding.md) | feature | accepted | PR #136, PR #182 |
| 2026-10-19 | [One body per widget across its variants, tested by one suite per variant set; an erase never undoes Almanac data a person confirmed](2026-10-19-one-widget-for-recordings-and-mail.md) | refactor | accepted | PR #164, PR #165, PR #166, PR #167, PR #168 |
| 2026-10-19 | [Items are filed before anything is processed, and a processing profile is a recipe with one automatic switch per step](2026-10-19-processing-profiles-and-workflow/README.md) | feature | accepted | PR #134, PR #135, PR #138, PR #139, PR #140, PR #141, PR #145, PR #156, PR #159 |
| 2026-10-19 | [Organization providers are every member's defaults per role, explicit choices fail loudly, and nothing falls back to a hard-coded model](2026-10-19-provider-defaults-and-no-fallback.md) | feature | accepted | PR #70, PR #76, PR #144, PR #153, PR #178 |
| 2026-10-19 | [One app header on every page with search scoped to the page, and topics as a chapter bar with a list instead of arrows](2026-10-19-transcript-card-and-one-header.md) | feature | accepted | PR #183, PR #184 |
| 2026-10-18 | [Inbound mail through an own MX into one pile with recordings, on an item supertype and a kind-neutral content model](2026-10-18-inbound-mail/README.md) | feature | accepted | PR #110, PR #114, PR #121, PR #142, PR #146 |
| 2026-10-18 | [The product names itself per deployment through one deployment-aware name, and self-host stops showing upstream names](2026-10-18-per-deployment-product-name.md) | feature | accepted | PR #50, PR #101, PR #103, PR #149 |
| 2026-10-14 | [Opt-in identity-provider authorization with access managed under the administrator's own sign-in](2026-10-14-identity-provider-authorization.md) | feature | accepted | PR #131 |
| 2026-10-12 | [Calendar invitees and Meet participants reach Learn only as speaker candidates, never as proof](2026-10-12-calendar-meet-speaker-candidates.md) | feature | superseded by [2026-10-22-calendar-speaker-guesses-in-automatic-runs](2026-10-22-calendar-speaker-guesses-in-automatic-runs.md) | PR #105, PR #106, PR #107, PR #117 |
| 2026-10-12 | [Every push to main is a calendar-versioned release (YYYY.N); dev is the integration branch](2026-10-12-calver-releases-from-dev.md) | process | accepted | PR #119, PR #120 |
| 2026-10-11 | [Claude and Claude Code reach MCP through the SSO realm, with a confidential client and a narrow public entrance](2026-10-11-claude-connector-through-sso-realm.md) | feature | accepted | PR #109 |
| 2026-10-11 | [Production dependencies come from well-known publishers or our own code, and installs wait seven days and refuse provenance downgrades](2026-10-11-dependency-supply-chain-policy.md) | process | accepted | PR #10, PR #99, PR #112, PR #113, PR #115 |
| 2026-10-07 | [Backups and exports carry one scope, chosen by the account, personal or Organization, never both](2026-10-07-backup-scope.md) | feature | accepted | PR #89 |
| 2026-10-07 | [External MCP server in the app, gated by Keycloak client roles from the SSO realm](2026-10-07-external-mcp-server.md) | feature | accepted | PR #98 |
| 2026-10-07 | [Play a transcript sentence from a gutter control, and keep transcript and player on one position in both directions](2026-10-07-sentence-playback-two-way-sync.md) | feature | accepted | PR #75, PR #90 |
| 2026-10-07 | [Tasks come out of the summary call, the owner reviews them, and they reach other people only through the Organization](2026-10-07-tasks-from-summaries.md) | feature | superseded by [2026-10-22-person-to-person-sharing](2026-10-22-person-to-person-sharing.md) | PR #91, PR #92, PR #93 |
| 2026-10-06 | [Folder exports keep a ledger of what they wrote and move it, instead of never deleting anything](2026-10-06-export-ownership-ledger.md) | fix | accepted | PR #87 |
| 2026-10-06 | [Self-host sign-in through one OpenID Connect provider, password login switched off](2026-10-06-oidc-single-sign-on.md) | feature | accepted | PR #88 |
| 2026-10-05 | [Topics exist only for timed transcripts and take their times from the transcript; lecture paragraphs are cut at display time](2026-10-05-timed-turns-topics-and-paragraphs.md) | feature | accepted | #202, PR #57, PR #58, PR #59, PR #86 |
| 2026-10-02 | [The Almanac corrects transcripts twice; ranked key terms go to the transcription provider, and an agent pass after Learn fixes what is left](2026-10-02-almanac-guided-transcript-correction.md) | feature | accepted | PR #80, PR #81, PR #83 |
| 2026-10-01 | [Learn gets a cold start; it proposes the people and things it hears, and the Almanac is editable by hand](2026-10-01-almanac-and-new-records.md) | feature | accepted | PR #72 |
| 2026-10-01 | [Names are matched across word forms in memory, with ported accent-free stemmers and Snowball stemmers](2026-10-01-name-matching-across-word-forms.md) | feature | accepted | PR #72 |
| 2026-09-30 | [Learn proposes knowledge from transcripts for a person to confirm; knowledge stays encrypted and is searched in memory](2026-09-30-learn/README.md) | feature | accepted | PR #69 |
| 2026-09-30 | [Learn's embeddings come from an optional self-hosted Ollama service serving bge-m3, not text-embeddings-inference](2026-09-30-self-hosted-embeddings.md) | infrastructure | accepted | PR #69 |
| 2026-09-30 | [A shared recording is one set of rows that the Organization edits; the owner reads, withdraws or erases it](2026-09-30-shared-recording-edited-by-organization.md) | feature | superseded by [2026-10-22-owner-edits-shared-recording](2026-10-22-owner-edits-shared-recording.md) | PR #69 |
| 2026-09-28 | [Claude Code and Codex subscriptions serve summaries through a locked-down, locally built sidecar](2026-09-28-agent-bridge-cli-providers.md) | infrastructure | accepted | PR #11, PR #12, PR #13, PR #63 |
| 2026-09-28 | [Export folders to Google Drive on self-host only, through a general Google connection with drive.file and the Picker](2026-09-28-google-drive-export.md) | feature | accepted | PR #61 |
| 2026-09-27 | [Large video uploads stream as a raw request body outside the Next proxy, with memory measured under Bun](2026-09-27-stream-uploads-under-bun.md) | fix | accepted | PR #62 |
| 2026-09-23 | [Shared Organization scope on self-host, with a dedicated Organization account and nothing copied](2026-09-23-shared-organization-scope/README.md) | feature | accepted | PR #53 |
| 2026-09-14 | [Speakers are identified from names and calendar rosters, never from voiceprints](2026-09-14-speaker-identity-without-biometrics.md) | feature | accepted | PR #25 |
| 2026-09-13 | [Work that must outlive its process runs from a generic Postgres job table, not inside the request](2026-09-13-durable-job-queue.md) | infrastructure | accepted | PR #17, PR #18, PR #19, PR #20, PR #23 |
| 2026-09-13 | [Transcription providers that are not OpenAI-compatible get a native adapter chosen by transcriptionStyle, not a proxy](2026-09-13-native-transcription-adapters.md) | feature | accepted | PR #24 |

<!-- ADR-INDEX:END -->
