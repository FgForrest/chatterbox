/**
 * Demo data for the user guide's screenshots (`docs/user-guide`).
 *
 * Every person, organization, product and conversation here is invented.
 * `seed.ts` writes it into a throwaway database; `docs/user-guide/demo`
 * explains how to rebuild the stack and retake the screenshots.
 */

export type DemoUserKey = "alex" | "priya";

export interface DemoUser {
    key: DemoUserKey;
    name: string;
    email: string;
    password: string;
}

export const DEMO_USERS: readonly DemoUser[] = [
    {
        key: "alex",
        name: "Alex Morgan",
        email: "alex@example.com",
        password: "demo-password-123",
    },
    {
        key: "priya",
        name: "Priya Raman",
        email: "priya@example.com",
        password: "demo-password-123",
    },
];

export type DemoPersonKey =
    | "alex"
    | "priya"
    | "marek"
    | "lena"
    | "sam"
    | "jonas";

export interface DemoPerson {
    key: DemoPersonKey;
    name: string;
    email?: string;
    notes?: string;
    nicknames?: string[];
}

/** Alex's Almanac people. */
export const DEMO_PEOPLE: readonly DemoPerson[] = [
    {
        key: "alex",
        name: "Alex Morgan",
        email: "alex@example.com",
        notes: "Product lead at Northwind Studio.",
    },
    {
        key: "priya",
        name: "Priya Raman",
        email: "priya@example.com",
        notes: "Product designer. Runs the usability sessions.",
    },
    {
        key: "marek",
        name: "Marek Dvořák",
        notes: "Backend engineer on the Pathfinder team.",
        nicknames: ["Mark"],
    },
    {
        key: "lena",
        name: "Lena Fischer",
        notes: "Operations director at Bluefin Logistics. Main client contact for Harbor.",
    },
    {
        key: "sam",
        name: "Sam Okafor",
        notes: "Guest lecturer on field research methods.",
    },
    {
        key: "jonas",
        name: "Jonas Weber",
        notes: "Dispatcher at the Bluefin Rotterdam depot.",
    },
];

export type DemoThingKey =
    | "bluefin"
    | "harbor"
    | "pathfinder"
    | "platform"
    | "eta"
    | "northwind";

export interface DemoThing {
    key: DemoThingKey;
    typeKey: string;
    name: string;
    description?: string;
    nicknames?: string[];
}

export const DEMO_THINGS: readonly DemoThing[] = [
    {
        key: "northwind",
        typeKey: "organization",
        name: "Northwind Studio",
        description: "Our product studio.",
    },
    {
        key: "bluefin",
        typeKey: "organization",
        name: "Bluefin Logistics",
        description: "Freight and last-mile delivery client.",
        nicknames: ["Bluefin"],
    },
    {
        key: "harbor",
        typeKey: "project",
        name: "Harbor",
        description: "Customer portal redesign for Bluefin Logistics.",
    },
    {
        key: "pathfinder",
        typeKey: "product",
        name: "Pathfinder",
        description: "Route planning app for drivers.",
    },
    {
        key: "platform",
        typeKey: "team",
        name: "Platform team",
    },
    {
        key: "eta",
        typeKey: "term",
        name: "ETA board",
        description: "The live arrival board dispatchers watch.",
    },
];

export type DemoFactRef =
    | { person: DemoPersonKey }
    | { thing: DemoThingKey }
    | { literal: string };

export interface DemoFact {
    subject: DemoFactRef;
    relationKey: string;
    object: DemoFactRef;
}

export const DEMO_FACTS: readonly DemoFact[] = [
    {
        subject: { person: "lena" },
        relationKey: "works_for",
        object: { thing: "bluefin" },
    },
    {
        subject: { person: "alex" },
        relationKey: "leads",
        object: { thing: "harbor" },
    },
    {
        subject: { thing: "harbor" },
        relationKey: "project_for",
        object: { thing: "bluefin" },
    },
    {
        subject: { person: "priya" },
        relationKey: "works_on",
        object: { thing: "harbor" },
    },
    {
        subject: { person: "jonas" },
        relationKey: "works_for",
        object: { thing: "bluefin" },
    },
    {
        subject: { person: "lena" },
        relationKey: "has_role",
        object: { literal: "Operations director" },
    },
];

/** A folder path below a root, "Clients/Bluefin Logistics". */
export type DemoFolderPath = string;

export const DEMO_PRIVATE_FOLDERS: readonly DemoFolderPath[] = [
    "Clients",
    "Clients/Bluefin Logistics",
    "Research",
    "Internal",
    "Internal/Team syncs",
];

export const DEMO_ORG_FOLDERS: readonly DemoFolderPath[] = [
    "Clients",
    "Clients/Bluefin Logistics",
    "Usability studies",
];

