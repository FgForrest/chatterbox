---
title: Processing and profiles
description: Filing new items, choosing a processing recipe, and reading the workflow.
---

New recordings and mail wait for you to file them before Chatterbox starts any paid AI step. This lets the folder choose the right processing recipe and prevents unwanted transcription or summaries.

## Categorize a new item

Open the item. Its first workflow step is an inline **Categorize recording** or **Categorize email** card. Under **Folder**, choose one folder, or choose **New folder…** to create a first-level folder under **Private** or **Organization**. Under **Profile**, choose **Organization default**, a specific Organization or personal profile, or **Nothing automatic**.

![Categorizing a recording and choosing its processing profile](images/categorize-card.png)

The card shows the profile's description and says what will run by itself, such as **After categorizing, these run by themselves: transcription, Learn, summary, title, and topics.** With **Nothing automatic**, it says **Nothing runs automatically. You start each step yourself.** Click **Categorize recording** or **Categorize email** to save. Audio also offers **Transcribe now** when you need the transcript before categorizing.

You can also drag an item onto a folder in the folder tree. Items addressed or uploaded directly to a folder skip this wait. This includes mail sent to a folder address and Meeting Recorder sessions or uploads created with a folder selected.

After categorizing, the row under the title shows the folder chips, **Add to folder**, any intended Organization folders, and the profile chip on the right. Open the profile chip to change the profile or choose **Nothing automatic**.

Choosing an Organization folder records an intended placement. The item remains private while it is processed. Chatterbox shares it automatically after the transcript, speaker, Learn, and task-review gates pass. With **Nothing automatic**, it waits instead: the intended folder in the folder row offers **Share now** and a cancel button.

<span id="profiles-are-processing-recipes" />

## Profiles are processing recipes

A processing profile is a recipe for one kind of item. Open **Settings → Profiles** to see and edit them. A new account without Organization access starts with two personal profiles: **Recordings** for audio and **Mail** for mail. A new Organization member follows the Organization defaults instead and starts without personal profiles. An upgraded account keeps its existing personal defaults and can have extra profiles copied from its earlier templates.

![The processing profiles list](images/profiles.png)

Each profile contains the steps that apply to that kind of item. Recording profiles can transcribe, Learn, generate a title, write a summary, find topics, and find tasks. Mail profiles start with Learn and the summary steps. Every paid step has its own **Run automatically** switch. A step that is off can still be run by hand.

A profile also holds the choices for that work: provider and model, transcription language, summary instructions, output language and output format, and multi-pass settings. **Auto (match content)** keeps the output in the item's language. Editing a profile creates a new revision; items already in progress keep the revision they started with.

![Editing the Recordings processing profile](images/profile-editor.png)

At the top of the list, choose separate defaults for recordings and mail. Each can follow the current Organization default, use a specific Organization profile, or use one of your profiles. You can create, duplicate, delete, archive, and restore personal profiles. Deleting an unused profile removes it permanently; if processing history or a queued run refers to it, Chatterbox removes it from the lists but keeps it under **Archived** so that work can finish and history remains intact. A manual summary can use any available profile for the same kind of item. Its profile picker starts with the item's profile, then your effective default, and remembers your last manual choice for that profile in this browser.

**Organization profiles** are shared recipes. Members can use them on private items and duplicate them into a personal profile. **Your default** marks the profile you currently use; **Organization default** marks the Organization's choice. When you follow the Organization default, both labels appear on that profile. Curators can create and edit the Organization versions.

If a specific Organization profile you selected is archived or you lose access to it, Chatterbox keeps your choice and marks it unavailable in Profiles, folder settings, and Categorize. New processing stops until you choose another default. Before archiving an Organization profile, the curator sees how many members selected it and the same warning.

<span id="folder-default-profiles" />

## Folder default profiles

Open a folder and choose **Processing**. Recordings and mail have separate defaults:

![Choosing a folder's default profiles](images/folder-default-profiles.png)

- **Inherit** uses the nearest ancestor with a choice. If none has one, Chatterbox uses your default profile for that item type.
- Choosing a profile assigns that recipe to items filed there.
- **Nothing automatic** assigns the normal default profile but leaves every automatic step off. You can still run steps by hand.

If you delete a personal profile selected as a folder default, that folder returns to **Inherit**.

When an item's folders suggest different defaults, the inline Categorize card asks you to choose the profile. Organization folders use Organization profiles.

<span id="the-workflow-indicator" />

## The workflow strip

The strip under an item's title shows every step in one row and what needs attention:

![The workflow strip on an item waiting for review](images/workflow-strip.png)

| Phase | What it does |
| --- | --- |
| **Record** or **Receive** | Shows that the recording or email arrived. |
| **Categorize** | Waits for folders and resolves the profile. |
| **Transcribe** | Produces the recording's transcript. Mail does not show this phase. |
| **Learn** | Finds names, corrections, and facts for review. |
| **Summarize** | Generates the title, summary, and topics selected by the profile. |
| **Task review** | Waits for proposed tasks and changes to be reviewed. |
| **Share** | Shares an intended Organization placement after its gates pass. |

Each step says **Done**, **Next**, **Review needed**, **Running**, **Queued**, **Waiting**, **Failed**, **Outdated**, **Manual**, or **Skipped**. **Manual** means the profile does not run that step automatically. **Outdated** means an input changed after the result was made. On a narrow screen the strip keeps one row of circles and names only the current step underneath.

One sentence below the steps begins **Your turn.**, **Working.**, **Queued.**, **Problem.**, or **Waiting for someone else.** It explains what happens next and shows the one action expected from you, such as **Review Learn**, **Review tasks**, or **Share now**.

Widgets appear in order as the workflow reaches them: transcription, the Learn review, the summary, and Task review. Finished widgets fold to one line while later work continues. When the workflow is done, the strip disappears and the item looks as it did before. A step you start yourself after that, such as **Learn**, **Re-summarize** (or **Summarize again** on mail), **Re-transcribe**, or **Detect topics**, shows its running state in place without opening a window. **Review**, **View results**, and the strip's review actions open a review window only when you ask for it.

For a **Nothing automatic** item, the workflow ends after **Categorize** and the strip disappears. The exception is an intended Organization placement, which keeps the strip visible until you use **Share now** or cancel it.

When a newer profile revision or changed input leaves automatic work to repeat, **Process again** starts the pending work. Old items that predate profiles show **Processed before profiles** instead of pretending they followed a recipe. They do not run again unless their content changes or you request it.

Next: [Recordings](recordings.md)
