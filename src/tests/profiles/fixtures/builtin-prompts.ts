export const ORIGINAL_SUMMARY_PROMPTS = {
    general: `Summarize this audio transcription, then extract key points and action items if any exist.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A Markdown summary of the transcription",
  "keyPoints": ["key point 1", "key point 2"],
  "actionItems": ["action item 1", "action item 2"]
}

Match the summary to the recording. A short or single-topic recording wants one tight paragraph. A long one that moves through several distinct topics is far easier to read as a short opening paragraph followed by a "###" section per topic, so use that shape when the recording earns it.

If there are no key points or action items, return empty arrays.

Transcription:
{transcription}`,
    "meeting-notes": `Summarize this meeting recording. Include attendees mentioned, decisions made, and action items.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A Markdown summary of the meeting",
  "keyPoints": ["decision 1", "decision 2", "key discussion point"],
  "actionItems": ["action item with owner if mentioned", "follow-up task"]
}

Write the summary as "###" sections covering only what this meeting supports: who attended, why they met, what was discussed, and any open questions. Name each heading in the output language. Leave a section out entirely rather than writing "None" under it. List attendees as bullets once there are more than two, with their role or team when it was mentioned.

The decisions belong in keyPoints and the tasks in actionItems, so the summary covers who met, what it was about, and how the discussion went, not a second copy of those two lists.

If there are no key points or action items, return empty arrays.

Transcription:
{transcription}`,
    "key-points": `Extract the key points from this transcription. Focus on the most important information, facts, and insights.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A brief one-sentence overview of the transcription",
  "keyPoints": ["key point 1", "key point 2", "key point 3"],
  "actionItems": []
}

Transcription:
{transcription}`,
    "action-items": `Extract all action items, tasks, and follow-ups mentioned in this transcription. Include who is responsible if mentioned.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A brief overview of what was discussed",
  "keyPoints": [],
  "actionItems": ["action item 1 (owner if known)", "task 2", "follow-up 3"]
}

If there are no action items, return an empty array but still provide a summary.

Transcription:
{transcription}`,
} as const;

export const ORIGINAL_MAIL_SUMMARY_PROMPT = `Summarize this mail, then extract key points and action items if any exist.

Respond with a single JSON object and nothing else. Do not wrap it in code fences.
{
  "summary": "A Markdown summary of the mail",
  "keyPoints": ["key point 1", "key point 2"],
  "actionItems": ["action item 1", "action item 2"]
}

Say who writes to whom and what they ask for, offer, decide or report. Keep it to one tight paragraph unless the mail, with the messages it quotes, moves through several distinct topics; then use a short opening paragraph and a "###" section per topic.

If there are no key points or action items, return empty arrays.

Mail:
{transcription}`;

