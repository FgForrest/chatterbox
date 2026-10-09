---
title: Settings
description: AI providers and prices, transcription, topics, Learn, summaries and display.
---

Open Settings from the account menu (the round button with your initial), or press `,`. The sections are grouped on the left.

**Help** at the top of Settings opens this guide at the section you have open.

![Help for the Summaries section](images/help-drawer-settings.png)

## AI providers

![AI providers](images/settings-providers.png)

**Settings → Providers** lists the services that do the AI work. Click **Add Provider**, choose the service, paste its API key, and pick a model. Riffado comes with presets for OpenAI, Groq, Together AI, OpenRouter, Google Gemini, ElevenLabs, Speechmatics, LM Studio and Ollama, and **Custom** takes any service with an OpenAI-compatible address. Keys are stored encrypted and never shown again.

Each provider shows its model, its price, and which jobs use it: **Transcription**, **Summaries**, **Learn** or **Topics**. You choose those jobs in the sections below, each of which lists only the providers able to do that job.

![Editing a provider](images/settings-provider-edit.png)

- **Price.** Riffado knows the published prices of common models. For any other model, or if you pay a different price, enter it here: dollars per million input and output tokens, or per audio hour. The [AI spend](recordings.md#what-the-ai-cost) of new requests uses it; costs already recorded keep their price.
- **Duplicate** (the copy icon) makes a second provider from the same key, for example a stronger model for Learn. The key is reused without being shown.
- **Claude Code** and **Codex** run on a Claude or ChatGPT subscription instead of an API key, through a bridge your administrator sets up. See [For administrators](administrators.md#claude-code-and-codex-subscriptions).

Some providers only transcribe (ElevenLabs, Speechmatics). Summaries then need a second provider.

## Transcription

![Transcription settings](images/settings-transcription.png)

- **Transcription provider**: who transcribes. See [Which provider to choose](transcripts.md#which-provider-to-choose).
- **Auto-transcribe new recordings**: transcribe every new recording as it arrives.
- **Import Plaud transcripts and summaries**: use the transcript your recorder's service already made, instead of, or as well as, your own provider's.
- **Default transcription language** and **Transcription quality**.
- **Auto-generate titles**, with **Title templates** you can edit like summary templates.

## Topics

![Topics settings](images/settings-topics.png)

**Auto-detect topics** detects topics for every new transcript. **Topics provider** defaults to the summaries provider. **Topic templates** holds the instruction used.

## Learning

![Learning settings](images/settings-learning.png)

Shown where [Learn](learn.md) is available.

- **Learning provider**: defaults to the summaries provider. A stronger model pays off here.
- **Learn automatically**: run Learn on every new transcript. The title, summary and topics wait for your review, 72 hours at most.
- **Correct the transcript after Learn**: after a review, Learn reads the whole transcript again and fixes misheard words.

## Summary

![Summary settings](images/settings-summary.png)

- **Summary provider** and **AI output language**. **Auto (match transcript)** writes in the recording's language.
- **Auto-generate summary after transcription**.
- **Summary templates**: the built-in templates and your own. Edit any of them; the **⋯** menu makes one the **Default** or the one used for automatic summaries. **New template** writes your own; put `{transcription}` where the transcript goes. A built-in template you have not edited keeps improving with new versions of Riffado; **Add built-in templates back** restores ones you deleted.

![Multi-pass summarization](images/settings-multi-pass.png)

- **Multi-pass summarization** runs each summary 2 to 5 times and merges the results (see [Multi-pass summaries](summaries-and-tasks.md#multi-pass-summaries)). **Also use for auto-summary** is a separate switch, because automatic summaries can be many. **Change merge prompt** edits how the passes are merged, starting from the built-in text.

## Display

![Display settings](images/settings-display.png)

**Language** (English or Čeština), how dates are shown, the order of the recording list, how many recordings a page shows, and the theme.

## The other sections

- **Plaud Account**: connect, reconnect or disconnect your recorder account.
- **Sync**: automatic sync and how often it runs.
- **Playback**: default speed and volume, playing the next recording automatically, waveform or progress bar.
- **Notifications**: browser, email and Bark notifications for new recordings.
- **Storage**: space used, and [Auto-delete old data](exports-backups-retention.md#deleting-old-data-automatically).
- **Export/Backup**: [exports and backups](exports-backups-retention.md#backups).
- **API Keys** and **Webhooks**: connect Riffado to other tools.
- **Google Account**: connect the Google account used for [Google Drive exports](exports-backups-retention.md#to-google-drive).

Next: [Riffado in Claude](claude.md)
