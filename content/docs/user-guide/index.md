---
title: User guide
description: Every screen of Chatterbox, one chapter at a time, with screenshots.
---

Chatterbox keeps your voice recordings, turns them into transcripts and summaries with the AI provider you choose, and remembers the people and things they talk about. This guide walks through everything you can do in the app, one screen at a time.

![The Recordings screen](images/dashboard.png)

Every screenshot shows the same invented team: **Alex Morgan**, a product lead at Northwind Studio, working with the client **Bluefin Logistics** on a project called **Harbor**. None of the people or companies are real.

## Chapters

1. [Getting started](getting-started.md): signing in, the first-run wizard, finding your way around.
2. [Processing and profiles](processing-and-profiles.md): filing new items, choosing a processing recipe, and reading the workflow.
3. [Recordings](recordings.md): the recording list, the player, uploads, folders, erasing, and what the AI cost.
4. [Transcripts](transcripts.md): speakers, topics, playing a sentence, corrected words, copying and downloading.
5. [Summaries and tasks](summaries-and-tasks.md): summaries, profiles, multi-pass, and tasks across recordings and mail.
6. [The Almanac](almanac.md): the people and things Chatterbox knows, their nicknames and facts.
7. [Learn](learn.md): let Chatterbox propose speaker names, corrections and facts, and review them.
8. [The Organization](organization.md): sharing recordings with your colleagues.
9. [Sharing with people](sharing-with-people.md): inviting individual colleagues to a private recording, email or folder.
10. [Mail](mail.md): sending mail into Chatterbox and filing it for processing.
11. [Exports, backups and retention](exports-backups-retention.md): folder exports to disk or Google Drive, backups, and deleting old data automatically.
12. [Settings](settings.md): profiles, AI providers and prices, language and other account defaults.
13. [Chatterbox in Claude](claude.md): asking Claude or Claude Code about your recordings, mail, people and tasks.
14. [For administrators](administrators.md): what to switch on for each feature on a self-hosted instance.

Recording meetings held in the browser has a guide of its own: [Meeting Recorder](../guides/meeting-recorder.mdx).

## Where a feature comes from

Some features depend on how your instance is set up. When a chapter describes one of these, it says so:

- **Learn** works on self-hosted instances with an AI provider that can write summaries.
- **The Organization** appears when the administrator has created the organization account. **Sharing with people** needs it too.
- **Mail** works when the administrator has set up inbound mail, which also needs single sign-on.
- **Calendar and Meet** speaker suggestions appear when the administrator has set up the Google integration.
- **Folder exports** to disk or Google Drive appear when the administrator has configured them.
- **Single sign-on** replaces the email and password form when the administrator has connected an identity provider.
- **Chatterbox in Claude** works when the administrator has turned on the MCP server and set up the Claude connector.

[For administrators](administrators.md) lists the switches.

## Updating the screenshots

The screenshots are made from demo data kept in this repository, so they can be retaken after the app changes. See `docs/user-guide/demo/README.md` in the repository.