export const ORIGINAL_TITLE_PROMPTS = {
    default: `You are a title generator for audio recordings. Generate a concise, descriptive title based on the transcription provided.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the main topic, subject, or action discussed
5. Remove filler words, greetings, and conversational fluff
6. Be specific and descriptive, not generic
7. If the transcription is very short or unclear, create a meaningful title based on context
8. Do not include timestamps, dates, or metadata
9. Do not use phrases like "Recording about" or "Discussion of"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Team Meeting Q4 Planning"
- "Customer Interview Product Feedback"
- "Daily Standup Sprint Review"
- "Client Call Project Requirements"
- "Interview Technical Discussion"

Examples of bad titles:
- "Recording about team meeting" (too generic, includes "about")
- "Team Meeting: Q4 Planning" (contains colon)
- "A discussion with the team" (filler words)
- "2025-01-15 Meeting" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    meetings: `You are a title generator for business meeting recordings. Generate a concise, descriptive title that captures the meeting's purpose and key topic.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the meeting's main agenda item, decision, or outcome
5. Include meeting type if relevant (Standup, Review, Planning, Retrospective)
6. Remove filler words, greetings, and small talk
7. Be specific about the topic or project discussed
8. Do not include timestamps, dates, or participant names
9. Do not use phrases like "Meeting about" or "Discussion of"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Sprint Planning Q4 Roadmap"
- "Daily Standup Blockers Review"
- "Retrospective Team Velocity"
- "Client Kickoff Project Scope"
- "Design Review New Feature"

Examples of bad titles:
- "Meeting about sprint planning" (too generic)
- "Team Standup: Blockers" (contains colon)
- "A quick chat with the team" (filler words)
- "2025-01-15 Standup" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    lectures: `You are a title generator for lecture and educational recording transcriptions. Generate a concise, descriptive title that captures the main subject or topic covered.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the main subject, concept, or lesson topic
5. Include course or subject area if mentioned (e.g., "Calculus", "History", "Physics")
6. Remove filler words, introductions, and administrative announcements
7. Be specific about the topic or chapter covered
8. Do not include timestamps, dates, or lecture numbers
9. Do not use phrases like "Lecture on" or "Class about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Introduction to Machine Learning"
- "World War II Causes Analysis"
- "Calculus Derivatives Chain Rule"
- "Shakespeare Hamlet Act 1"
- "Biology Cell Structure Overview"

Examples of bad titles:
- "Lecture on machine learning" (too generic)
- "Class: World War II" (contains colon)
- "Today's lesson about calculus" (filler words)
- "Lecture 15 - Biology" (contains lecture number)

Transcription:
{transcription}

Generate the title now:`,
    "phone-calls": `You are a title generator for phone call and interview recordings. Generate a concise, descriptive title that captures the purpose and main topic of the conversation.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the call's purpose, topic discussed, or outcome
5. Include call type if relevant (Interview, Support, Sales, Follow-up)
6. Remove filler words, greetings, and pleasantries
7. Be specific about the subject or issue discussed
8. Do not include timestamps, dates, or participant names
9. Do not use phrases like "Call with" or "Phone call about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Customer Support Billing Issue"
- "Job Interview Technical Round"
- "Sales Call Product Demo"
- "Client Follow-up Project Status"
- "Interview Product Manager Role"

Examples of bad titles:
- "Phone call with customer" (too generic)
- "Interview: Technical Round" (contains colon)
- "A quick chat about billing" (filler words)
- "2025-01-15 Support Call" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    "audio-blog": `You are a title generator for casual audio blog and personal recording transcriptions. Generate a concise, engaging title that captures the main thought or topic.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the main idea, reflection, or topic shared
5. Capture the essence or mood if relevant
6. Remove filler words and verbal pauses
7. Be descriptive but conversational in tone
8. Do not include timestamps, dates, or "Day X" references
9. Do not use phrases like "Thoughts on" or "Talking about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Morning Reflection Productivity Tips"
- "Weekend Trip Planning Ideas"
- "Book Review Atomic Habits"
- "Personal Goals 2025 Update"
- "Cooking Experiment New Recipe"

Examples of bad titles:
- "Thoughts on productivity" (too generic)
- "Day 15: Morning Reflection" (contains colon and day number)
- "Just talking about my weekend" (filler words)
- "2025-01-15 Vlog" (contains date)

Transcription:
{transcription}

Generate the title now:`,
    "idea-stormer": `You are a title generator for brainstorming and idea generation recordings. Generate a concise, descriptive title that captures the main problem, challenge, or creative direction being explored.

RULES (MUST FOLLOW):
1. Maximum 60 characters (strict limit)
2. No quotes, colons, semicolons, or special punctuation marks
3. Use title case (capitalize important words)
4. Focus on the problem, challenge, or creative direction being brainstormed
5. Include the domain or area if relevant (Product, Marketing, Design, Feature)
6. Remove filler words, "um"s, and thinking out loud
7. Be specific about the topic or challenge being explored
8. Do not include timestamps, dates, or "Brainstorming" prefix
9. Do not use phrases like "Ideas for" or "Brainstorming about"
10. Return ONLY the title text, nothing else

Examples of good titles:
- "Product Feature User Onboarding"
- "Marketing Campaign Social Media"
- "Design System Color Palette"
- "App Redesign Navigation Flow"
- "Content Strategy Blog Topics"

Examples of bad titles:
- "Brainstorming product ideas" (too generic, includes prefix)
- "Ideas: User Onboarding" (contains colon)
- "Just thinking about features" (filler words)
- "2025-01-15 Brainstorm" (contains date)

Transcription:
{transcription}

Generate the title now:`,
} as const;

export const ORIGINAL_TOPIC_PROMPTS = {
    default: `Divide this conversation into its topics, as chapters of a recording someone will want to jump around in.

Guidelines:
- Start a new topic where the conversation clearly moves to a different subject, not at every change of speaker.
- Aim for a topic every few minutes; a short recording may have only two or three. Do not create a topic shorter than about a minute unless the subject really changes.
- The first topic starts where the conversation starts.
- Titles are short noun phrases of two to six words that name what is discussed, like chapter titles. No numbering, no speaker names unless they are the subject, no ending punctuation.

Transcript:
{transcription}`,
} as const;
