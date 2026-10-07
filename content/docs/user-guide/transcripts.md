---
title: Transcripts
description: Speakers, topics, playing a sentence, corrected words, copying and downloading.
---

## Getting a transcript

A recording without a transcript offers two buttons:

- **Transcribe** sends the audio to your transcription provider (Settings → Transcription → **Transcription provider**).
- **Transcribe in browser** runs Whisper inside your browser. It is free and nothing leaves your computer, but it is slower.

**Re-transcribe** on a recording that has a transcript runs it again with your current provider. Speaker names you gave are carried over to the new transcript as suggestions, to confirm with one click.

With **Auto-transcribe new recordings** on (Settings → Transcription), every new recording is transcribed as it arrives.

### Which provider to choose

Any service that speaks the OpenAI API works, and three more are built in. What you choose decides what you get:

| Provider | Speakers told apart | Timings | Notes |
| --- | --- | --- | --- |
| ElevenLabs Scribe (**speaker labels**) | Yes | Yes | Hears the names in your Almanac. |
| Speechmatics (**speaker labels**) | Yes | Yes | Hears the names in your Almanac. `melia-1` handles several languages in one recording. |
| OpenAI `gpt-4o-transcribe-diarize` | Yes | Yes | |
| OpenAI `whisper-1`, Groq, local Whisper | No | Yes | Long talks are split into paragraphs. |
| OpenAI `gpt-4o-transcribe`, Google Gemini | Depends | No | |

**Timings matter.** Topics, Learn, playing a sentence and following along all need to know when each line was said. A transcript without timings is shown as plain text.

**Names from the Almanac.** ElevenLabs Scribe v2 and Speechmatics are sent up to 500 names from your [Almanac](almanac.md) with each recording: your own first, then people and things mentioned recently. They spell those names right much more often. The names are sent for every recording, including people who are not in it.

**Recorder transcripts.** If your recorder's service made its own transcript and summary, Riffado can import them (Settings → Transcription → **Import Plaud transcripts and summaries**). A recording with both shows a switch between **Plaud** and **Custom**.

## Reading a transcript

![A transcript with speakers, topics and Learn's proposals](images/transcript-speakers.png)

A transcript with speakers reads as a conversation, one coloured block per turn, with the speaker's name and the time it started. **Collapse transcript** folds it away. The footer shows which provider and model made it, its language and its length.

### Naming speakers

The chips above the transcript are the speakers.

- Click a chip such as **Speaker 2** and choose who it is from your [Almanac](almanac.md), create a new person, or mark the speaker **Unknown**.
- A dashed chip ending in **?**, such as **Priya Raman?**, is a suggestion. Click **✓** to confirm it or **×** to reject it; a rejected name is never suggested for that speaker again. **▷** plays the moment the suggestion is based on.
- **Speaker guesses** above the transcript are Learn's suggestions. See [Learn](learn.md).
- Right-click a chip to hear that speaker's next turn.

Names you give appear everywhere the transcript does: in the summary, in exports, in copied Markdown and in the API.

### Topics

![The topics menu](images/topics-menu.png)

**Topics** splits a long transcript into chapters with titles. Click **Detect topics** to make them, then pick one from the **Topics** menu to jump there: the transcript scrolls to the heading and the player moves to its start. Turn on **Auto-detect topics** in Settings → Topics to detect them for every new transcript.

### Long talks

![A lecture read in paragraphs](images/transcript-lecture.png)

A lecture or a long monologue is split into paragraphs of about half a minute, at the end of a sentence, and wherever a new topic starts. Each paragraph shows when it begins.

## Playing from the transcript

![A sentence playing, highlighted](images/sentence-playback.png)

- **Click a sentence** to play the recording from it. Click again to pause.
- **Click a timestamp** to move the player there without playing.
- **While it plays,** the sentence being spoken is highlighted and the transcript scrolls along. If you scroll the transcript yourself, playback moves to the sentence you are reading.

## Corrected words

When Learn has corrected a misheard name, the transcript reads corrected. Corrected words are underlined.

| Corrected | Original |
| --- | --- |
| ![Corrected transcript](images/transcript-corrected.png) | ![Original transcript](images/transcript-original.png) |

- **Show original** shows what the provider heard; **Show edited** goes back.
- Click a corrected word to undo that one correction.
- Summaries, topics, search, exports and the API all use the corrected text.

See [Learn](learn.md) for where corrections come from.

## Copying and downloading

The two icons at the top right of the transcript copy it to the clipboard or download it as a Markdown file, with speaker names and corrections applied. The summary has the same two icons.

Next: [Summaries and tasks](summaries-and-tasks.md)
