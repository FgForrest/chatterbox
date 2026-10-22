---
title: The Almanac
description: The people and things Chatterbox knows, their nicknames and facts.
---

The Almanac is what Chatterbox knows about the people and things your recordings talk about: who someone is, what they work on, what a project is called and what it is often misheard as. Transcription, Learn, summaries and tasks all use it.

It has **People**, **Things**, **Vocabulary** and **Review** tabs. Organization curators also see **Care**.

## People

![People](images/almanac-people.png)

Everyone you have named as a speaker is here, with how many recordings they are heard in. **Add person** adds someone before they speak. People marked **Organization** come from recordings shared with the Organization (see [The Organization](organization.md)).

Click a person to open their page:

![A person](images/almanac-person.png)

- **Also known as**: nicknames and other spellings. Search finds a person by any of them, and Learn recognizes them in transcripts.
- **Notes**: anything you want to remember. On Organization people, your notes are your own.
- **What is known**: facts such as *works for Bluefin Logistics* or *has the role Operations director*. **Add a fact** picks a relation and the other side from the Almanac, or takes plain text. Chatterbox refuses facts about health, family, personality, performance or demographics.
- **Recordings**: where this person speaks.
- **This is me** tells Chatterbox which person is you. Learn then knows who made the recording, and your tasks show under **Mine**.
- **Rename**, **Merge into…** (when two entries are the same person) and **Erase**.

## Things

![Things](images/almanac-things.png)

Things are organizations, teams, projects, products, terms, locations and documents. Search them, filter by type, or click **Add thing**.

![A thing](images/almanac-thing.png)

A thing's page has the same parts as a person's: nicknames, a description, facts and recordings, with **Edit**, **Change type**, **Merge into…** and **Erase**.

### Importing a list

**Import a list** on the Things tab adds many names at once. Write one line per type, the type, a colon, and the names separated by commas, with nicknames in parentheses:

```
project: Harbor phase 2
product: Pathfinder Lite (PF Lite)
location: Rotterdam depot, Antwerp depot
```

Click **Preview** to see what will be added before anything is saved:

![Previewing an import](images/almanac-import.png)

## Vocabulary

**Vocabulary** lists the kinds of things and relations you created yourself, beyond the built-in ones. Keep, rename, merge or delete them here. In the Organization, the organization account decides here on relations members suggested.

## Review

![What waits for review](images/almanac-review.png)

**Review** collects item reviews waiting for you: [Learn](learn.md) runs and proposed tasks from a recording or mail. The badge on **Almanac** counts these item reviews. Task changes routed to you because only you may apply them wait under **Tasks → Proposals for you**, with their own navigation badge. See [Routed proposals](summaries-and-tasks.md#routed-proposals).

## Care: possible duplicates

Organization curators use **Almanac → Care → Possible duplicates** to find the same person or thing recorded twice. The queue covers Organization records only. Each pair shows a high, medium or low match and the reasons: similar names, nicknames, Czech surname forms, heard-as forms or legal company suffixes. Contrary evidence appears in amber, such as two confirmed speakers in the same transcription or different email domains. Missing email is information, not a problem to fix.

**Merge…** opens both records side by side. The proposed survivor has a primary email, then more evidence. You can change it, choose the name, and choose which value stays for each conflicting single-valued fact. Both records' emails, nicknames, heard-as forms and facts are kept; the other name becomes a nickname. Replaced fact values retain their evidence in history. Speakers, tasks and links move to the survivor; the other record redirects to it. For things with different types, the survivor's type stays; facts that would not fit that type must be corrected first.

**Not the same** remembers the ordered pair for the Organization, including when another curator opens the queue. **Later** only hides it for this browser tab's session. The merge picker on a person's or thing's page also puts likely matches first.

Scans check the newest 2,000 live records per kind and their closest matches. Duplicates involving an older record outside this cap are not suggested, even when the other record is new. Reviewing or dismissing pairs does not move the scan past this cap. A notice identifies a limited scan. Shared items and open tasks are shown in the comparison; colleagues' private items remain private.

## Folder knowledge

Open a folder on the dashboard and choose **Knowledge** beside its name. Everyone who can see the folder can read this view. It covers items in that folder and all its subfolders, without counting parent folders. People come from confirmed speakers, corrections and fact evidence; things from corrections and evidence. Corrections show heard-as forms used in those items and their use counts. Facts show supported evidence with the item and date, including mail.

**What the models receive** reuses the processing pipeline:

- **Transcription:** at most 500 names, aliases and terms. The recorder comes first, then folder usage, owner usage, mishearings and name order. The preview explains the ranking, shows the top terms, the number omitted, the 500-term cut line and a few terms below it. Folders change order, never which Almanac records are eligible.
- **Transcript correction:** at most 500 records, with names, aliases and mishearings, without facts. Records already mentioned by the transcript come first, then folder usage. The preview shows the record count and the exact `ALMANAC (JSON)` representation of the first five records.
- **Learn:** looks knowledge up itself, up to 10 results per lookup; folder usage breaks ties.
- **Summary:** receives the corrected transcript without Almanac context. Speaker names are filled in afterwards.
- **MCP:** reads its authorized Organization and private Almanac without a folder filter.

The preview assumes a new item owned by the viewer, filed only in this folder, with no transcript mentions. It uses the transcription language from the folder’s default audio profile, including an inherited profile. When the profile auto-detects the language, mishearings from all languages are included. Another owner, language, existing transcript or additional placements can change the order. Root folders are excluded as ranking context: an item filed directly there gets no context from that root; descendant folders can still contribute usage. The knowledge tabs still count the whole root tree.

Next: [Learn](learn.md)
