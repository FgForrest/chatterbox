---
title: Getting started
description: Signing in, the first-run wizard, and finding your way around.
---

## Signing in

Open your Riffado address in a browser and sign in with your email and password. On a new self-hosted instance, the first account you register becomes the administrator.

If your organization uses single sign-on, the sign-in page shows one button instead, such as **Sign in with Keycloak**. Your account is created the first time you sign in. Registration may be closed on your instance; in that case ask your administrator for access.

## The first-run wizard

The first time you open Riffado, a short wizard helps you set up the essentials. You can skip any step and come back to it later in Settings.

| Step | What it does |
| --- | --- |
| ![Welcome](images/onboarding-welcome.png) | **Welcome.** What Riffado does: sync recordings, transcribe them, and summarize them with AI. |
| ![Connect Plaud](images/onboarding-plaud.png) | **Connect your recorder account.** Sign in with the Riffado Connector browser extension, with an email code, or by pasting a token. Riffado then fetches your recordings on a schedule. |
| ![AI provider](images/onboarding-ai-provider.png) | **Set up an AI provider.** Opens Settings, where you add the service that transcribes and summarizes. See [AI providers](settings.md#ai-providers). |
| ![Done](images/onboarding-done.png) | **You're all set.** Click **Get Started**. |

To see the wizard again, open **Settings → Export/Backup** and click **Re-run Onboarding**.

## Finding your way around

![The Recordings screen](images/dashboard.png)

The bar at the top has three sections:

- **Recordings**: your library. The list on the left, the selected recording on the right.
- **Almanac**: the people and things Riffado knows about. A badge counts reviews waiting for you. See [The Almanac](almanac.md).
- **Tasks**: the action items found in your recordings. A badge counts new tasks assigned to you. See [Summaries and tasks](summaries-and-tasks.md#the-tasks-page).

On the right of the bar:

- **Search** (or `Ctrl`/`⌘` + `K`) opens the command palette.
- **Sync device** fetches new recordings from your recorder's cloud now, instead of waiting for the next automatic sync.
- **Upload** adds an audio or video file from your computer.
- The round button with your initial opens the account menu: **Settings**, **Keyboard shortcuts**, the light/dark theme, and **Log out**.

## Getting help

Click **Help** in the top bar, or press `h`, to open this guide beside your work at the chapter about the screen you are on. On a recording it opens [Transcripts](transcripts.md), on the Tasks page [The Tasks page](summaries-and-tasks.md#the-tasks-page), in Settings the section you have open.

![The help drawer beside a recording](images/help-drawer.png)

- **Chapter** at the top of the drawer switches to another chapter.
- **Open full guide** opens the same page in a new tab, with the guide's navigation and search.
- The small **?** next to a feature, such as the Transcription and Summary cards, the Learn review and folder export settings, opens the drawer right at that feature.

The whole guide is also at `/docs` on your Riffado address, under **User guide**.

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

Riffado speaks English and Czech. It follows your browser's language until you choose one in **Settings → Display → Language**. Emails Riffado sends you follow the same choice.

Next: [Recordings](recordings.md)
