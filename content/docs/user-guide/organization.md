---
title: The Organization
description: Sharing items, profiles, providers, and task rights with your colleagues.
---

When your administrator has set it up, everyone on the instance shares an **Organization**: a folder tree next to your **Private** one, where recordings and mail can be shared with colleagues. Nothing is copied. A shared item stays owned by the person who brought it in; the Organization reads one shared view.

![The Organization folder tree and a shared recording](images/organization-folder.png)

## Sharing an item

Choose an Organization folder while filing the item. You can drag it onto the folder, or open it and click **File it** or **Change folders**.

![The filing panel with Organization folders](images/add-to-folder.png)

This first creates an intended Organization placement. The item remains private while its profile runs. Chatterbox shares it automatically when it is ready for others to read:

- it has a transcript when it is a recording,
- every speaker is named or marked unknown,
- no [Learn](learn.md) review is waiting,
- the [proposed tasks](summaries-and-tasks.md#tasks-across-items) are reviewed.

The header labels the intended folder **shares after review** and the workflow indicator shows which gate is waiting. A Learn review still blocks sharing after its three-day summary timeout.

Mail sent directly to an Organization folder address also starts as a private intended placement, runs the same gates, and shares automatically. See [Mail](mail.md).

## A shared item

![A recording a colleague shared](images/organization-recording.png)

Everyone can open and read a shared item, play or download shared audio, and file the item into other Organization folders. The header says who shared it, and recording speakers say **Managed by the Organization**.

While an item is shared, Organization curators change its title, transcript, speakers, summary, topics, and Learn review. This keeps one version everyone reads. The owner withdraws the item before changing that shared content privately.

Tasks are the exception. The home item's owner and curators can edit, drop, close, and merge a shared task. Its assignee can also close or reopen it. A task may collect mentions from several shared recordings and mail; see [Tasks across items](summaries-and-tasks.md#tasks-across-items).

People named in shared recordings become **Organization people**, visible in everyone's [Almanac](almanac.md). Curators look after them: they rename, merge, and erase them for everyone. You can still keep private notes on an Organization person and give them nicknames of your own.

## Taking an item back

Remove the item from its last Organization folder to withdraw it. Chatterbox asks you to confirm first and says what happens under the retention rules. The shared view then disappears for colleagues and the item is private again.

Withdrawing a task's home item moves the home to the newest remaining shared mention. If no shared mention remains, the task becomes private with the withdrawn item. Erasing a shared item, or any part of it, withdraws it first.

## Organization profiles

Organization profiles are shared processing recipes for Organization folders. Members can use them and duplicate one into a personal profile. Curators can create, edit, archive, restore, and choose default Organization profiles. See [Processing and profiles](processing-and-profiles.md#profiles-are-processing-recipes).

<span id="organization-providers" />

## Organization providers

**Settings → Providers → Organization providers** lists shared AI credentials that Organization profiles may use. Members see each provider, model, address, price, and disabled state as **Read-only**; API keys are never shown.

Only people with `access.manage` can add, edit, enable, disable, or delete an Organization provider. They also see **Usage per member**, including calls and estimated cost. Every management change is written to the administrator audit log.

Each member may make 60 calls per hour to each Organization provider by default. When the limit is reached, that member's next call is refused until the hourly window resets, without using another member's allowance. The administrator can change the limit for the instance.

## Curators and the organization account

With identity-provider authorization, people granted `org.curate` are curators and people granted `access.manage` manage access and Organization providers. On a local installation, the organization account holds those responsibilities. Curators can:

- edit shared recordings and mail,
- review shared Learn results and tasks,
- manage Organization profiles, people, things, and suggested relations,
- set up folder exports of Organization folders,
- back up the Organization, with each item's owner recorded.

Organization retention settings apply to shared items while they are shared.

Next: [Mail](mail.md)
