---
title: Summaries and tasks
description: Summaries, templates, multi-pass, and the tasks a summary finds.
---

## Summaries

Once a recording has a transcript, the **Summary** card below it can summarize it.

![A summary with tasks waiting for review](images/summary.png)

1. Pick a template in the drop-down next to the button. It starts on your default template.
2. Click **Summarize**, or **Re-summarize** to replace an existing summary.

While it runs, the card shows how long it has taken and, for a multi-pass summary, how far it is: `Summarizing — 1/3 passes`, then `Merging 3 passes…`. You can leave the page; the summary keeps going and is there when you come back.

Summaries are written in Markdown, so headings, lists and tables show as such. **Key Points** follow the text. The two icons copy the summary or download it as a Markdown file.

Summaries are written in the language of the recording unless you choose another in Settings → Summary → **AI output language**. To summarize every new transcript automatically, turn on **Auto-generate summary after transcription** there.

If you correct names in the transcript after the summary was written, the summary shows **May contain stale names or terms** with a **Regenerate** link.

### Templates

A template is the instruction the AI receives. Riffado comes with **General Summary**, **Meeting Notes**, **Key Points** and **Action Items**, and you can edit these or write your own in Settings → Summary. See [Summary settings](settings.md#summary).

### Multi-pass summaries

![A summary made with two of three passes](images/summary-multi-pass.png)

With **Multi-pass summarization** on (Settings → Summary), Riffado summarizes the transcript several times at once and merges the results, so a point only one pass noticed still makes it into the summary. It costs about as many times more as there are passes.

The footer of such a summary says **multi-pass · 3**. When a pass failed and the summary was made from fewer, the badge turns amber, for example **multi-pass · 2/3**; hover over it to see why.

## Tasks from a summary

A summary also looks for things someone agreed to do. Each one becomes a proposed task with who should do it, by when (worked out from the recording's date, so "by Friday" becomes a date), and the words it was heard in.

Click **Review tasks** on the summary to go through them:

![Reviewing proposed tasks](images/task-review.png)

- **Untick** what is not a task. Unticked proposals are not proposed again for this recording.
- **Correct** the text, the person or the due date. People who speak in the recording are offered first, then everyone in your Almanac. A name followed by **?**, such as **Marek?**, was matched on a first name only: check it.
- **Merge…** joins two proposals that are the same task. **Add task** adds one the summary missed.
- **Where it was said** plays the moment it was agreed.
- **Accept tasks** keeps the ticked ones. **Save and continue later** keeps your changes for now.

A summary can also notice that an earlier task was finished or moved, and propose **Mark done** or a new due date for it.

Accepted tasks are listed on the summary card. Tick one off when it is done, or use **Add task** to add one by hand.

## The Tasks page

**Tasks** in the top bar lists tasks from all your recordings.

![Tasks assigned to you](images/tasks-mine.png)

- **Mine**: tasks assigned to you. Riffado knows which person in the Almanac is you by your email address; open your own person in the Almanac and choose **This is me** if your tasks do not show here.
- **Tracked**: the other tasks from your recordings, assigned to someone else or to nobody yet.

![Tasks you track](images/tasks-tracked.png)

The filters show open, done or dropped tasks, tasks from one folder, and tasks that are overdue, due this week or have no date. Sort by newest or by due date. Each task offers **Done**, **Drop** (or **Restore**), and **Where it was said**, which opens the recording at that moment.

Next: [The Almanac](almanac.md)
