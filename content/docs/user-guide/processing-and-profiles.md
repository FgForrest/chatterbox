---
title: Processing and profiles
description: Filing new items, choosing a processing recipe, and reading the workflow.
---

New recordings and mail wait for you to file them before Chatterbox starts any paid AI step. This lets the folder choose the right processing recipe and prevents unwanted transcription or summaries.

## File a new item

Open the item and click **File it** in its header. The filing panel shows your **Private** and **Organization** folder trees. Select one or more folders, or click **New folder** to create one without leaving the panel. Then choose the suggested profile, another profile, or **Nothing automatic** and click **File it**.

You can also drag an item onto a folder in the folder tree. Items addressed or uploaded directly to a folder skip this wait. This includes mail sent to a folder address and Meeting Recorder sessions or uploads created with a folder selected.

For a recording you need immediately, you can click **Transcribe** before filing. The rest of its automatic processing still waits for a folder and profile.

Choosing an Organization folder records an intended placement. The item remains private while it is processed. Chatterbox shares it automatically after the transcript, speaker, Learn, and task-review gates pass. The intended Organization folder appears in the header as **shares after review**.

<span id="profiles-are-processing-recipes" />

## Profiles are processing recipes

A processing profile is a recipe for one kind of item. Open **Settings → Profiles** to see and edit them. A new account starts with two profiles: **Recordings** for audio and **Mail** for mail. An upgraded account can have extra profiles copied from its earlier templates so its existing choices are preserved.

Each profile contains the steps that apply to that kind of item. Recording profiles can transcribe, Learn, generate a title, write a summary, find topics, and find tasks. Mail profiles start with Learn and the summary steps. Every paid step has its own **Run automatically** switch. A step that is off can still be run by hand.

A profile also holds the choices for that work: provider and model, transcription language, summary instructions, output language and output format, and multi-pass settings. **Auto (match content)** keeps the output in the item's language. Editing a profile creates a new revision; items already in progress keep the revision they started with.

You can create, duplicate, archive, restore, and set default profiles. A manual summary can use any available profile for the same kind of item. Its profile picker starts with the item's profile and remembers your last manual choice for that profile in this browser.

**Organization profiles** are shared recipes. Members can use and duplicate them into a personal profile. Curators can create and edit the Organization versions.

<span id="folder-default-profiles" />

## Folder default profiles

Open a folder's settings and choose **Default profiles**. Recordings and mail have separate defaults:

- **Inherit** uses the nearest ancestor with a choice. If none has one, Chatterbox uses your default profile for that item type.
- Choosing a profile assigns that recipe to items filed there.
- **Nothing automatic** assigns the normal default profile but leaves every automatic step off. You can still run steps by hand.

When an item is filed in folders whose defaults disagree, the filing panel asks you to choose the profile. Organization folders use Organization profiles.

<span id="the-workflow-indicator" />

## The workflow indicator

The indicator in an item's header shows where processing is and what needs attention:

| Phase | What it does |
| --- | --- |
| **Categorize** | Waits for folders and resolves the profile. |
| **Transcribe** | Produces the recording's transcript. Mail does not show this phase. |
| **Learn** | Finds names, corrections, and facts for review. |
| **Summary** | Generates the title, summary, and topics selected by the profile. |
| **Task review** | Waits for proposed tasks and changes to be reviewed. |
| **Share** | Shares an intended Organization placement after its gates pass. |

The state beside a phase says **Waiting**, **Running**, **Done**, **Skipped**, **By hand**, or **Outdated**. **By hand** means the profile does not run that step automatically. **Outdated** means an input changed after the result was made; use the action beside it to run that step again. A failed step says **Failed** and offers its available retry action.

When a newer profile revision or changed input leaves automatic work to repeat, **Process again** starts the pending work. Old items that predate profiles show **Processed before profiles** instead of pretending they followed a recipe. They do not run again unless their content changes or you request it.

Next: [Recordings](recordings.md)
