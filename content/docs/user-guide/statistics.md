---
title: Statistics
description: Recorded time, processing, costs and storage across your account and the team.
---

Open **Statistics** in the footer of any signed-in screen. The page starts with the last 90 days, using Organization when it is available and Mine otherwise.

## Whose data

- **Mine** includes your recordings, mail and tasks, your own Almanac entries, and AI requests paid by your account. Organization-paid processing of your private items appears in Organization's spend, not yours.
- **Organization** includes items currently shared in Organization folders, Organization-owned Almanac entries, and requests paid by the Organization. The people ranking measures members' contributions to the Organization. An item filed in several Organization folders is counted once.
- **Everyone** includes every account's items, including private items, as numbers only. The people ranking is visible to every signed-in member. This view never reveals item titles, mail headers, transcripts, summaries or task text.

Organization and Everyone exist only on a shared self-hosted instance. Organization also needs an Organization account. Hosted deployments and local mode have Mine only. The Organization account is never a person in the ranking.

## Choosing a period

Choose **30 days**, **90 days** or **Year**. Drag across the recorded-time waveform to select your own period. Every chart, total and ranking follows the selection immediately. The highlighted waveform shows your range; the rest of the year stays muted.

You can also focus the waveform and use the arrow keys to inspect it. Press Enter to set a selection start, move, then press Enter again to set its end. Shift and an arrow extend a selection. Escape cancels keyboard selection. Focus any chart and use the arrows, Home or End to inspect its buckets. Hovering or focusing a model, person or heatmap cell shows its numbers. Each visualization has **Show as a table**.

Periods up to 62 days use daily buckets. Longer periods use seven-day buckets ending on the selected range's last day, with a shorter first bucket when needed. Days and heatmap hours follow your browser's time zone. Storage measurements use UTC dates. Recorded time uses the recording's start; the recordings chart uses its import date. The change compares an equally long previous period, including the previous year for Year.

## What the figures mean

The charts show recordings and completed transcription and summary requests; received and summarized mail; new, done, dropped and open tasks; AI spend by processing step; disk space; models by cost or job count; the people ranking; recording start times; Almanac growth and corrected mishearings; and time from a recording's end to its first summary.

The people ranking can be sorted by recorded time, mail, tasks resolved or AI spend. Tasks resolved are credited to the member who marked them done. Spend is attributed to the request's actor, using the scope's payer rule. Names come from colleagues' account display names; a missing name appears as **Member**. Mine has no ranking.

Almanac totals count surviving people, things, terms and aliases; merged-away records are excluded. Sharing promotes or merges knowledge rather than adding a second copy. Companies and projects includes other non-term thing types too. The latency chart uses median and 90th percentile across the recordings in each bucket, not an average of daily percentiles. A bucket with no summaries has no value.

## Estimates and limits

- **Disk history is measured from the date shown above the chart**, with solid lines. The first housekeeping tick of each UTC day writes one snapshot per existing account. Later ticks keep that day's measurements; accounts created afterward get their first snapshot the next day. Audio counts downloaded, retained files; mail counts retained raw messages including their attachments. Organization uses the shared bytes measured that day, and Everyone excludes the Organization account's duplicate storage. Missing days carry the last measurement forward. Earlier history uses dashed estimates reconstructed from surviving metadata and deletion or retention dates. Sidecars, waveforms and exports are excluded. Snapshots are derived data and are not included in portable backups.
- Task resolutions use the status-transition log, including the acting member. Reopening preserves earlier resolutions. Dropped counts require a previously accepted task; dismissed proposals do not count. Tasks predating the log fall back to their latest status and change date, so their earlier changes remain unknown. Open tasks follow recorded transitions, with an estimated starting state for legacy tasks. Task archives include optional transition history; older archives still restore.
- AI spend uses stored provider prices. Correction requests are included in Learning. Unknown operation types appear as Other. Unpriced jobs count toward model usage but are excluded from spend. The cost per recorded hour excludes mail processing. Claude Code and Codex costs estimate equivalent API usage, not subscription charges.
- Browser transcription, embeddings, failed calls and work from before usage recording began have no usage event. Deleting an item permanently also deletes its usage events. Reruns are counted as separate requests; multi-pass processing can produce several requests for one summary.
- Except for measured storage, scope follows currently retained and currently shared items. Deleting a task cascades its transition history. These statistics are not a permanent audit of ownership, sharing or erased content.

Next: [Exports, backups and retention](exports-backups-retention.md)
