/**
 * Audio extracted from an uploaded video is an M4A whose index follows the
 * media. ffmpeg cannot demux that from a pipe and exits 0 with nothing
 * decoded, so every video upload lost its waveform ("Decoded audio contains
 * no samples") and the same input would have reached Whisper as an empty
 * file.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateServerWaveform } from "@/lib/audio/server-waveform";
import { ffmpegToOpus, runFfmpeg } from "@/lib/transcription/ffmpeg";

const FIXTURE = path.join(__dirname, "..", "fixtures", "sample.mp3");
const hasFfmpeg =
    spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasFfmpeg)("M4A with its index after the media", () => {
    let directory: string;
    let m4a: Buffer;

    beforeAll(() => {
        directory = mkdtempSync(path.join(tmpdir(), "video-audio-"));
        const output = path.join(directory, "audio.m4a");
        const encoded = spawnSync("ffmpeg", [
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=10",
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            output,
        ]);
        expect(encoded.status).toBe(0);
        m4a = readFileSync(output);
    });

    afterAll(() => rmSync(directory, { recursive: true, force: true }));

    it("is the layout under test, too large for ffmpeg's pipe buffer", () => {
        expect(m4a.indexOf("moov")).toBeGreaterThan(m4a.indexOf("mdat"));
        expect(m4a.length).toBeGreaterThan(100_000);
    });

    it("yields a waveform", async () => {
        const peaks = await generateServerWaveform(m4a, 50);
        expect(peaks).toHaveLength(50);
        expect(Math.max(...peaks)).toBe(1);
    });

    it("compresses for Whisper", async () => {
        const ogg = await ffmpegToOpus(m4a, 16);
        expect(ogg.subarray(0, 4).toString("latin1")).toBe("OggS");
        expect(ogg.length).toBeGreaterThan(10_000);
    });
});

describe.skipIf(!hasFfmpeg)("runFfmpeg", () => {
    it("rejects a run that decodes nothing", async () => {
        await expect(
            runFfmpeg(readFileSync(FIXTURE), [
                "-t",
                "0",
                "-f",
                "s16le",
                "pipe:1",
            ]),
        ).rejects.toThrow("ffmpeg produced no output");
    });
});