export interface DemoProvider {
    key: "elevenlabs" | "speechmatics" | "claude" | "claudeLearn" | "openai";
    provider: string;
    baseUrl: string | null;
    model: string;
    transcription?: boolean;
    summaries?: boolean;
    learn?: boolean;
    inputUsdPerMillion?: number;
    outputUsdPerMillion?: number;
    audioUsdPerHour?: number;
}

/** Alex's AI providers. The keys are fake; nothing calls them. */
export const DEMO_PROVIDERS: readonly DemoProvider[] = [
    {
        key: "elevenlabs",
        provider: "ElevenLabs",
        baseUrl: null,
        model: "scribe_v2+diarize",
        transcription: true,
    },
    {
        key: "speechmatics",
        provider: "Speechmatics",
        baseUrl: "https://eu2.asr.api.speechmatics.com",
        model: "enhanced+diarize",
        audioUsdPerHour: 0.3,
    },
    {
        key: "claude",
        provider: "Claude Code",
        baseUrl: "http://agent-bridge:8787/v1",
        model: "claude-sonnet-5",
        summaries: true,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
    },
    {
        key: "claudeLearn",
        provider: "Claude Code",
        baseUrl: "http://agent-bridge:8787/v1",
        model: "claude-opus-5",
        learn: true,
        inputUsdPerMillion: 15,
        outputUsdPerMillion: 75,
    },
    {
        key: "openai",
        provider: "OpenAI",
        baseUrl: null,
        model: "gpt-4o-mini",
    },
];

export interface DemoCustomTemplate {
    id: string;
    name: string;
    prompt: string;
}

export const DEMO_SUMMARY_TEMPLATES: readonly DemoCustomTemplate[] = [
    {
        id: "client-meeting",
        name: "Client meeting notes",
        prompt: "Summarize this client meeting for the delivery team. Start with the decisions, then open questions, then risks the client raised. Name who owns each follow-up.\n\n{transcription}",
    },
];

export interface DemoTurn {
    /** A speaker label (`speaker_0`), or "" for a lecture paragraph. */
    speaker: string;
    text: string;
}

export type DemoSpeaker =
    | { person: DemoPersonKey; status: "confirmed" }
    | { person: DemoPersonKey; status: "suggested"; confidence: number }
    | { status: "unknown" }
    | { status: "open" };

export interface DemoTopic {
    title: string;
    /** Index of the turn the topic starts at. */
    atTurn: number;
}

export interface DemoTask {
    text: string;
    assignee?: DemoPersonKey;
    assigneeHint?: string;
    /** Days from today; negative is overdue. */
    dueInDays?: number;
    duePhrase?: string;
    status: "proposed" | "open" | "done" | "dropped";
    /** Turn the task was heard in; its quote is that turn's first words. */
    atTurn?: number;
    ticked?: boolean;
}

export interface DemoCorrection {
    heard: string;
    target: { thing: DemoThingKey } | { person: DemoPersonKey };
    replacement: string;
}

export type DemoLearnItem =
    | {
          kind: "speaker";
          label: string;
          person: DemoPersonKey;
          reason: string;
          atTurns: number[];
      }
    | {
          kind: "new_record";
          ref: string;
          recordKind: "person" | "entity";
          typeKey: string | null;
          name: string;
          reason: string;
          atTurns: number[];
          maybe?: DemoThingKey;
      }
    | ({ kind: "correction"; preTicked: boolean } & DemoCorrection)
    | {
          kind: "fact";
          subject: { person: DemoPersonKey } | { thing: DemoThingKey };
          relationKey: string;
          object:
              | { person: DemoPersonKey }
              | { thing: DemoThingKey }
              | { newRef: string };
          atTurn: number;
          preTicked: boolean;
      };

export interface DemoCost {
    operation:
        | "transcription"
        | "summary"
        | "topics"
        | "learn"
        | "title"
        | "correction";
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    audioSeconds?: number;
    costUsd: number;
}

export interface DemoRecording {
    key: string;
    owner: DemoUserKey;
    title: string;
    /** When it was recorded: days before the seed ran, at this hour. */
    daysAgo: number;
    hour: number;
    durationMinutes: number;
    /** `plaud`: synced from a recorder; `upload` and `video`: uploaded. */
    origin: "plaud" | "upload" | "video";
    transcript?: {
        provider: string;
        model: string;
        language: string;
        turns: DemoTurn[];
        speakers: Record<string, DemoSpeaker>;
        topics?: DemoTopic[];
        /** Accepted corrections from an earlier Learn review. */
        corrections?: DemoCorrection[];
    };
    summary?: {
        provider: string;
        model: string;
        markdown: string;
        keyPoints: string[];
        actionItems: string[];
        multiPass?: { rounds: number; used: number; merged: boolean };
    };
    tasks?: DemoTask[];
    /** A Learn run waiting for review. */
    learn?: DemoLearnItem[];
    privateFolders?: DemoFolderPath[];
    /** Filed into the Organization tree, which shares it. */
    orgFolders?: DemoFolderPath[];
    costs?: DemoCost[];
}

