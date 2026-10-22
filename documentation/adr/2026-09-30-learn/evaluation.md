# Learn evaluation, 2026-09-29 to 2026-09-30

Supporting material for [the Learn record](README.md). The recordings are private and the
evaluation accounts were deleted afterwards, so these numbers cannot be regenerated; they are kept
because several Learn rules were decided from them.

## The set

- 9 recordings, all Czech meetings, 18 to 107 minutes: the whole library of one self-hosted
  instance at the time.
- **Speaker truth:** 47 speaker attributions the owner had confirmed by hand.
- **Corrections and facts:** 157 corrections and 121 facts drafted from the transcripts, then judged
  by the owner: of the corrections 1 rejected and 6 edited; of the facts 1 rejected, 25 edited and 8
  marked correct but not useful (a current task, or too detailed).
- **Accounts**, each seeded from the same recordings:
  - *cold*: people known, no organizations, projects, products or terms;
  - *warm*: the same plus about 60 known things;
  - *anon*: every one of the 17 speaking people hidden from the knowledge base, which gives 35
    abstention cases. It replaced an earlier *hidden* account with only 3 hidden people, after the
    owner pointed out that a percentage over 3 cases means nothing.

## Thresholds for offering automatic Learn

Set by the maintainer on 2026-09-29 as a starting point:

| Measure | Threshold |
|---|---|
| Speaker precision | at least 95% |
| Abstention (an unknown speaker left unnamed) | at least 90% |
| Pre-ticked correction precision | at least 95% |
| Fact usefulness | at least 70% |
| Leakage across scopes | 0 |
| Time per 60 minutes of recording | at most 5 minutes |

## Rounds

### Pilot: four models, fallback path, 84 runs

| | Sonnet 5.5 | gpt-5.6-luna | Opus 5.5 | gpt-5.6-terra |
|---|---|---|---|---|
| Speakers named right, incl. the hidden one misnamed | 5/8 | 12/16 | 13/16 | 11/13 |
| Abstention (hidden account) | 2/3 | 2/3 | 2/3 | 2/3 |
| Corrections right | 40/45 | 25/33 | 71/76 | 15/17 |
| Facts useful (warm account only) | 3/3 | 11/14 | 26/30 | 13/17 |

- Coverage: 6 to 16% of speaker labels named at all. Nothing pre-ticked by any model. At most
  3.3 minutes per 60 minutes.
- Every wrongly named speaker had been resolved from a first name alone, and all four models gave
  the one hidden person the name of the only known person sharing that first name.
- Conclusion: the misses were Learn's rules, not the models': first-name resolution, the first
  window's speaker answer winning over later ones, and a lookup budget of 60 that cut long
  recordings.
- **Decided from it:** a first name alone is suggested with a mark, never pre-ticked; speaker
  answers join across windows; the lookup budget rose to 160; a separate "Use for Learn" model.

### Round 1: Opus 5.5 and gpt-5.6-terra, fallback path, anon account added

- Abstention 35 of 35 for both models.
- Speakers right: Opus 8 of 10, Terra 11 of 19. Every wrong name carried the first-name mark;
  unmarked names were 3 of 3 right. The errors were two known people sharing one first name.
- Corrections were flooded with links on first names (a prompt fault), so they were not judged.
- **Decided from it:** a first-name-only speaker is dropped when two known people share the first
  name; no person links on a first name alone.

### Round 2: fallback path

| | Opus 5.5 | gpt-5.6-terra |
|---|---|---|
| Speakers named right | 7/7 | 6/7 |
| Abstention | 35/35 | 35/35 |
| Corrections | 102 right and 5 partly right of 107, none wrong | 41 of 52 right, 5 wrong |
| Facts useful | 25/28 (1 wrong) | 8/8 |

About 3 minutes per 60 minutes.

### Pre-tick pass

The warm reviews of round 2 were finished as the owner would finish them and Learn was run again.
7 corrections came back pre-ticked: 3 right, 4 that rewrote an inflected heard form to the record's
base name, which is only partly right in Czech. **Decided from it:** a pre-tick must write exactly
the record's name, word for word; with that rule those 4 are no longer pre-ticked.

### Round 3: Opus 5.5 on the tool path (agent bridge with MCP tools)

| | Opus 5.5, tool path | gpt-5.6-terra |
|---|---|---|
| Speakers named right | 14/14 | 9/9 |
| Abstention | 35/35 | 35/35 |
| Corrections | 46 right and 1 partly right of 47, none wrong | 43 of 47 right, 3 wrong |
| Facts useful | 23/24 | 3/4 |
| Time per 60 minutes, at most | 1.7 min | 2.8 min |

The working notes record one tally of 45 of 47 for Opus corrections; the PR description gives 46
right and 1 partly right. Coverage stayed the limit: 14 of 70 speaker labels named.

**Verdict:** the thresholds were met on these nine recordings, with the caveat that the sample is
small. Pre-ticked correction precision was measured only in the pre-tick pass above (3 of 7 right
before the rule was tightened); no later round measured it again. **Decided from it:** Learn runs Opus 5.5 through the tool path; summaries stay on a cheaper
model.
