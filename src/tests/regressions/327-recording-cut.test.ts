import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sniffAudio } from "@/lib/audio/sniff";
import { planAdvance } from "@/lib/pipeline/plan";
import type { PipelineFacts } from "@/lib/pipeline/types";
import { cutAudio } from "@/lib/recordings/cut-audio";
import {
    cutTranscript,
    cutTurn,
    parseCutTime,
    snapCutEdge,
    validCutRange,
} from "@/lib/recordings/cut-range";
import { containingTurnIndex, sentenceStarts } from "@/lib/topics/timeline";
import { runFfmpeg } from "@/lib/transcription/ffmpeg";

function hasFfmpeg(): boolean {
    const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return probe.status === 0;
}

const turns = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Private opening." },
    { speaker: "S2", startMs: 3000, endMs: 6000, text: "Keep this." },
    { speaker: "S1", startMs: 7000, endMs: 10000, text: "Private ending." },
];

describe("recording cut range", () => {
    it("includes sentence starts at the start and excludes those at the end", () => {
        expect(cutTranscript(turns, { startMs: 3000, endMs: 7000 })).toEqual({
            turns: [{ ...turns[1], startMs: 0, endMs: 3000 }],
            text: "S2: Keep this.",
            turnIndices: new Map([[1, 0]]),
        });
        expect(
            cutTranscript(turns, { startMs: 4000, endMs: 8000 }).turns,
        ).toEqual([
            {
                ...turns[2],
                startMs: 3000,
                endMs: 4000,
                sentenceStartsMs: [3000],
            },
        ]);
    });
    it.each([
        false,
        true,
    ])("splits both edges inside one turn (stored=%s)", (stored) => {
        const text = "Opening.  Keep this. Ending.";
        const turn = {
            speaker: "S1",
            startMs: 0,
            endMs: 27000,
            text,
            ...(stored ? { sentenceStartsMs: [0, 12000, 22000] } : {}),
        };
        const startMs = stored ? 12000 : 9643;
        const endMs = stored ? 22000 : 20250;
        const result = cutTurn(turn, { startMs, endMs });
        expect(result).toEqual({
            charStart: 10,
            charEnd: 20,
            turn: {
                speaker: "S1",
                startMs: 0,
                endMs: endMs - startMs,
                text: "Keep this.",
                sentenceStartsMs: [0],
            },
        });
        expect(turn.text).toBe(text);
    });
    it("keeps raw internal whitespace so correction offsets remain valid", () => {
        const turn = {
            speaker: "S1",
            startMs: 0,
            endMs: 10000,
            text: "Remove.  Keep  these words.\nNext. Tail.",
            sentenceStartsMs: [0, 2000, 5000, 8000],
        };
        expect(cutTurn(turn, { startMs: 2000, endMs: 8000 })).toMatchObject({
            charStart: 9,
            charEnd: 33,
            turn: {
                text: "Keep  these words.\nNext.",
                sentenceStartsMs: [0, 3000],
            },
        });
    });
    it("equals the old whole-turn result for non-overlapping turns when both edges are turn starts", () => {
        const range = { startMs: 3000, endMs: 7000 };
        const previous = turns
            .filter(
                (turn) =>
                    (turn.startMs + turn.endMs) / 2 >= range.startMs &&
                    (turn.startMs + turn.endMs) / 2 < range.endMs,
            )
            .map((turn) => ({
                ...turn,
                startMs: Math.max(turn.startMs, range.startMs) - range.startMs,
                endMs: Math.min(turn.endMs, range.endMs) - range.startMs,
            }));
        expect(cutTranscript(turns, range).turns).toEqual(previous);
    });
    it("orders overlapping retained turns chronologically with stable ties", () => {
        const overlapping = [
            {
                speaker: "S1",
                startMs: 0,
                endMs: 10000,
                text: "Opening. Kept words.",
                sentenceStartsMs: [0, 6000],
            },
            { speaker: "S2", startMs: 4000, endMs: 5000, text: "Yes." },
            { speaker: "S3", startMs: 6000, endMs: 7000, text: "Agreed." },
            { speaker: "S1", startMs: 12000, endMs: 14000, text: "End." },
        ];
        const kept = cutTranscript(overlapping, {
            startMs: 4000,
            endMs: 12000,
        });
        expect(
            kept.turns.map(({ speaker, startMs }) => ({ speaker, startMs })),
        ).toEqual([
            { speaker: "S2", startMs: 0 },
            { speaker: "S1", startMs: 2000 },
            { speaker: "S3", startMs: 2000 },
        ]);
        expect(kept.turns[containingTurnIndex(kept.turns, 500)].speaker).toBe(
            "S2",
        );
    });
    it("preserves legacy sentence clocks through an end clamp and a second cut", () => {
        const raw = {
            speaker: "S1",
            startMs: 0,
            endMs: 10000,
            text: "One. Two.",
        };
        const first = cutTranscript([raw], { startMs: 0, endMs: 8000 });
        expect(sentenceStarts(first.turns[0])).toEqual(sentenceStarts(raw));
        const second = cutTranscript(first.turns, {
            startMs: 5000,
            endMs: 8000,
        });
        const direct = cutTranscript([raw], { startMs: 5000, endMs: 8000 });
        expect(second).toEqual(direct);
        expect(second.turns[0]).toMatchObject({
            text: "Two.",
            startMs: 556,
            sentenceStartsMs: [556],
        });
    });
    it("keeps an untouched legacy turn's shape after rebasing", () => {
        const raw = {
            speaker: "S1",
            startMs: 2000,
            endMs: 8000,
            text: "One. Two.",
        };
        expect(cutTurn(raw, { startMs: 1000, endMs: 9000 })?.turn).toEqual({
            ...raw,
            startMs: 1000,
            endMs: 7000,
        });
    });
    it("keeps the clamped turn start when sentence zero survives", () => {
        const raw = {
            speaker: "S1",
            startMs: 1000,
            endMs: 8000,
            text: "One. Two.",
            sentenceStartsMs: [1200, 5000],
        };
        expect(cutTurn(raw, { startMs: 1100, endMs: 8000 })?.turn.startMs).toBe(
            0,
        );
        expect(cutTurn(raw, { startMs: 2000, endMs: 8000 })?.turn.startMs).toBe(
            3000,
        );
    });
    it("snaps to sentence starts with different start and end endpoints", () => {
        const turn = {
            speaker: "S1",
            startMs: 3000,
            endMs: 9000,
            text: "One. Two.",
            sentenceStartsMs: [3000, 7000],
        };
        expect(snapCutEdge([turn], 1000, "start", 10000)).toBe(0);
        expect(snapCutEdge([turn], 1000, "end", 10000)).toBe(3000);
        expect(snapCutEdge([turn], 9500, "start", 10000)).toBe(7000);
        expect(snapCutEdge([turn], 9500, "end", 10000)).toBe(10000);
        expect(snapCutEdge([turn], 5000, "start", 10000)).toBe(3000);
        expect(
            snapCutEdge(
                [{ ...turn, sentenceStartsMs: undefined }],
                6000,
                "start",
                10000,
            ),
        ).toBe(6333);
    });
    it.each([
        ["05:18", 318000],
        ["1:02:03", 3723000],
        ["125:00", 7500000],
        [" 0:09 ", 9000],
    ])("parses %s", (value, expected) => {
        expect(parseCutTime(String(value))).toBe(expected);
    });
    it.each([
        "5",
        "1:60",
        "1:99:00",
        "1:2:03",
        "-1:05",
        "1:2",
        "",
        "[01:05]",
        "999999999999999:00",
    ])("rejects %s", (value) => {
        expect(parseCutTime(value)).toBeNull();
    });
    it.each([
        [0, 10000],
        [-1, 5000],
        [5000, 5000],
        [6000, 5000],
        [0, 10001],
        [0.5, 5000],
        [0, Number.NaN],
    ])("refuses invalid range %s to %s", (startMs, endMs) => {
        expect(validCutRange({ startMs, endMs }, 10000)).toBe(false);
    });
    it("accepts either edge and both edges", () => {
        for (const range of [
            { startMs: 1, endMs: 10000 },
            { startMs: 0, endMs: 9000 },
            { startMs: 3000, endMs: 6000 },
        ])
            expect(validCutRange(range, 10000)).toBe(true);
    });
});