const KICKOFF: DemoTurn[] = [
    {
        speaker: "speaker_0",
        text: "Thanks for making the time, everyone. The goal today is simple: agree what Harbor has to do for the pilot in March, and what can wait. Lena, do you want to start with what your dispatchers are struggling with?",
    },
    {
        speaker: "speaker_1",
        text: "Sure. Right now our customers call the depot to ask where their shipment is. Every call takes a dispatcher away from the ETA board. On a bad day that is two hundred calls in Rotterdam alone.",
    },
    {
        speaker: "speaker_0",
        text: "So the first win is self-service tracking. A customer opens the portal, sees the shipment, sees a realistic arrival window, and does not need to call.",
    },
    {
        speaker: "speaker_1",
        text: "Exactly. And the arrival window has to be honest. If the portal says ten to twelve and the truck arrives at two, they will call anyway, and they will be angrier.",
    },
    {
        speaker: "speaker_2",
        text: "That is where Pathfinder helps. The route planner already recalculates every few minutes from the driver's position. We can expose the same estimate through an API instead of building a second one.",
    },
    {
        speaker: "speaker_1",
        text: "How fresh would that be? Our current board lags about fifteen minutes behind reality.",
    },
    {
        speaker: "speaker_2",
        text: "Under two minutes for trucks with the app running. For subcontractors without the app we only have the depot scans, so those stay coarse. I would show them differently in the portal.",
    },
    {
        speaker: "speaker_3",
        text: "From the design side I would make that difference visible but calm. A precise window for live trucks, and for the others a plain message: arriving today, we will update you when it leaves the depot.",
    },
    {
        speaker: "speaker_1",
        text: "I like that. Customers can live with less detail. What they cannot live with is detail that turns out to be wrong.",
    },
    {
        speaker: "speaker_0",
        text: "Let us talk about scope. I propose three things for the pilot: tracking with the arrival window, delivery notifications by email, and a simple way to change the delivery slot. Invoicing and returns wait for phase two.",
    },
    {
        speaker: "speaker_1",
        text: "Changing the slot is the one my team would love most. Half of the calls that are not about tracking are about rescheduling.",
    },
    {
        speaker: "speaker_2",
        text: "Rescheduling touches the dispatch system, so it is the riskiest part. I need read and write access to your dispatch API in a test environment before I can estimate it.",
    },
    {
        speaker: "speaker_1",
        text: "I can get you that. Our IT team needs a written request, but it usually takes a week. I will send you the contact today.",
    },
    {
        speaker: "speaker_3",
        text: "For the portal itself I want to test the tracking page with real customers early. Lena, could we recruit five or six of your business customers for a short session next month?",
    },
    {
        speaker: "speaker_1",
        text: "Yes, I have a few in mind who complain loudly, which is perfect for this. I will ask them this week.",
    },
    {
        speaker: "speaker_0",
        text: "Timeline. If we have API access by mid-month, Marek thinks a working tracking page is four weeks away. Notifications are another two. Rescheduling we estimate after we see the API.",
    },
    {
        speaker: "speaker_1",
        text: "That works for us. The pilot depot is Rotterdam, and I would like the drivers there to know about it before customers do.",
    },
    {
        speaker: "speaker_0",
        text: "Good point. I will put together the written proposal with scope, timeline and the pilot plan by Friday, and include a short briefing for the drivers.",
    },
    {
        speaker: "speaker_1",
        text: "Perfect. Send it to me and I will take it to our board meeting on the twentieth.",
    },
    {
        speaker: "speaker_0",
        text: "To recap: pilot scope is tracking, notifications and rescheduling. Marek gets API access, Priya runs the customer sessions, and I send the proposal by Friday. Thanks, everyone.",
    },
];

const PRODUCT_SYNC: DemoTurn[] = [
    {
        speaker: "speaker_0",
        text: "Morning. Short one today. Path finder release first, then the Harbor prototype, then anything blocking.",
    },
    {
        speaker: "speaker_2",
        text: "The Path finder release is on track for Thursday. The offline maps fix is merged, and the crash on older Android phones is gone in the beta.",
    },
    {
        speaker: "speaker_0",
        text: "Great. Marek, can you write the release notes this time? Support keeps asking what changed.",
    },
    {
        speaker: "speaker_2",
        text: "Yes, I will have them ready by Wednesday so support can read them before the release.",
    },
    {
        speaker: "speaker_1",
        text: "Harbor prototype: the tracking page is clickable now. I tested it with two people from Blue Fin's customer service, and both understood the arrival window without explanation.",
    },
    {
        speaker: "speaker_1",
        text: "One thing came up twice: people want to see the driver's name. I am not sure we want that, for privacy reasons.",
    },
    {
        speaker: "speaker_0",
        text: "Let us not show the name. A first name and a photo is something drivers would have to agree to. Put it on the list for Lena.",
    },
    {
        speaker: "speaker_2",
        text: "On the API side, I got test access to the Blue Fin dispatch system yesterday. Reading shipments works. Writing a new slot fails with a permission error, so I have asked their IT team.",
    },
    {
        speaker: "speaker_0",
        text: "Is that blocking the estimate?",
    },
    {
        speaker: "speaker_2",
        text: "Partly. I can estimate the reading side now. For rescheduling I need the write access, so maybe end of next week.",
    },
    {
        speaker: "speaker_1",
        text: "Also, the Rotterdam depot sent us their shift plan. The busiest window is between seven and nine in the morning, which is when the notifications should be most careful.",
    },
    {
        speaker: "speaker_0",
        text: "Good. Priya, can you share the prototype link with Lena before Friday, so she can show it at their board meeting?",
    },
    {
        speaker: "speaker_1",
        text: "Will do. I will add a short note on what is real and what is mocked.",
    },
    {
        speaker: "speaker_0",
        text: "Last thing: I want us to book the usability sessions for the week of the twelfth. That is it, thanks.",
    },
];

