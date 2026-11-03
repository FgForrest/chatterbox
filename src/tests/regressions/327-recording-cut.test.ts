import { execFileSync } from "node:child_process";
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
    snapCutEdge,
    validCutRange,
} from "@/lib/recordings/cut-range";
import { runFfmpeg } from "@/lib/transcription/ffmpeg";

const turns = [
    { speaker: "S1", startMs: 0, endMs: 2000, text: "Private opening." },
    { speaker: "S2", startMs: 3000, endMs: 6000, text: "Keep this." },
    { speaker: "S1", startMs: 7000, endMs: 10000, text: "Private ending." },
];

describe("recording cut range", () => {
    it("keeps turns by their middle, clamps, shifts and uses the shared renderer", () => {
        expect(cutTranscript(turns, { startMs: 4000, endMs: 8000 })).toEqual({
            turns: [
                { speaker: "S2", startMs: 0, endMs: 2000, text: "Keep this." },
            ],
            text: "S2: Keep this.",
        });
    });
    it("includes a middle at the start and excludes one at the end", () => {
        expect(
            cutTranscript(turns, { startMs: 1000, endMs: 4500 }).turns.map(
                (turn) => turn.speaker,
            ),
        ).toEqual(["S1"]);
    });
    it("snaps both playback edges and gaps in opposite directions", () => {
        expect(snapCutEdge(turns, 4500, "start")).toBe(3000);
        expect(snapCutEdge(turns, 4500, "end")).toBe(6000);
        expect(snapCutEdge(turns, 2500, "start")).toBe(3000);
        expect(snapCutEdge(turns, 2500, "end")).toBe(2000);
        expect(snapCutEdge([], 2500, "start")).toBe(2500);
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

describe("ffmpeg cuts", () => {
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
