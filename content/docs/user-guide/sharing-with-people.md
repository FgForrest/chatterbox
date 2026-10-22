---
title: Sharing with people
description: Invite a colleague to read a private recording or email without publishing it to the Organization.
---

On a self-hosted instance showing the Organization, you can share a private recording or email with individual colleagues. This is unavailable on hosted instances and installations without the Organization scope. The organization account cannot receive invitations.

## Invite a colleague

Open your item and choose **Share**, or **Share…** from its row menu. Search by name or email and choose **Add**. The dialog lists each recipient as **Waiting for acceptance**, **Accepted**, **Declined** or **Removed**. Everyone must accept their invitation. Waiting invitations do not expire.

You can cancel a waiting invitation, remove an accepted receiver, or invite again after a decline or removal. The plum **Shared with N people** marker opens this list. Sharing keeps the item private to you and its accepted receivers; curators and other Organization members gain no access.

The link button explains who can open a private link before copying it. A waiting recipient must first accept. If you later share the item into the Organization, person shares and recipients' filing stay in place. Open the recipient count or **Manage sharing** to review existing shares, including declined and removed invitations.

## Accept and file

New invitations appear in a corner notice and under **Invitations** at the top of the folder tree. Email is sent only if you enabled email notifications in Settings. Before acceptance, the invitation shows the title and owner, without access to its content.

Choose **Accept and file…**, then pick or create one of your private folders. Accepted items appear there and in **Recent**, marked **Shared by** the owner. The folder chip changes your filing only; it does not change the owner's folders or processing profile. The owner's folder names remain hidden.

You can read the item, play audio and download audio, transcripts and summaries. The owner's confirmed speaker names appear as text without Almanac links. Renaming, erasing, processing, speaker changes, Learn and further sharing remain the owner's actions. An assigned task whose person's primary email matches your login email appears in **Tasks → Mine** and can be closed or reopened. Other tasks are read-only.

Choose **Remove and end sharing** from the row menu to give up access. Removing the item keeps the owner's original. The owner may invite you again.

## AI clients and backups

Your [MCP tools](../self-hosting/mcp) can read accepted items with the same content permissions, and close or reopen your assigned tasks. Person sharing publishes no Almanac knowledge and never feeds your Learn runs.

Received items stay out of your backups and folder exports. The owner's archive includes `sharing/people.json`, containing their direct share list without your filing. Share metadata can be restored after importing the owner's content by posting that list and the old-to-new item ID map to `/api/shares/restore`. Existing target accounts are matched by email; active shares become pending invitations. The result reports missing receivers, missing items, inactive entries and existing shares skipped. A general archive importer is not available yet.

Folder sharing follows in a later update.