const DESIGN_REVIEW: DemoTurn[] = [
    {
        speaker: "speaker_0",
        text: "Let us walk through the driver onboarding flow for Path finder. I changed the order since last week: permissions come after the welcome screen now, not before.",
    },
    {
        speaker: "speaker_1",
        text: "That already feels better. Asking for location before saying why was the main complaint in the Path finder reviews.",
    },
    {
        speaker: "speaker_0",
        text: "Right. The welcome screen explains in one sentence why we need the location, then the system prompt comes. In the test, nobody declined it.",
    },
    {
        speaker: "speaker_1",
        text: "How many screens is the whole flow now?",
    },
    {
        speaker: "speaker_0",
        text: "Four. Welcome, permissions, vehicle details, and a practice route. The practice route is optional, but drivers who did it made fewer mistakes on their first day.",
    },
    {
        speaker: "speaker_1",
        text: "Can the depot pre-fill the vehicle details? The drivers often do not know the plate number by heart.",
    },
    {
        speaker: "speaker_0",
        text: "Good idea. If the dispatcher assigns the vehicle first, the app can just ask the driver to confirm it.",
    },
    {
        speaker: "speaker_1",
        text: "Then I am happy with this. Let us ship it in the next Pathfinder release and watch the completion rate.",
    },
];

const LECTURE: DemoTurn[] = [
    {
        speaker: "",
        text: "Good afternoon. Today is about field research: what it means to study people where they actually work, rather than in a meeting room or a lab. I will cover why it matters, how to plan a visit, how to observe without disturbing, and how to turn notes into findings.",
    },
    {
        speaker: "",
        text: "Let us start with why. People are poor reporters of their own routines. Ask a dispatcher how they handle a late truck and they will describe the official process. Watch them for an hour and you will see sticky notes, a second phone, and a colleague they shout to across the room. Those workarounds are where the real requirements hide.",
    },
    {
        speaker: "",
        text: "Planning a visit starts with a question, not a script. Write down the two or three decisions your team needs to make, and what you would have to see to make them with confidence. Then pick sites that differ: a busy depot and a quiet one, an experienced team and a new one.",
    },
    {
        speaker: "",
        text: "Permission matters more than people expect. Ask the site manager, explain what you will record and what you will not, and tell everyone on the floor who you are. If someone does not want to be observed, you thank them and move on. Never record a person who has not agreed to it.",
    },
    {
        speaker: "",
        text: "Now, observing. Your first job is to be boring. Sit where you can see the work but are not in the way. For the first half hour, just watch and write down what happens, with times. Resist the urge to ask why. You will ask later.",
    },
    {
        speaker: "",
        text: "When you do ask, ask about the last time, not about usually. Tell me about the last truck that was late is a much better question than what do you usually do when trucks are late. The last time gives you a story with details; usually gives you the manual.",
    },
    {
        speaker: "",
        text: "Write two kinds of notes and keep them apart: what you saw, and what you think it means. Mixing them is the most common mistake I see. On the page, an observation is something a camera could have recorded. Everything else is interpretation, and it belongs in a separate column.",
    },
    {
        speaker: "",
        text: "After the visit, do the debrief the same day. Memory fades fast, and the small things go first: the sticky note, the sigh, the shortcut. Spend thirty minutes with your team going through the notes and marking surprises.",
    },
    {
        speaker: "",
        text: "Turning notes into findings is a sorting exercise. Put every observation on its own card, group cards that seem to belong together, and name each group with a sentence, not a word. Dispatchers keep a private list of unreliable drivers is a finding. Trust is a label.",
    },
    {
        speaker: "",
        text: "Finally, connect findings back to the decisions you wrote down before the visit. For each decision, say what you saw that supports it, what contradicts it, and what you still do not know. That last part is the start of your next visit.",
    },
    {
        speaker: "",
        text: "For next week, read the two case studies in the course folder and plan a one-hour observation at a workplace you have access to. Bring your question and your site choice to the seminar. Thank you.",
    },
];

