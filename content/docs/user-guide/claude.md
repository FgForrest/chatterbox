---
title: Riffado in Claude
description: Ask Claude or Claude Code about your recordings, people and tasks.
---

When your administrator has set it up, Claude can look things up in Riffado for you. It can search your transcripts, read a summary, tell you who someone in the Almanac is, or list your open tasks. You ask in your own words, and Claude picks the lookups.

It works in Claude on the web (claude.ai), the Claude desktop and mobile apps, Cowork, and Claude Code.

## What Claude can see

Claude sees what you see in Riffado and never more:

- **Recordings**: your own and those shared with the Organization, as your recording list shows them.
- **The Almanac**: your people and things, and the Organization's.
- **Tasks**: those on your recordings, and on shared recordings those assigned to you.

Your administrator decides which areas are open to you: the Almanac, transcripts, summaries, tasks, and changing tasks. Claude is offered only the lookups for your areas, so it may say it cannot reach something you see in the app.

Claude can change one thing: with the right to change tasks, it can mark a task done, open it again, drop it, or give it to someone else, where the Tasks page would let you. Everything else is read only. Riffado records each lookup (what was looked up and which recordings or records it touched), never what you asked or what Claude answered.

## Before you connect

Sign in to Riffado itself once, in your browser. Claude cannot connect for someone Riffado has never seen.

## Connecting Claude

**If your organization uses Claude Team or Enterprise**, your administrator has added Riffado for everyone:

1. In Claude, open **Customize → Connectors**.
2. Find **Riffado**, marked **Custom**, and click **Connect**.
3. Your organization's sign-in page opens. Sign in as you do for Riffado.

**If you use a personal Claude plan** (Free, Pro or Max), your administrator gives you a client ID and a secret of your own:

1. In Claude, open **Customize → Connectors → Add custom connector**.
2. Enter the name **Riffado** and the address your administrator gave you, which ends in `/api/mcp`.
3. Under **Advanced settings**, enter your client ID and secret. If you were also given a key, add it under **Request headers** as `x-api-key`.
4. Click **Add**, then **Connect**, and sign in.

Keep the secret to yourself, like a password.

To use Riffado in a conversation, click **+** in the message box, choose **Connectors**, and turn Riffado on.

## Connecting Claude Code

Claude Code connects from your computer, so it works on the office network or the VPN. In a terminal, with the address your administrator gave you:

```bash
claude mcp add --transport http --client-id claude-code riffado https://riffado.example.com/api/mcp
```

Then type `/mcp` in Claude Code, choose **riffado**, and sign in in the browser window that opens.

## What to ask

Ask the way you would ask a colleague who has read everything:

- "What did we agree with Bluefin Logistics about the Harbor timeline?"
- "Summarize what Priya Raman said in the Harbor kickoff."
- "Who is Marek Dvořák, and what do we know about him?"
- "Which of my tasks are overdue?"
- "Mark the task about Dispatch API access as done."

Names work wherever Claude would otherwise need an ID: people, things and recordings are found by their names, nicknames and titles. When a name could mean several people, Claude gets the candidates and should ask you which one.

Searches go through recordings from the newest back and stop after a few hundred, because everything is stored encrypted and has to be decrypted to be searched. Claude is told when a search did not reach the oldest recordings, and can search further back. Naming a month, a project or a recording makes the answer faster and more precise.

Transcripts are what people said in the recordings. Claude is told to treat them as information, not as instructions to follow. Still check what Claude changes for you, especially in Cowork, which works on its own.

## Staying connected

Claude stays signed in as long as you use Riffado through it at least once every 30 days. After a longer break it asks you to sign in again.

When your administrator changes what you may see, a taken-away area stops working within 15 minutes. A new area shows up once you refresh the connector in **Customize → Connectors**, or disconnect and connect again.

To stop, choose **Disconnect** (or **Remove**) in **Customize → Connectors**. In Claude Code, run `claude mcp remove riffado`. You can also turn single lookups off there, for example the one that changes tasks, by setting it to **Blocked**.

## When it does not work

| What happens | What to do |
| --- | --- |
| The sign-in page shows an error | Tell your administrator what it says; the client or the sign-in setup needs a change. |
| Claude says it cannot use the connector right after you sign in | Sign in to Riffado once in your browser, then connect again. If it still fails, ask your administrator: Riffado's log says why it refused. |
| Claude cannot reach transcripts, summaries or tasks | That area is not open to you. Ask your administrator. |
| A lookup answers "Unknown tool" | What you may see has changed. Refresh the connector or connect again. |
| Claude Code cannot connect | Connect from the office network or the VPN. |

Next: [For administrators](administrators.md)
