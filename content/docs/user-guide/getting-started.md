---
title: Getting started
description: Signing in, the first-run wizard, and finding your way around.
---

## Signing in

Open your Chatterbox address in a browser and sign in with your email and password. On a new self-hosted instance, the first account you register becomes the administrator.

If your organization uses single sign-on, the sign-in page shows one button instead, such as **Sign in with Keycloak**. Your account is created the first time you sign in. Registration may be closed on your instance; in that case ask your administrator for access.

## The first-run wizard

The first time you open Chatterbox, a short wizard helps you connect the services you use. Every integration is optional. Google, mail, and Claude appear only when enabled on your instance.

On a self-hosted instance with an Organization, shared recordings and services are already available. Connect only your personal sources. If the effective Organization providers cover transcription and summaries, the AI step is omitted and the final summary names those providers. A Claude Code or Codex Organization provider can supply summaries, but cannot transcribe recordings. When a role is missing, the wizard names it and opens Providers settings. Closing Settings or choosing **Return to setup** resumes the wizard at the same step and refreshes readiness.

The Organization account's **Re-run setup** shows only shared AI providers, defaults, and processing profiles. Members connect personal integrations from their own accounts.

| Step | What it does |
| --- | --- |
| ![Welcome](images/onboarding-welcome.png) | **Welcome.** What Chatterbox does: sync recordings, transcribe them, and summarize them with AI. |
| ![Connect Plaud](images/onboarding-plaud.png) | **Connect your recorder account.** Sign in with the connector browser extension, with an email code, or by pasting a token. Chatterbox then fetches your recordings on a schedule. On a self-hosted origin, add this site in the Plaud Connector's popup and reload the page. |
| ![AI provider](images/onboarding-ai-provider.png) | **Set up an AI provider.** Opens Settings, where you add the service that transcribes and summarizes. See [AI providers](settings.md#ai-providers). |
| Google Calendar and Meet (when configured) | **Connect Google Calendar and Meet.** Read-only access helps identify meetings and suggest speakers from invited guests and Meet attendees. |
| Meeting Recorder | **Set up Meeting Recorder.** Install the extension, open its toolbar icon and allow this site, click **Connect** here, then **Confirm** in the extension. Follow consent prompts and the detected state; the current extension may require another toolbar visit after consent. If warned, allow the microphone in the extension or your voice will not be recorded. Manual URL and key setup remains available. |
| Mail (when configured) | **Send mail to Chatterbox.** Your address needs no setup. Send or forward from your company address. Use a secret address in Settings → Mail for automatic forwarding from other senders. Folder addresses are generated per custom folder and changed in the folder header. Mail sent To or Cc an Organization folder waits for you to share it. The wizard shows paused or ineligible receiving states. |
| Claude (when configured) | **Connect Claude.** In Claude on claude.ai or desktop, open **Customize → Connectors**, find the company connector, click **Connect**, and sign in with your company account. Enable it in a conversation using **+ → Connectors**. Personal-plan and Claude Code instructions are under **Not in your list?**. **Already set up** records your acknowledgement, not a verified connection. See [Claude](claude.md). |
| ![Done](images/onboarding-done.png) | **You're all set.** Click **Get started**. |

To see the wizard again, open the user menu and choose **Re-run setup**. This does not reset your completed setup. The final summary checks existing connections even if you return from Google sign-in without revisiting their steps. **Next** continues; only **Skip** records a skipped step. Checking, failed checks, and reconnection requirements are shown separately.

## Finding your way around

![The Recordings screen](images/dashboard.png)

The bar at the top has three sections:

- **Recordings**: your library. The list and folder panel stay on the left, with the selected recording on the right. Before the first recording arrives, use **New folder** to organize the library, or sync or upload right away.
- **Almanac**: the people and things Chatterbox knows about. A badge counts reviews waiting for you. See [The Almanac](almanac.md).
- **Tasks**: action items followed across your recordings and mail. A badge counts new tasks and proposals for you. See [Summaries and tasks](summaries-and-tasks.md#the-tasks-page).

On the right of the bar:

- **Search** (or `Ctrl`/`⌘` + `K`) opens the command palette.
- **Sync device** fetches new recordings from your recorder's cloud now, instead of waiting for the next automatic sync.
- **Upload** adds an audio or video file from your computer. It remains available on Tasks, Almanac, and Settings too. After an upload, Recordings opens with the new item selected and its workflow at the start.
- The round button with your initial opens the account menu: **Settings**, **Keyboard shortcuts**, the light/dark theme, and **Log out**.

## Getting help

Click **Help** in the top bar, or press `h`, to open this guide beside your work at the chapter about the screen you are on. On a recording it opens [Transcripts](transcripts.md), on the Tasks page [The Tasks page](summaries-and-tasks.md#the-tasks-page), in Settings the section you have open.

![The help drawer beside a recording](images/help-drawer.png)

- **Chapter** at the top of the drawer switches to another chapter.
- **Open full guide** opens the same page in a new tab, with the guide's navigation and search.
- The small **?** next to a feature, such as the Transcription and Summary cards, the Learn review and folder export settings, opens the drawer right at that feature.

The whole guide is also at `/docs` on your Chatterbox address, under **User guide**.

![The user guide at /docs](images/docs-user-guide.png)

## The command palette

![The command palette](images/command-palette.png)

The palette searches titles and transcripts as you type. Press `Enter` to open a recording, or `⌘` + `Enter` to transcribe one that has no transcript yet. It also runs actions such as **Sync device**, **Upload** and **Open settings**.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `⌘`/`Ctrl` + `K` | Command palette |
| `?` | List of shortcuts |
| `h` | Open this guide at the current screen |
| `,` | Settings |
| `/` | Search the recording list |
| `j` / `k` | Next / previous recording |
| `Space` | Play or pause |
| `←` / `→` | Seek back / forward 5 seconds |
| `↑` / `↓` | Volume |

## Language

Chatterbox speaks English and Czech. It follows your browser's language until you choose one in **Settings → Display → Language**. Emails Chatterbox sends you follow the same choice.

Next: [Processing and profiles](processing-and-profiles.md)