const PILOT_CALL: DemoTurn[] = [
    {
        speaker: "S1",
        text: "Hi Lena, thanks for picking up. I wanted to check the pilot scope with you before I send the proposal.",
    },
    {
        speaker: "S2",
        text: "Of course. I talked to our board chair yesterday, and the main question was cost. They want to see what the pilot costs before they agree to anything after it.",
    },
    {
        speaker: "S1",
        text: "That is fair. The proposal has a fixed price for the pilot and a separate estimate for the rollout, so they can decide one at a time.",
    },
    {
        speaker: "S2",
        text: "Good. And the pilot is only Rotterdam, right? Antwerp is in the middle of a system migration and would not cope.",
    },
    {
        speaker: "S1",
        text: "Only Rotterdam. Antwerp would be the first site after the pilot, at the earliest in the summer.",
    },
    {
        speaker: "S2",
        text: "Then I think we are aligned. Send it over and I will put it on the agenda.",
    },
];

const DISPATCHER_INTERVIEW: DemoTurn[] = [
    {
        speaker: "speaker_0",
        text: "Thanks for letting us sit with you this morning. Could you tell me about the last time a customer called about a late delivery?",
    },
    {
        speaker: "speaker_1",
        text: "About twenty minutes ago, actually. A pharmacy. Their delivery was supposed to arrive at nine and the truck was still stuck at the ring road.",
    },
    {
        speaker: "speaker_0",
        text: "What did you do?",
    },
    {
        speaker: "speaker_1",
        text: "First I looked at the board, but the board said on time, because it only updates when the driver scans. So I called the driver, he told me thirty minutes, and I called the pharmacy back.",
    },
    {
        speaker: "speaker_0",
        text: "How often do you call drivers like that?",
    },
    {
        speaker: "speaker_1",
        text: "Thirty, forty times a day. I keep a list of drivers who always answer and who never do. The ones who never answer, I just add half an hour.",
    },
    {
        speaker: "speaker_0",
        text: "If customers could see the live position themselves, what would change for you?",
    },
    {
        speaker: "speaker_1",
        text: "Honestly, I would have my mornings back. But only if it is right. If it is wrong, they will call me anyway, and then I have to explain why the website lies.",
    },
];

