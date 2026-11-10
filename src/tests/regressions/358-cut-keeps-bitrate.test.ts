import type * as childProcess from "node:child_process";
import {
    type ExecFileOptions,
    execFileSync,
    spawnSync,
} from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as util from "node:util";
import * as metadata from "music-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sniffAudio } from "@/lib/audio/sniff";
import { cutAudio } from "@/lib/recordings/cut-audio";

vi.mock("music-metadata", { spy: true });

const copyProbe = vi.hoisted(() => ({
    unavailable: false,
    fails: false,
    copyFails: false,
    invalidDuration: false,
    commands: [] as string[][],
    abort: undefined as AbortController | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof childProcess>();
    const { promisify } = await vi.importActual<typeof util>("node:util");
    const execute = promisify(actual.execFile);
    return {
        ...actual,
        execFile: Object.assign(actual.execFile.bind(actual), {
            [promisify.custom]: (
                command: string,
                args: string[],
                options: ExecFileOptions,
            ) => {
                copyProbe.commands.push(args);
                if (
                    args.includes("null") &&
                    !args.includes("copy") &&
                    copyProbe.invalidDuration
                ) {
                    copyProbe.invalidDuration = false;
                    return Promise.resolve({
                        stdout: "out_time_us=157000\n",
                        stderr: "",
                    });
                }
                if (args.includes("-b:a") && copyProbe.abort) {
                    copyProbe.abort.abort();
                    return Promise.reject(copyProbe.abort.signal.reason);
                }
                if (
                    args.includes("copy") &&
                    !args.includes("null") &&
                    copyProbe.copyFails
                )
                    return Promise.reject(new Error("Stream copy failed"));
                if (args.includes("copy") && args.includes("null")) {
                    if (copyProbe.fails)
                        return Promise.reject(
                            new Error("Copy duration unavailable"),
                        );
                    if (copyProbe.unavailable)
                        return Promise.resolve({
                            stdout: "out_time_us=N/A\n",
                            stderr: "",
                        });
                }
                return execute(command, args, options);
            },
        }),
    };
});

function hasFfmpeg(): boolean {
    const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return probe.status === 0;
}

async function fixture(
    extension: string,
    encoder: string,
    rate: number,
    channels: number,
    options: string[],
    source = `sine=frequency=440:sample_rate=${rate}:duration=30`,
): Promise<Buffer> {
    const directory = await mkdtemp(path.join(tmpdir(), "cut-bitrate-test-"));
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
            source,
            "-c:a",
            encoder,
            "-ac",
            String(channels),
            ...options,
            filename,
        ]);
        return await readFile(filename);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const range = { startMs: 4096, endMs: 24128 };
const keptMs = range.endMs - range.startMs;

