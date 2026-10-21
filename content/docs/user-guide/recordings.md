---
title: Recordings
description: The recording list, the player, uploads, folders, erasing, and what the AI cost.
---

## The recording list

The Chatter list on the left shows your newest recordings and mail first, grouped by day. Each row shows the title, its subfolder and who shared it when relevant, then a text preview with length and date.

![The recording list with the Needs review filter on](images/recording-list-needs-review.png)

- **Search** reads the fields selected under **Search in**: titles, transcripts and message text, or summaries. It reads corrected transcripts. Mail text excludes quoted earlier messages, signatures and disclaimers.
- The **All · Newest** menu chooses which channels to show and sorts the result by newest, oldest, name, duration or size. **Needs review** appears in this menu when Learn has proposals waiting. See [Learn](learn.md).
- Choose **Recent**, **Private**, **Organization**, or a folder to change the list’s location. See [Folders](#folders).
- The **⋯** menu on a row opens the item, adds it to a folder from Recent or a library root, moves it out of a custom folder, or downloads audio or the original message. Delete is available on your private view; deleting a shared item warns that colleagues lose access.

## Adding recordings

Recordings arrive in two ways:

- **From your recorder.** Chatterbox fetches new recordings from your recorder's cloud on a schedule, when you open the app, and when you click **Sync device**. Settings → Sync controls how often.
- **By upload.** Click **Upload** on Recordings, Tasks, Almanac, or Settings and pick an audio or a video file. You can choose a folder before the upload; that recording skips the categorization wait and uses the folder's default profile. Without a folder it opens at **Categorize**. The new recording is selected on the right with its workflow at the start. For a video, Chatterbox keeps only the sound: the file is uploaded, the audio is extracted in the background, and a message tells you when it is ready. One video is converted at a time.

An account with no items of its own starts at **Organization** when colleagues have shared items. The newest shared item opens in the detail, with sync and upload actions above the list. When both libraries are empty, use **New folder**, **Sync device**, or **Upload** to get started.

Recording a meeting held in the browser on Linux? Your administrator can give you **meetrec**, a small command-line recorder that captures both your microphone and the other participants into one file, ready to upload. See [For administrators](administrators.md#meeting-recorder-meetrec).

## The recording page

Click a recording to open it on the right.

![A recording](images/dashboard.png)

At the top:

- **The title.** Click the pencil next to it to rename the recording. The first completed summary can generate one automatic title. Later processing never replaces it. Click the refresh icon to regenerate the title whenever you want; it uses the summary when one exists, otherwise the transcript. A title you set yourself is never replaced automatically.
- **When, how long, how large.**
- **Estimated AI spend** (see below).
- The [workflow strip](processing-and-profiles.md#the-workflow-indicator). While work remains, it shows the current step, whose turn it is, and one expected action.
- The inline **Categorize recording** card before the first folder is chosen. After that, the folder row holds the folder chips, **Add to folder**, any intended Organization folders, and the profile chip on the right. Open the profile chip to change the profile.
- **Erase** on the right (see below).

![Changing the profile from the folder row](images/profile-chip-menu.png)

Below that are the player and the workflow widgets. The [transcript](transcripts.md), Learn review, [summary](summaries-and-tasks.md), and Task review appear in that order as the workflow reaches them. Finished widgets fold to one line while later work continues.

### The player

The player shows the recording as a waveform. Click anywhere on it to jump there. **1x** changes the speed, the speaker icon and slider set the volume, and the download icon saves the original audio file. If you prefer a plain progress bar, choose it in **Settings → Playback → Scrubber style**.

### What the AI cost

![Estimated AI spend, opened](images/ai-spend.png)

Click **Estimated AI spend** to see what each step cost on this recording: transcription, summary, topics, Learn and the title, and below that, which provider and model did the work. Prices come from each provider's published price list, or from the price you entered on the provider (see [AI providers](settings.md#ai-providers)). For Claude Code and Codex, which run on a subscription, the amount shows what the same work would cost through the API; it is not a charge. Requests made before cost tracking was added are not counted.

The amount counts everything spent on the recording, whoever paid. When one payer covered all of it, the panel says who, for example "Paid by the Organization."; when several did, each line names its payer. **≥ $0.45** means at least that much: some requests have no price, and the panel lists them. **unpriced** means none of the requests has a price. When no AI work was recorded for the item, nothing is shown.

### Erasing

![The Erase menu](images/erase-menu.png)

**Erase** removes parts of a recording and keeps the rest:

- **Erase local audio** removes Chatterbox's copy of the sound. The transcript and summary stay. While the original is still on your recorder's cloud, **Restore audio from Plaud** brings it back.
- **Erase transcripts** and **Erase summaries** remove just those.
- **Delete all local data** removes the recording from Chatterbox but leaves the original on your recorder's cloud.
- **Move Plaud original to Trash** moves the original to the Trash of your recorder's cloud.
- **Delete everywhere** does both. You confirm by typing the recording's title.

A recording shared with the Organization is taken out of the Organization first. See [The Organization](organization.md).

## Folders

From 1280 px wide, a folder rail sits beside the item list and detail. The panel-collapse icon beside **Find a folder** (**Hide folders**) switches to folder tiles above the list; **Show folders** brings the rail back. Below 1280 px the same locations use tiles and breadcrumbs. On a phone, opening an item shows its detail; the back button names the current location, such as **Recent**, **Private**, or the folder name, and returns to the same list and scroll position.

**Recent** shows your own items. The organization account sees Organization items here and has no Private root. Folder lists include descendants, with each subfolder named on its rows. Opening an item keeps the location; its link includes both folder and item.

From 1024 px, the rail and list scroll independently and load more items as you scroll. The location and list controls stay pinned; folder tiles scroll with the items. Smaller screens use the page scrollbar. Folder branches start collapsed below the first level, and the browser remembers expansion and rail visibility for your account. **Recently used** shows counts for up to five custom folders you opened or filed into. A long level shows eight active folders in the rail, six in the tile grid, in their normal order; **All N** reveals the rest. Folder search ignores accents and searches names and paths. **⌘K** finds folders too. Before typing, it shows only recently used folders; a search shows up to eight folder matches.

![Folders](images/folders.png)

- **Private** holds your own folders. Every recording is in Private, whatever else it is filed in.
- **Organization** holds the folders you share with colleagues. It appears only when your instance has an Organization. See [The Organization](organization.md).

For the first folder, use the inline **Categorize recording** card or drag the recording's row onto a folder. Once categorized, use **Add to folder** in the folder row to add another placement:

![The folder row with the Add to folder picker](images/add-to-folder.png)

The picker focuses its search field. Before typing, it shows recently used folders and indented Private and Organization hierarchies. Paths appear for recent folders and search results. Search ranks name matches before path matches. Already assigned folders are marked and cannot be selected again. Use arrows and Enter to choose, or Escape to close. If nothing matches, **Create folder “…”** lets you choose a parent; only curators can create directly under Organization.

A recording can sit in several folders at once. Click the **×** on a folder chip to take it out of that folder. An intended Organization folder also appears here; a **Nothing automatic** item offers **Share now** beside it until you share or cancel the placement.

To manage folders, use **⋯ → Folder settings** next to a folder. The panel contains **New subfolder**, **Rename**, **Move to…** and **Delete folder**. You can also drag folders to reorder or nest them. Deleting a folder never deletes the recordings in it.

Click a folder to show its items in the list. Use the current folder name in the breadcrumb or the **⋯** beside the list count to rename it, manage its mail addresses, change defaults, create a subfolder, move it, or delete it:

![A folder](images/folder-pane.png)

Folder settings shows **Name** as text; **Rename** opens an inline field. **Mail to folder** shows the address, a copy button and when mail last arrived, when mail is enabled. **Default processing profile** shows the current recording and mail profiles, including inherited settings; **Change** edits them. **Export** shows its targets or **Not configured**, with **Change** or **Configure** to manage exports to disk or Google Drive. See [Processing and profiles](processing-and-profiles.md#folder-default-profiles) and [Exports, backups and retention](exports-backups-retention.md#folder-exports).

Next: [Transcripts](transcripts.md)