/** The recordings, newest first as the list shows them. */
export const DEMO_RECORDINGS: readonly DemoRecording[] = [
    {
        key: "product-sync",
        owner: "alex",
        title: "Weekly product sync",
        daysAgo: 0,
        hour: 9,
        durationMinutes: 27,
        origin: "plaud",
        transcript: {
            provider: "ElevenLabs",
            model: "scribe_v2+diarize",
            language: "en",
            turns: PRODUCT_SYNC,
            speakers: {
                speaker_0: { person: "alex", status: "confirmed" },
                speaker_1: {
                    person: "priya",
                    status: "suggested",
                    confidence: 0.82,
                },
                speaker_2: { status: "open" },
            },
            topics: [
                { title: "Pathfinder release on Thursday", atTurn: 0 },
                { title: "Harbor prototype feedback", atTurn: 4 },
                { title: "Dispatch API access", atTurn: 7 },
                { title: "Rotterdam shift plan and next steps", atTurn: 10 },
            ],
        },
        summary: {
            provider: "Claude Code",
            model: "claude-sonnet-5",
            markdown:
                "## Overview\n\nA short weekly sync covering the Pathfinder release, the Harbor prototype and the Bluefin dispatch API.\n\n## Pathfinder\n\n- Release is on track for **Thursday**; the offline maps fix is merged and the Android crash is fixed in the beta.\n- Marek writes the release notes for support.\n\n## Harbor prototype\n\n- The tracking page is clickable. Two Bluefin customer service testers understood the arrival window without help.\n- Testers asked for the driver's name. The team decided **not** to show it without the drivers' consent.\n\n## Dispatch API\n\n| Area | Status |\n| --- | --- |\n| Reading shipments | Works in test |\n| Writing a new slot | Permission error, asked Bluefin IT |\n\n## Next steps\n\nUsability sessions are planned for the week of the twelfth.",
            keyPoints: [
                "Pathfinder release on Thursday",
                "Driver names stay hidden in the portal",
                "Rescheduling estimate waits for write access",
            ],
            actionItems: [
                "Marek: release notes by Wednesday",
                "Priya: share the prototype link with Lena before Friday",
                "Alex: book usability sessions for the week of the twelfth",
            ],
        },
        tasks: [
            {
                text: "Write the Pathfinder release notes for support",
                assigneeHint: "Marek",
                dueInDays: 1,
                duePhrase: "by Wednesday",
                status: "proposed",
                atTurn: 3,
            },
            {
                text: "Share the Harbor prototype link with Lena before Friday",
                assignee: "priya",
                dueInDays: 3,
                duePhrase: "before Friday",
                status: "proposed",
                atTurn: 11,
            },
            {
                text: "Book the usability sessions for the week of the twelfth",
                assignee: "alex",
                dueInDays: 5,
                duePhrase: "the week of the twelfth",
                status: "proposed",
                atTurn: 13,
            },
        ],
        learn: [
            {
                kind: "speaker",
                label: "speaker_2",
                person: "marek",
                reason: 'Alex asks "Marek, can you write the release notes" and this speaker answers.',
                atTurns: [1, 3],
            },
            {
                kind: "correction",
                heard: "Path finder",
                target: { thing: "pathfinder" },
                replacement: "Pathfinder",
                preTicked: true,
            },
            {
                kind: "correction",
                heard: "Blue Fin",
                target: { thing: "bluefin" },
                replacement: "Bluefin",
                preTicked: true,
            },
            {
                kind: "new_record",
                ref: "n1",
                recordKind: "entity",
                typeKey: "location",
                name: "Rotterdam depot",
                reason: "The depot whose shift plan the team received.",
                atTurns: [10],
            },
            {
                kind: "fact",
                subject: { person: "marek" },
                relationKey: "works_on",
                object: { thing: "pathfinder" },
                atTurn: 1,
                preTicked: false,
            },
        ],
        privateFolders: ["Internal/Team syncs"],
        costs: [
            {
                operation: "transcription",
                provider: "ElevenLabs",
                model: "scribe_v2+diarize",
                audioSeconds: 27 * 60,
                costUsd: 0.099,
            },
            {
                operation: "summary",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 9800,
                outputTokens: 820,
                costUsd: 0.0417,
            },
            {
                operation: "topics",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 9100,
                outputTokens: 140,
                costUsd: 0.0294,
            },
            {
                operation: "learn",
                provider: "Claude Code",
                model: "claude-opus-5",
                inputTokens: 14200,
                outputTokens: 1300,
                costUsd: 0.3105,
            },
            {
                operation: "title",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 2100,
                outputTokens: 12,
                costUsd: 0.0065,
            },
        ],
    },
    {
        key: "voice-memo",
        owner: "alex",
        title: "Ideas for the Q1 roadmap",
        daysAgo: 0,
        hour: 7,
        durationMinutes: 3,
        origin: "plaud",
    },
    {
        key: "kickoff",
        owner: "alex",
        title: "Harbor kickoff with Bluefin Logistics",
        daysAgo: 2,
        hour: 14,
        durationMinutes: 34,
        origin: "plaud",
        transcript: {
            provider: "ElevenLabs",
            model: "scribe_v2+diarize",
            language: "en",
            turns: KICKOFF,
            speakers: {
                speaker_0: { person: "alex", status: "confirmed" },
                speaker_1: { person: "lena", status: "confirmed" },
                speaker_2: { person: "marek", status: "confirmed" },
                speaker_3: { person: "priya", status: "confirmed" },
            },
            topics: [
                {
                    title: "Why dispatchers need self-service tracking",
                    atTurn: 0,
                },
                { title: "Honest arrival windows from Pathfinder", atTurn: 3 },
                { title: "Pilot scope", atTurn: 9 },
                { title: "Dispatch API and customer sessions", atTurn: 11 },
                { title: "Timeline and the written proposal", atTurn: 15 },
            ],
        },
        summary: {
            provider: "Claude Code",
            model: "claude-sonnet-5",
            markdown:
                '## Overview\n\nKickoff of **Harbor**, the customer portal for Bluefin Logistics. The team agreed the scope of the March pilot at the Rotterdam depot.\n\n## Problem\n\nCustomers call the depot to ask where their shipment is, up to two hundred calls a day in Rotterdam. Each call takes a dispatcher away from the ETA board.\n\n## Decisions\n\n- Pilot scope: **tracking with an arrival window**, **email notifications**, and **changing the delivery slot**.\n- Invoicing and returns wait for phase two.\n- Arrival windows come from Pathfinder\'s route planner. Trucks without the app get a plain "arriving today" message instead of a precise window.\n\n## Timeline\n\n| Milestone | Estimate |\n| --- | --- |\n| Tracking page | 4 weeks after API access |\n| Notifications | 2 more weeks |\n| Rescheduling | Estimated once the API is available |\n\n## Open questions\n\n- Write access to the dispatch API needs a request to Bluefin IT (about a week).\n- Drivers in Rotterdam should hear about the pilot before customers do.',
            keyPoints: [
                "Pilot at the Rotterdam depot in March",
                "Scope: tracking, notifications, rescheduling",
                "Arrival windows must be honest, even if less precise",
            ],
            actionItems: [
                "Alex: written proposal with scope, timeline and pilot plan by Friday",
                "Lena: send the IT contact for API access today",
                "Lena: recruit five or six business customers for usability sessions",
            ],
            multiPass: { rounds: 3, used: 3, merged: true },
        },
        tasks: [
            {
                text: "Send the written Harbor proposal with scope, timeline and pilot plan",
                assignee: "alex",
                dueInDays: 1,
                duePhrase: "by Friday",
                status: "open",
                atTurn: 17,
            },
            {
                text: "Request read and write access to the Bluefin dispatch API",
                assignee: "marek",
                dueInDays: -1,
                duePhrase: "mid-month",
                status: "open",
                atTurn: 11,
            },
            {
                text: "Recruit five or six business customers for the tracking page sessions",
                assignee: "lena",
                dueInDays: 6,
                duePhrase: "this week",
                status: "open",
                atTurn: 14,
            },
            {
                text: "Brief the Rotterdam drivers before customers hear about the pilot",
                assignee: "alex",
                status: "done",
                atTurn: 16,
            },
        ],
        privateFolders: ["Clients/Bluefin Logistics"],
        orgFolders: ["Clients/Bluefin Logistics"],
        costs: [
            {
                operation: "transcription",
                provider: "ElevenLabs",
                model: "scribe_v2+diarize",
                audioSeconds: 34 * 60,
                costUsd: 0.1247,
            },
            {
                operation: "summary",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 38400,
                outputTokens: 3100,
                costUsd: 0.1617,
            },
            {
                operation: "topics",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 12600,
                outputTokens: 190,
                costUsd: 0.0407,
            },
            {
                operation: "learn",
                provider: "Claude Code",
                model: "claude-opus-5",
                inputTokens: 18800,
                outputTokens: 1700,
                costUsd: 0.4095,
            },
        ],
    },
    {
        key: "dispatcher-interview",
        owner: "alex",
        title: "Customer interview: depot dispatcher",
        daysAgo: 4,
        hour: 8,
        durationMinutes: 22,
        origin: "video",
        transcript: {
            provider: "ElevenLabs",
            model: "scribe_v2+diarize",
            language: "en",
            turns: DISPATCHER_INTERVIEW,
            speakers: {
                speaker_0: { person: "alex", status: "confirmed" },
                speaker_1: { person: "jonas", status: "confirmed" },
            },
        },
        tasks: [
            {
                text: "Share the dispatcher interview notes with Priya",
                assignee: "alex",
                dueInDays: -2,
                duePhrase: "this week",
                status: "open",
                atTurn: 7,
            },
        ],
        privateFolders: ["Research"],
        costs: [
            {
                operation: "transcription",
                provider: "ElevenLabs",
                model: "scribe_v2+diarize",
                audioSeconds: 22 * 60,
                costUsd: 0.0807,
            },
        ],
    },
    {
        key: "design-review",
        owner: "alex",
        title: "Design review: driver onboarding",
        daysAgo: 6,
        hour: 11,
        durationMinutes: 18,
        origin: "plaud",
        transcript: {
            provider: "ElevenLabs",
            model: "scribe_v2+diarize",
            language: "en",
            turns: DESIGN_REVIEW,
            speakers: {
                speaker_0: { person: "priya", status: "confirmed" },
                speaker_1: { person: "alex", status: "confirmed" },
            },
            corrections: [
                {
                    heard: "Path finder",
                    target: { thing: "pathfinder" },
                    replacement: "Pathfinder",
                },
            ],
        },
        summary: {
            provider: "Claude Code",
            model: "claude-sonnet-5",
            markdown:
                "## Overview\n\nReview of the new driver onboarding flow for Pathfinder.\n\n## Changes since last week\n\n- Location permission is requested **after** the welcome screen, which explains why it is needed.\n- In testing, no driver declined the permission.\n\n## The flow\n\n1. Welcome\n2. Permissions\n3. Vehicle details\n4. Optional practice route\n\n## Decisions\n\n- The dispatcher assigns the vehicle first; the driver only confirms it.\n- Ship in the next Pathfinder release and watch the completion rate.",
            keyPoints: [
                "Permissions after the welcome screen",
                "Four screens, practice route optional",
                "Vehicle details pre-filled by the depot",
            ],
            actionItems: [],
            multiPass: { rounds: 3, used: 2, merged: true },
        },
        privateFolders: ["Internal"],
        costs: [
            {
                operation: "transcription",
                provider: "ElevenLabs",
                model: "scribe_v2+diarize",
                audioSeconds: 18 * 60,
                costUsd: 0.066,
            },
            {
                operation: "summary",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 14400,
                outputTokens: 1500,
                costUsd: 0.0657,
            },
        ],
    },
    {
        key: "pilot-call",
        owner: "alex",
        title: "Call with Lena about pilot scope",
        daysAgo: 8,
        hour: 16,
        durationMinutes: 9,
        origin: "upload",
        transcript: {
            provider: "Speechmatics",
            model: "enhanced+diarize",
            language: "en",
            turns: PILOT_CALL,
            speakers: {
                S1: { person: "alex", status: "confirmed" },
                S2: { person: "lena", status: "confirmed" },
            },
        },
        summary: {
            provider: "Claude Code",
            model: "claude-sonnet-5",
            markdown:
                "## Overview\n\nAlex and Lena checked the Harbor pilot scope before the proposal goes out.\n\n## Points\n\n- Bluefin's board wants to see the **pilot cost** before agreeing to a rollout. The proposal prices the pilot and the rollout separately.\n- The pilot runs **only in Rotterdam**. Antwerp is migrating systems and comes after the pilot, in the summer at the earliest.",
            keyPoints: [
                "Pilot priced separately from rollout",
                "Rotterdam only",
            ],
            actionItems: ["Alex: send the proposal to Lena"],
        },
        tasks: [
            {
                text: "Put the pilot and rollout prices in separate sections of the proposal",
                assignee: "alex",
                status: "done",
                atTurn: 2,
            },
        ],
        privateFolders: ["Clients/Bluefin Logistics"],
        costs: [
            {
                operation: "transcription",
                provider: "Speechmatics",
                model: "enhanced+diarize",
                audioSeconds: 9 * 60,
                costUsd: 0.045,
            },
            {
                operation: "summary",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 3200,
                outputTokens: 420,
                costUsd: 0.0159,
            },
        ],
    },
    {
        key: "lecture",
        owner: "alex",
        title: "Lecture: field research methods",
        daysAgo: 12,
        hour: 15,
        durationMinutes: 48,
        origin: "plaud",
        transcript: {
            provider: "OpenAI",
            model: "whisper-1",
            language: "en",
            turns: LECTURE,
            speakers: {},
            topics: [
                { title: "Why study people where they work", atTurn: 0 },
                { title: "Planning a visit and asking permission", atTurn: 2 },
                {
                    title: "Observing and asking about the last time",
                    atTurn: 4,
                },
                {
                    title: "Notes: what you saw versus what it means",
                    atTurn: 6,
                },
                { title: "From notes to findings", atTurn: 8 },
                { title: "Assignment for next week", atTurn: 10 },
            ],
        },
        summary: {
            provider: "Claude Code",
            model: "claude-sonnet-5",
            markdown:
                '## Overview\n\nA lecture on field research: studying people where they actually work.\n\n## Key ideas\n\n- People describe the official process; observation reveals the **workarounds**, where real requirements hide.\n- Plan visits around **decisions** you need to make, and pick sites that differ.\n- Always ask permission. Never record anyone who has not agreed.\n- Ask about **the last time**, not about "usually".\n- Keep observations and interpretations in separate columns.\n- Debrief the same day, then sort observations into findings named with full sentences.\n\n## Assignment\n\nRead the two case studies and plan a one-hour observation for the seminar.',
            keyPoints: [
                "Observe workarounds, not the official process",
                "Ask about the last time",
                "Separate observation from interpretation",
            ],
            actionItems: [
                "Plan a one-hour observation for next week's seminar",
            ],
        },
        tasks: [
            {
                text: "Plan a one-hour observation for next week's seminar",
                assignee: "alex",
                dueInDays: 5,
                duePhrase: "for next week",
                status: "open",
                atTurn: 10,
            },
        ],
        privateFolders: ["Research"],
        costs: [
            {
                operation: "transcription",
                provider: "OpenAI",
                model: "whisper-1",
                audioSeconds: 48 * 60,
                costUsd: 0.288,
            },
            {
                operation: "summary",
                provider: "Claude Code",
                model: "claude-sonnet-5",
                inputTokens: 21000,
                outputTokens: 900,
                costUsd: 0.0765,
            },
        ],
    },
    {
        key: "usability-test",
        owner: "priya",
        title: "Usability test: tracking page",
        daysAgo: 1,
        hour: 13,
        durationMinutes: 31,
        origin: "plaud",
        transcript: {
            provider: "ElevenLabs",
            model: "scribe_v2+diarize",
            language: "en",
            turns: [
                {
                    speaker: "speaker_0",
                    text: "Thanks for joining. Please think aloud while you look at this page. Where is your shipment right now?",
                },
                {
                    speaker: "speaker_1",
                    text: "It says out for delivery, arriving between ten and twelve. And there is a little map. So it is on the way.",
                },
                {
                    speaker: "speaker_0",
                    text: "Suppose you will not be there at eleven. What would you do?",
                },
                {
                    speaker: "speaker_1",
                    text: "I would look for a button to change it. Here, change delivery slot. Yes, that is clear.",
                },
            ],
            speakers: {
                speaker_0: { person: "priya", status: "confirmed" },
                speaker_1: { status: "unknown" },
            },
        },
        summary: {
            provider: "Claude Code",
            model: "claude-sonnet-5",
            markdown:
                "## Overview\n\nThink-aloud test of the Harbor tracking page with one Bluefin business customer.\n\n## Findings\n\n- The participant read the arrival window and the map without help.\n- **Change delivery slot** was found immediately.",
            keyPoints: [
                "Arrival window understood",
                "Rescheduling found at once",
            ],
            actionItems: [],
        },
        orgFolders: ["Usability studies"],
    },
];
