---
title: Statistics
description: Recorded time, processing, costs and storage across your account and the team.
---

Open **Statistics** in the footer of any signed-in screen. The page starts with the last 90 days, using **Organization** when it is available and **Mine** otherwise.

## Whose data

- **Mine** includes your recordings, mail and tasks, your own Almanac entries, and AI requests paid by your account. Organization-paid processing of your private items appears in **Organization**'s spend, not yours.
- **Organization** includes items currently shared in Organization folders, Organization-owned Almanac entries, and requests paid by the Organization. The people ranking measures members' contributions to the Organization. An item filed in several Organization folders is counted once.
- **Everyone** includes every account's items, including private items, as numbers only. The people ranking is visible to every signed-in member. This view never reveals item titles, mail headers, transcripts, summaries or task text.

**Organization** and **Everyone** exist only on a shared self-hosted instance. **Organization** also needs an Organization account. Hosted deployments and local mode have **Mine** only. The Organization account is never a person in the ranking.

## Choosing a period

Choose **30 days**, **90 days** or **Year**. Drag across the recorded-time waveform to select your own period. Every chart, total and ranking follows the selection immediately. The highlighted waveform shows your range; the rest of the year stays muted.

You can also focus the waveform and use the arrow keys to inspect it. Press Enter to set a selection start, move, then press Enter again to set its end. Shift and an arrow extend a selection. Escape ends keyboard selection without undoing the selected range. Focus a time chart and use the left and right arrows, Home or End to inspect its buckets. Hovering or focusing a model, person or heatmap cell shows its numbers. Each visualization has **Show as a table**.

Periods up to 62 days use daily buckets. Longer periods use seven-day buckets ending on the selected range's last day, with a shorter first bucket when needed. Days and heatmap hours use your account's time zone, then your browser's, the Organization's or UTC when no earlier choice is available. Storage measurements use UTC dates. Recorded time uses the recording's start; the recordings chart uses its import date. The recorded-time change compares an equally long previous period, including the previous 365 days for **Year**.

## What the figures mean

The charts show recordings and completed transcription and summary requests; received and summarized mail; new, done, dropped and open tasks; AI spend by processing step; disk space; models by cost or job count; the people ranking; recording start times; Almanac growth and corrected mishearings; and time from a recording's end to its first summary.

The people ranking can be sorted by **Recorded time**, **Mail**, **Tasks resolved** or **Spend**. Tasks resolved are credited to the member who marked them done. Spend is attributed to the request's actor, using the scope's payer rule. Names come from colleagues' account display names; a missing or email-shaped name appears as **Member**. **Mine** has no ranking.

Almanac totals count surviving people, things, terms and aliases; merged-away records are excluded. Sharing promotes or merges knowledge rather than adding a second copy. **Companies and projects** includes other non-term thing types too. The latency chart uses median and 90th percentile across the recordings in each bucket, not an average of daily percentiles. A bucket with no summaries has no value.

## Estimates and limits

- **Disk history is measured from the date shown above the chart**, with solid lines. The first successful housekeeping tick of each UTC day writes one snapshot per existing account. Later ticks keep that day's measurements; accounts created afterward get their first snapshot the next day. Audio counts downloaded, retained files; mail counts retained raw messages including their attachments. **Organization** uses the shared bytes measured that day, and **Everyone** excludes the Organization account's duplicate storage. Missing days carry the last measurement forward. Earlier history uses dashed estimates reconstructed from surviving metadata and deletion or retention dates. Sidecars, waveforms and exports are excluded. Snapshots are derived data and are not included in portable backups.
- Task resolutions use the status-transition log, including the acting member. Reopening preserves earlier resolutions. Dropped counts require a previously accepted task; dismissed proposals do not count. Tasks predating the log fall back to their latest status and change date, so their earlier changes remain unknown. Open tasks follow recorded transitions, with an estimated starting state for legacy tasks. Task archives include optional transition history; older archives still restore.
- AI spend uses the cost stored when each request was made, from provider-reported cost, the provider card's price or a published rate. Later price changes do not reprice past requests. Correction requests are included in **Learning**. Keyterm prompting and any priced add-on stay in **Transcription**. Embeddings and unknown operation types appear as **Other**. Unpriced jobs count toward model usage but are excluded from spend. The cost per recorded hour includes only audio processing; mail and costs that cannot be tied to a recording are left out. Claude Code and Codex costs estimate equivalent API usage, not subscription charges.
- Saved browser transcriptions have a zero-cost usage event. Embedding batches and failed provider attempts are recorded too. **Models** counts successful and failed attempts; its tooltips and tables show failed counts. Failed attempts contribute to spend only when their cost can be determined. The unpriced-request notice counts successful requests without a known price. Activity charts count only successful transcription and summary calls on retained items.
- Embedding search queries are recorded only when a matching provider card has a positive input price or the provider reports a positive cost. Browser failures before saving, user-cancelled attempts and requests refused before a provider call have no usage event. Work that was never recorded is not reconstructed, so usage totals can be incomplete.
- Reruns and retries count as separate requests. Summary passes, their merge and any repair calls each record usage, so one saved summary can count as several completed requests. Task detection is included in summary requests.
- Deleting a recording or mail keeps its usage in **AI spend** and **Models**; only its activity counts disappear. Deleting the owning or paying account removes its usage events. Deleting only the acting member clears the actor attribution instead.
- Except for measured storage and AI usage, scope follows currently retained and currently shared items. AI usage follows its payer even after an item is deleted or unshared. Deleting a task cascades its transition history. These statistics are not a permanent audit of ownership, sharing or erased content.

Next: [Exports, backups and retention](exports-backups-retention.md)
