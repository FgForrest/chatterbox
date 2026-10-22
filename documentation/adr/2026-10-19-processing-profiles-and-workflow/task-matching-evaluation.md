# Task-matching evaluation (2026-10-15)

Evidence for two constants of the processing pipeline: the number of earlier-task candidates a
summary sees (`TASK_CANDIDATE_LIMIT = 40`) and the rule that no suggested match is pre-ticked. The
dataset and harness are outside the repository; these numbers cannot be regenerated from it.

## Setup

- **Data:** 156 synthetic items, 78 Czech and 78 English (75 recordings, 81 mails), in five
  synthetic Organizations with open backlogs of 70 to 96 tasks each; 208 task identities and 332
  labelled events (new, restated, deadline change, vague deadline, done, partial progress,
  ambiguous, recurring, distractor, out of scope, old). Headline numbers use the 144 items that
  passed every realism gate.
- **Path:** the branch's real code at a frozen commit: folder-scoped candidate loading, word-overlap
  ranking, the Summary step, validation and persistence. One model (`gpt-5.6-luna` through the agent
  bridge). Two embedding models served as stand-ins; `bge-m3` itself could not be downloaded.
- **Target from the specification:** pre-ticked matches at least 95 % precise.
- A small real-data sample produced no candidate tasks, so it gave no usable precision estimate.

## K: candidate count

| Measure (word-overlap ranking) | K = 20 | K = 40 | K = 60 |
|---|---:|---:|---:|
| Referenced task among the candidates | 37.4 % (46/123) | 38.2 % (47/123) | 39.8 % (49/123) |
| Match precision | 31.8 % (27/85) | 29.3 % (27/92) | 31.6 % (25/79) |
| Match recall | 28.4 % (27/95) | 28.4 % (27/95) | 26.3 % (25/95) |
| Pre-ticked match precision | 48.6 % (17/35) | 46.7 % (14/30) | 48.6 % (17/35) |

K = 40 is the smallest value within two points of the best on both candidate recall and match
recall. The stand-in embedding models favoured K = 60 by 2.4 points; they were not the production
model, so K stays 40 until `bge-m3` numbers exist.

## Pre-ticking rules at K = 40

Recall is against the 79 clean, single-target match events eligible for pre-ticking.

| Rule | Correct / selected | Precision | Recall |
|---|---:|---:|---:|
| Current rule (the model chose exactly one candidate) | 14/30 | 46.7 % | 17.7 % |
| Current, and no new-task proposal | 7/12 | 58.3 % | 8.9 % |
| Current, and exactly one ticked match | 11/22 | 50.0 % | 13.9 % |
| Exactly one match and no new task | 5/10 | 50.0 % | 6.3 % |
| Never pre-tick | 0/0 | undefined | 0 % |

No non-empty rule came near 95 % (best across K: 61.5 %), so suggested matches are stored for review
and left unticked. Completion and deadline proposals, and evidence from quoted or unverified mail,
were already never pre-ticked (0 of 17 quoted or unverified rows ticked).

## Follow-up experiments (K = 40)

| Variant | Candidate recall | Match precision | Match recall | Pre-ticked precision | Prompt tokens per item | Model latency per item |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 38.2 % | 29.3 % | 28.4 % | 46.7 % | 9,882 | 5.71 s |
| A: stricter matching instruction | 38.2 % | 60.0 % | 18.9 % | 58.8 % (10/17) | 9,985 | 5.54 s |
| B: candidates retrieved per mention | 8.9 % | 9.7 % | 6.3 % | 35.3 % | 17,694 | 10.58 s |
| A and B | 8.9 % | 21.1 % | 4.2 % | 30.8 % | 17,811 | 10.66 s |

Variant A also halved deadline recall and dropped the targeted chronology checks from 7/8 to 2/8.
Variant B adds a second call, and its candidate-free summary emitted no task mention for 50 of 144
items. Neither was adopted.

## Other outcomes at K = 40

| Outcome | Precision | Recall |
|---|---:|---:|
| Completion | 40.0 % (2/5) | 10.5 % (2/19) |
| Concrete deadline | 88.9 % (8/9) | 50.0 % (8/16) |
| Vague deadline phrase | 83.3 % (5/6) | 33.3 % (5/15) |

Chronology (an older statement must not override a newer field): 7 of 8 targeted checks passed;
the failure was a model omission, not persistence accepting an out-of-order update.