async function decodedFormat(audio: Buffer) {
    const directory = await mkdtemp(path.join(tmpdir(), "cut-format-test-"));
    try {
        const source = path.join(directory, "source");
        await writeFile(source, audio);
        const wav = execFileSync(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                source,
                "-t",
                "0.01",
                "-map",
                "0:a:0",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "pipe:1",
            ],
            {},
        );
        return (await metadata.parseBuffer(wav)).format;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function expectSize(
    original: Buffer,
    cut: Buffer,
    label: string,
    durationMs = keptMs,
    sourceDurationMs = 30000,
    headerBytes = 0,
) {
    console.info(
        `${label}: ${original.length} source bytes -> ${cut.length} cut bytes`,
    );
    const tolerance = sniffAudio(original).extension === "webm" ? 1.15 : 1.1;
    expect(cut.length).toBeLessThanOrEqual(
        original.length * (durationMs / sourceDurationMs) * tolerance +
            2048 +
            headerBytes,
    );
}

afterEach(() => {
    vi.mocked(metadata.parseFile).mockReset();
    copyProbe.unavailable = false;
    copyProbe.fails = false;
    copyProbe.copyFails = false;
    copyProbe.invalidDuration = false;
    copyProbe.commands = [];
    copyProbe.abort = undefined;
});

describe.skipIf(!hasFfmpeg())("cut keeps compressed audio settings", () => {
    it.each([
        ["mp3", "libmp3lame", 16000, 1, ["-b:a", "16000"]],
        ["mp3", "libmp3lame", 8000, 1, ["-b:a", "8000"]],
        ["mp3", "libmp3lame", 44100, 2, ["-b:a", "32000"]],
        ["mp3", "libmp3lame", 16000, 1, ["-q:a", "9"]],
        ["mp3", "libmp3lame", 44100, 2, ["-q:a", "9"]],
        ["ogg", "libopus", 16000, 1, ["-b:a", "16000"]],
        ["ogg", "libopus", 8000, 1, ["-b:a", "16000"]],
        ["ogg", "libopus", 12000, 1, ["-b:a", "16000"]],
        ["ogg", "libopus", 24000, 1, ["-b:a", "16000"]],
        ["ogg", "libopus", 44100, 1, ["-b:a", "16000"]],
        ["ogg", "libopus", 48000, 2, ["-b:a", "16000"]],
        ["m4a", "aac", 16000, 1, ["-b:a", "16000"]],
        ["m4a", "aac", 44100, 2, ["-b:a", "32000"]],
        ["aac", "aac", 16000, 1, ["-b:a", "16000"]],
        ["ogg", "libvorbis", 16000, 1, ["-b:a", "16000"]],
        ["ogg", "libvorbis", 48000, 2, ["-b:a", "48000"]],
    ])(
        "%s/%s at %i Hz, %i channels with %j stays within 10 percent plus 2 KiB for container headers, encoder delay and VBR variation",
        async (extension, encoder, rate, channels, options) => {
            const original = await fixture(
                extension,
                encoder,
                rate,
                channels,
                options,
            );
            const before = await decodedFormat(original);
            const output = await cutAudio(original, range);
            const after = await decodedFormat(output.audio);
            expect(sniffAudio(output.audio).extension).toBe(extension);
            expect(after.sampleRate).toBe(before.sampleRate);
            expect(after.numberOfChannels).toBe(channels);
            expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(128);
            expectSize(
                original,
                output.audio,
                `${extension}/${encoder} ${rate} Hz ${channels} ch ${options.join(" ")}`,
            );
            expect(
                copyProbe.commands.filter(
                    (args) => args.includes("null") && args.includes("copy"),
                ),
            ).toHaveLength(1);
            expect(
                copyProbe.commands.every(
                    (args) => !args.includes("-ar") && !args.includes("-ac"),
                ),
            ).toBe(true);
            expect(metadata.parseFile).toHaveBeenCalledWith(
                expect.stringMatching(/output\./),
                { skipCovers: true },
            );
            expect(
                vi
                    .mocked(metadata.parseFile)
                    .mock.calls.every(
                        ([filename, options]) =>
                            !filename.endsWith("source") && !options?.duration,
                    ),
            ).toBe(true);
            const probe = copyProbe.commands.find(
                (args) => args.includes("null") && args.includes("copy"),
            );
            expect(probe?.[probe.indexOf("-i") + 1]).toMatch(/output\./);
        },
        20000,
    );

    it.each([
        0, 60,
    ])("keeps WebM/Opus within 15 percent plus 2 KiB for packet headers, preserving rate and channels with timestamp offset %s", async (offset) => {
        const original = await fixture("webm", "libopus", 16000, 1, [
            "-b:a",
            "16000",
            "-output_ts_offset",
            String(offset),
        ]);
        const before = await metadata.parseBuffer(
            original,
            { size: original.length },
            { duration: true },
        );
        expect(before.format.bitrate).toBeUndefined();
        const output = await cutAudio(original, range);
        const after = await decodedFormat(output.audio);
        expectSize(original, output.audio, `webm/libopus offset ${offset}`);
        expect(output.audio.length).toBeGreaterThan(
            original.length * (keptMs / 30000) * 0.9,
        );
        expect(output.extension).toBe("webm");
        expect(after.sampleRate).toBe(48000);
        expect(after.numberOfChannels).toBe(1);
        expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(20);
    });

    it.each([
        [16000, 32000],
        [8000, 192000],
    ])(
        "keeps the first M4A track's rate, channels and %i Hz second-track-independent %i bps bitrate",
        async (secondRate, firstBitrate) => {
            const directory = await mkdtemp(
                path.join(tmpdir(), "cut-two-track-test-"),
            );
            try {
                const filename = path.join(directory, "two-track.m4a");
                const firstTrack = path.join(directory, "first.m4a");
                execFileSync("ffmpeg", [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=30",
                    "-f",
                    "lavfi",
                    "-i",
                    `sine=frequency=880:sample_rate=${secondRate}:duration=30`,
                    "-map",
                    "0:a:0",
                    "-map",
                    "1:a:0",
                    "-c:a",
                    "aac",
                    "-ac:a:0",
                    "2",
                    "-b:a:0",
                    String(firstBitrate),
                    "-b:a:1",
                    "8000",
                    filename,
                ]);
                execFileSync("ffmpeg", [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    filename,
                    "-map",
                    "0:a:0",
                    "-c:a",
                    "copy",
                    firstTrack,
                ]);
                const original = await readFile(filename);
                const reported = await metadata.parseBuffer(original);
                expect(reported.format.sampleRate).toBe(secondRate);
                expect(reported.format.numberOfChannels).toBe(1);
                const output = await cutAudio(original, range);
                const after = await decodedFormat(output.audio);
                expect(after.sampleRate).toBe(48000);
                expect(after.numberOfChannels).toBe(2);
                const encoded = await metadata.parseBuffer(output.audio);
                console.info(
                    `two-track M4A ${firstBitrate} bps: ${encoded.format.bitrate} output bps`,
                );
                if (firstBitrate === 192000)
                    expect(encoded.format.bitrate).toBeGreaterThanOrEqual(
                        160000,
                    );
                expectSize(
                    await readFile(firstTrack),
                    output.audio,
                    "m4a/aac first track 48000 Hz 2 ch",
                );
                expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(
                    22,
                );
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
        20000,
    );

    it("keeps a 13–123 ms MP3 cut at no more than 24 kbps", async () => {
        const original = await fixture("mp3", "libmp3lame", 16000, 1, [
            "-b:a",
            "16000",
        ]);
        const output = await cutAudio(original, { startMs: 13, endMs: 123 });
        const encoded = await metadata.parseBuffer(output.audio);
        console.info(
            `MP3 13–123 ms: ${encoded.format.bitrate} output bps, ${output.audio.length} bytes`,
        );
        expect(encoded.format.bitrate).toBeLessThanOrEqual(24000);
        expect(Math.abs(output.duration - 110)).toBeLessThanOrEqual(36);
    });

    it("keeps a one-second noisy Vorbis cut at 32 kbps within 10 percent plus 2 KiB and measured Vorbis headers", async () => {
        const original = await fixture(
            "ogg",
            "libvorbis",
            48000,
            1,
            ["-b:a", "32000"],
            "anoisesrc=sample_rate=48000:duration=10:seed=42",
        );
        const output = await cutAudio(original, { startMs: 1234, endMs: 2234 });
        const nearEmpty = await fixture(
            "ogg",
            "libvorbis",
            48000,
            1,
            ["-b:a", "32000"],
            "anoisesrc=sample_rate=48000:duration=0.001:seed=42",
        );
        const encoded = await metadata.parseBuffer(output.audio);
        expect(encoded.format.bitrate).toBeCloseTo(32000, -3);
        console.info(
            `one-second noisy Vorbis: ${encoded.format.bitrate} output bps, ${nearEmpty.length} near-empty header bytes`,
        );
        expectSize(
            original,
            output.audio,
            "one-second noisy Vorbis 32 kbps",
            1000,
            10000,
            nearEmpty.length,
        );
        expect(Math.abs(output.duration - 1000)).toBeLessThanOrEqual(43);
    });

    it("cuts 48 kHz mono Vorbis from 13 to 123 ms", async () => {
        const original = await fixture("ogg", "libvorbis", 48000, 1, [
            "-b:a",
            "32000",
        ]);
        const output = await cutAudio(original, { startMs: 13, endMs: 123 });
        expect(output.duration).toBe(110);
        const after = await decodedFormat(output.audio);
        expect(after.sampleRate).toBe(48000);
        expect(after.numberOfChannels).toBe(1);
        console.info(
            `ogg/libvorbis 48000 Hz mono 13–123 ms: ${original.length} source bytes -> ${output.audio.length} cut bytes`,
        );
    });

    it("retries defaults when the bitrate output fails duration verification", async () => {
        const original = await fixture("ogg", "libvorbis", 48000, 1, [
            "-b:a",
            "32000",
        ]);
        copyProbe.invalidDuration = true;
        const output = await cutAudio(original, { startMs: 13, endMs: 123 });
        expect(output.duration).toBe(110);
        const encodes = copyProbe.commands.filter((args) =>
            args.includes("libvorbis"),
        );
        expect(encodes).toHaveLength(2);
        expect(encodes[0]).toContain("-b:a");
        expect(encodes[1]).not.toContain("-b:a");
    });

    it("retries defaults when a bitrate encode fails", async () => {
        const original = await fixture("ogg", "libvorbis", 48000, 1, [
            "-b:a",
            "32000",
        ]);
        const before = await metadata.parseBuffer(original);
        vi.mocked(metadata.parseFile).mockResolvedValueOnce({
            ...before,
            format: { ...before.format, bitrate: 1, sampleRate: 8000 },
        });
        copyProbe.copyFails = true;
        const output = await cutAudio(original, range);
        expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(43);
        const encodes = copyProbe.commands.filter((args) =>
            args.includes("libvorbis"),
        );
        expect(encodes).toHaveLength(2);
        expect(encodes[0]).toContain("-b:a");
        expect(encodes[1]).not.toContain("-b:a");
    });

    it("propagates aborts without retrying encoder defaults", async () => {
        const original = await fixture("webm", "libopus", 16000, 1, [
            "-b:a",
            "16000",
        ]);
        const controller = new AbortController();
        copyProbe.abort = controller;
        const result = cutAudio(original, range, controller.signal);
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        await expect(result).rejects.toBe(controller.signal.reason);
        expect(
            copyProbe.commands.filter((args) => args.includes("libopus")),
        ).toHaveLength(1);
    });

    it.each([
        "missing",
        "failed",
        "copy failed",
    ])("uses reported bitrate when the copy probe is %s", async (probe) => {
        const original = await fixture("mp3", "libmp3lame", 16000, 1, [
            "-b:a",
            "16000",
        ]);
        copyProbe.unavailable = probe === "missing";
        copyProbe.fails = probe === "failed";
        copyProbe.copyFails = probe === "copy failed";
        const output = await cutAudio(original, range);
        const encoding = copyProbe.commands.find((args) =>
            args.includes("libmp3lame"),
        );
        expect(encoding?.[encoding.indexOf("-b:a") + 1]).toBe("16000");
        expectSize(
            original,
            output.audio,
            `mp3/libmp3lame reported bitrate after ${probe}`,
        );
        expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(36);
    });

    it.each([
        "missing",
        "failed",
        "copy failed",
    ])("keeps encoder defaults when bitrate is unknown and the copy probe %s", async (probe) => {
        const original = await fixture("webm", "libopus", 16000, 1, [
            "-b:a",
            "16000",
        ]);
        const before = await metadata.parseBuffer(
            original,
            { size: original.length },
            { duration: true },
        );
        expect(before.format.bitrate).toBeUndefined();
        vi.mocked(metadata.parseFile).mockResolvedValueOnce({
            ...before,
            format: { ...before.format, duration: undefined },
        });
        copyProbe.unavailable = probe === "missing";
        copyProbe.fails = probe === "failed";
        copyProbe.copyFails = probe === "copy failed";
        const output = await cutAudio(original, range);
        const baseline = execFileSync(
            "ffmpeg",
            [
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-ss",
                String(range.startMs / 1000),
                "-t",
                String(keptMs / 1000),
                "-map",
                "0:a:0",
                "-vn",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-c:a",
                "libopus",
                "-f",
                "webm",
                "pipe:1",
            ],
            { input: original },
        );
        const packets = (audio: Buffer) =>
            execFileSync(
                "ffmpeg",
                [
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    "pipe:0",
                    "-map",
                    "0:a:0",
                    "-c:a",
                    "copy",
                    "-f",
                    "hash",
                    "pipe:1",
                ],
                { input: audio, encoding: "utf8" },
            );
        expect(packets(output.audio)).toBe(packets(baseline));
        expect(output.extension).toBe("webm");
        expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(20);
    });

    it.each([
        ["ogg", "libopus", { sampleRate: 44100 }],
        ["ogg", "libopus", { bitrate: 1 }],
        ["ogg", "libopus", { bitrate: 1000000 }],
        ["ogg", "libopus", { sampleRate: undefined }],
        ["ogg", "libopus", { numberOfChannels: undefined }],
        ["mp3", "libmp3lame", { bitrate: 1 }],
        ["mp3", "libmp3lame", { bitrate: 1000000 }],
        ["m4a", "aac", { bitrate: 1 }],
        ["m4a", "aac", { bitrate: 1000000 }],
        ["ogg", "libvorbis", { bitrate: 1 }],
        ["ogg", "libvorbis", { bitrate: 1000000 }],
        [
            "ogg",
            "libopus",
            {
                bitrate: undefined,
                sampleRate: undefined,
                numberOfChannels: undefined,
            },
        ],
        [
            "ogg",
            "libopus",
            { bitrate: Number.NaN, sampleRate: 0, numberOfChannels: -1 },
        ],
        ["mp3", "libmp3lame", { sampleRate: 12345 }],
    ] as const)(
        "handles encoder limits and missing metadata for %s/%s: %j",
        async (extension, encoder, overrides) => {
            const original = await fixture(extension, encoder, 16000, 1, [
                "-b:a",
                "16000",
            ]);
            const before = await metadata.parseBuffer(
                original,
                { size: original.length },
                { duration: true },
            );
            vi.mocked(metadata.parseFile).mockResolvedValueOnce({
                ...before,
                format: { ...before.format, ...overrides },
            });
            copyProbe.copyFails = true;
            const output = await cutAudio(original, range);
            const after = await metadata.parseBuffer(
                output.audio,
                { size: output.audio.length },
                { duration: true },
            );
            expect(after.format.numberOfChannels).toBe(1);
            expect(after.format.sampleRate).toBe(
                encoder === "libopus" ? 48000 : 16000,
            );
            if ("bitrate" in overrides && overrides.bitrate === 1)
                expect(after.format.bitrate).toBeLessThanOrEqual(
                    encoder === "libvorbis" ? 16000 : 10000,
                );
            if ("bitrate" in overrides && overrides.bitrate === 1000000) {
                if (encoder === "libmp3lame")
                    expect(after.format.bitrate).toBe(160000);
                if (encoder === "libvorbis")
                    expect(after.format.bitrate).toBe(100000);
                if (encoder === "libopus")
                    expect(after.format.bitrate).toBeLessThanOrEqual(
                        256000 * 1.1,
                    );
            }
            expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(128);
        },
        20000,
    );

    it("still cuts an input whose metadata cannot be read", async () => {
        const original = await fixture("ogg", "libopus", 16000, 1, [
            "-b:a",
            "16000",
        ]);
        vi.mocked(metadata.parseFile).mockRejectedValueOnce(
            new Error("Unreadable source metadata"),
        );
        const output = await cutAudio(original, range);
        expect(output.extension).toBe("ogg");
        expect(Math.abs(output.duration - keptMs)).toBeLessThanOrEqual(20);
    });

    it("uses the measured copy bitrate even when source metadata reports another bitrate and duration", async () => {
        const original = await fixture("webm", "libopus", 16000, 1, [
            "-b:a",
            "16000",
        ]);
        const before = await metadata.parseBuffer(original);
        const actual = await vi.importActual<typeof metadata>("music-metadata");
        vi.mocked(metadata.parseFile).mockImplementation((filename, options) =>
            filename.endsWith("source")
                ? Promise.resolve({
                      ...before,
                      format: {
                          ...before.format,
                          bitrate: 1000000,
                          duration: 90000,
                      },
                  })
                : actual.parseFile(filename, options),
        );
        const output = await cutAudio(original, range);
        expectSize(
            original,
            output.audio,
            "webm/libopus incorrect source bitrate/duration",
        );
        expect(
            vi
                .mocked(metadata.parseFile)
                .mock.calls.every(([filename]) => !filename.endsWith("source")),
        ).toBe(true);
    });

    it.each([
        ["wav", "pcm_s16le"],
        ["flac", "flac"],
    ])(
        "keeps %s lossless samples unchanged",
        async (extension, encoder) => {
            const original = await fixture(extension, encoder, 16000, 1, []);
            const output = await cutAudio(original, range);
            const decode = (input: Buffer) =>
                execFileSync(
                    "ffmpeg",
                    [
                        "-nostdin",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-i",
                        "pipe:0",
                        "-c:a",
                        "pcm_s16le",
                        "-f",
                        "s16le",
                        "pipe:1",
                    ],
                    { input, maxBuffer: 2 * 1024 * 1024 },
                );
            expect(output.extension).toBe(extension);
            expect(output.duration).toBe(keptMs);
            console.info(
                `${extension}/${encoder}: ${original.length} source bytes -> ${output.audio.length} cut bytes`,
            );
            expect(
                decode(output.audio).equals(
                    decode(original).subarray(
                        range.startMs * 16 * 2,
                        range.endMs * 16 * 2,
                    ),
                ),
            ).toBe(true);
        },
        20000,
    );
});