describe.skipIf(!hasFfmpeg())("ffmpeg cuts", () => {
    it.each([
        ["ogg", "libopus", 20, 48000],
        ["m4a", "aac", 24, 48000],
        ["mp3", "libmp3lame", 27, 48000],
        ["mp3", "libmp3lame", 36, 16000],
        ["wav", "pcm_s16le", 1, 48000],
    ] as const)(
        "keeps the %s container and measures within one frame",
        async (extension, codec, tolerance, rate) => {
            const directory = await mkdtemp(path.join(tmpdir(), "cut-test-"));
            try {
                const filename = path.join(directory, `audio.${extension}`);
                execFileSync("ffmpeg", [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    `sine=frequency=440:sample_rate=${rate}:duration=6`,
                    "-c:a",
                    codec,
                    filename,
                ]);
                const original = await readFile(filename);
                const output = await cutAudio(original, {
                    startMs: 1234,
                    endMs: 4567,
                });
                expect(sniffAudio(output.audio).extension).toBe(extension);
                expect(Math.abs(output.duration - 3333)).toBeLessThanOrEqual(
                    tolerance,
                );
                expect(output.audio.length).toBeGreaterThan(0);
                if (extension === "wav") {
                    const args = [
                        "-vn",
                        "-c:a",
                        "pcm_s16le",
                        "-f",
                        "s16le",
                        "pipe:1",
                    ];
                    const [before, after] = await Promise.all([
                        runFfmpeg(original, args),
                        runFfmpeg(output.audio, args),
                    ]);
                    expect(
                        after.equals(
                            before.subarray(1234 * 48 * 2, 4567 * 48 * 2),
                        ),
                    ).toBe(true);
                }
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
        20000,
    );
});

it.each([
    "use",
    "also_transcribe",
] as const)("keeps the profile transcript choice after a cut (%s)", (plaudTranscript) => {
    const facts: PipelineFacts = {
        item: {
            exists: true,
            deleted: false,
            kind: "audio",
            ownerUserId: "owner",
        },
        view: "private",
        generation: 2,
        content: null,
        transcription: {
            riffado: null,
            plaud: {
                contentId: "plaud",
                contentSourceId: "plaud",
                contentRevision: 1,
                timed: true,
            },
            jobActive: false,
            cut: true,
        },
        summaryDueAt: null,
        profile: {
            revisionId: "profile",
            transcribe: { automatic: true, plaudTranscript },
            automatic: {
                learn: false,
                summary: true,
                title: true,
                topics: true,
            },
        },
        categorization: {
            placementFolderIds: ["folder"],
            intendedFolderIds: [],
            profileAssigned: true,
            resolution: "resolved",
        },
        hasEnhancementCredential: true,
        mail: null,
        summary: { exists: false, stale: false, jobActive: false },
        taskReview: { proposals: 0, followUps: 0 },
        phases: {
            categorize: {
                state: "done",
                generation: 1,
                at: "2026-11-03T00:00:00Z",
            },
        },
        at: "2026-11-03T00:00:00Z",
    };
    const plan = planAdvance(facts);
    expect(
        plan.actions.some((action) => action.type === "queueTranscription"),
    ).toBe(plaudTranscript !== "use");
    expect(plan.actions.some((action) => action.type === "queueSummary")).toBe(
        plaudTranscript === "use",
    );
    expect(plan).toEqual(
        planAdvance({
            ...facts,
            transcription: facts.transcription
                ? { ...facts.transcription, cut: false }
                : undefined,
        }),
    );
});
