import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type IFormat, parseFile } from "music-metadata";
import { type AudioCodec, sniffAudio } from "@/lib/audio/sniff";
import type { CutRange } from "@/lib/recordings/cut-range";

const execute = promisify(execFile);

function encoderFor(extension: string, inputCodec: AudioCodec): string {
    switch (extension) {
        case "ogg":
            return inputCodec === "vorbis" ? "libvorbis" : "libopus";
        case "webm":
            return "libopus";
        case "mp3":
            return "libmp3lame";
        case "wav":
            return "pcm_s16le";
        case "flac":
            return "flac";
        default:
            return "aac";
    }
}

function positiveInteger(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.round(value))
        : undefined;
}

function bitrateBounds(
    encoder: string,
    sampleRate: number,
    channels: number,
): [number, number] | undefined {
    switch (encoder) {
        case "libopus":
            return [6000, Math.min(510000, 256000 * channels)];
        case "libmp3lame":
            return sampleRate < 32000 ? [8000, 160000] : [32000, 320000];
        case "aac":
            return [1000, 6 * sampleRate * channels];
        case "libvorbis": {
            const bands = [
                [9000, 8000, 42000, 6000, 42000],
                [15000, 12000, 50000, 8000, 50000],
                [19000, 16000, 100000, 12000, 100000],
                [26000, 16000, 90000, 15000, 90000],
                [40000, 30000, 190000, 18000, 190000],
                [50001, 32000, 240001, 22500, 250001],
            ];
            const band =
                sampleRate >= 8000
                    ? bands.find(([limit]) => sampleRate < limit)
                    : undefined;
            if (band) {
                const [, monoMin, monoMax, stereoMin, stereoMax] = band;
                return channels === 2
                    ? [stereoMin * channels, stereoMax * channels]
                    : [monoMin * channels, monoMax * channels];
            }
            return undefined;
        }
        default:
            throw new Error("Unsupported compressed audio encoder");
    }
}

function encodingOptions(
    encoder: string,
    bitrate: number | undefined,
    format?: IFormat,
): string[] {
    if (!bitrate) return [];
    const bounds = bitrateBounds(
        encoder,
        positiveInteger(format?.sampleRate) ?? 48000,
        positiveInteger(format?.numberOfChannels) ?? 1,
    );
    const target = bounds
        ? Math.min(bounds[1], Math.max(bounds[0], bitrate))
        : bitrate;
    const options = ["-b:a", String(target)];
    if (encoder === "libopus") options.push("-vbr", "constrained");
    if (encoder === "libmp3lame" && format?.codecProfile?.startsWith("V"))
        options.push("-abr", "1");
    return options;
}

function durationToleranceMs(
    extension: string,
    inputCodec: AudioCodec,
    sampleRate: number,
): number {
    const frame = (samples: number) => Math.ceil((samples / sampleRate) * 1000);
    switch (extension) {
        case "mp3":
            return frame(sampleRate < 32000 ? 576 : 1152);
        case "m4a":
        case "aac":
            return frame(1024);
        case "ogg":
            return inputCodec === "vorbis" ? frame(2048) : 20;
        case "wav":
        case "flac":
            return 1;
        default:
            return 20;
    }
}

async function durationOf(
    filename: string,
    signal?: AbortSignal,
    codec = "pcm_s16le",
): Promise<number> {
    const { stdout } = await execute(
        "ffmpeg",
        [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            filename,
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            codec,
            "-f",
            "null",
            "-progress",
            "pipe:1",
            "-nostats",
            "-",
        ],
        { signal },
    );
    const times = [...stdout.matchAll(/^out_time_us=(\d+)/gm)];
    return Math.round(Number(times.at(-1)?.[1] ?? 0) / 1000);
}

async function verifiedDuration(
    filename: string,
    expected: number,
    extension: string,
    inputCodec: AudioCodec,
    signal?: AbortSignal,
): Promise<number> {
    const duration = await durationOf(filename, signal);
    const metadata = await parseFile(filename, { skipCovers: true });
    const tolerance = durationToleranceMs(
        extension,
        inputCodec,
        metadata.format.sampleRate ?? 48000,
    );
    if (!duration || Math.abs(duration - expected) > tolerance)
        throw new Error("The cut audio duration could not be verified");
    return duration;
}

/** Trim a local file into its original container, verifying the output before publication. */
export async function cutAudioFile(
    source: string,
    directory: string,
    range: CutRange,
    signal?: AbortSignal,
) {
    const handle = await open(source, "r");
    const header = Buffer.alloc(65536);
    let bytesRead: number;
    try {
        ({ bytesRead } = await handle.read(header, 0, header.length, 0));
    } finally {
        await handle.close();
    }
    const {
        extension,
        contentType,
        codec: inputCodec,
    } = sniffAudio(header.subarray(0, bytesRead));
    const output = path.join(directory, `output.${extension}`);
    const expected = range.endMs - range.startMs;
    const base = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-ss",
        String(range.startMs / 1000),
        "-t",
        String(expected / 1000),
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
    ];
    let duration = 0;
    let copied = false;
    try {
        await execute("ffmpeg", [...base, "-c:a", "copy", output], { signal });
        copied = true;
        if (extension === "wav")
            duration = await verifiedDuration(
                output,
                expected,
                extension,
                inputCodec,
                signal,
            );
        else if (extension !== "flac")
            duration = await durationOf(output, signal, "copy");
    } catch {
        signal?.throwIfAborted();
    }
    // Compressed packets can retain private samples beyond a cut edge despite an accurate container duration.
    if (
        extension !== "wav" ||
        Math.abs(duration - expected) > 1 ||
        duration === 0
    ) {
        const encoder = encoderFor(extension, inputCodec);
        const metadata =
            extension === "wav" || extension === "flac"
                ? undefined
                : await parseFile(copied ? output : source, {
                      skipCovers: true,
                  }).catch(() => undefined);
        signal?.throwIfAborted();
        const bitrate =
            positiveInteger(metadata?.format.bitrate) ??
            (copied && duration > 0
                ? ((await stat(output)).size * 8000) / duration
                : undefined);
        const options =
            extension === "wav" || extension === "flac"
                ? []
                : encodingOptions(
                      encoder,
                      positiveInteger(bitrate),
                      metadata?.format,
                  );
        const encoding = [...base, "-c:a", encoder];
        async function encodeAndVerify(options: string[]): Promise<number> {
            await execute("ffmpeg", [...encoding, ...options, output], {
                signal,
            });
            return verifiedDuration(
                output,
                expected,
                extension,
                inputCodec,
                signal,
            );
        }
        try {
            duration = await encodeAndVerify(options);
        } catch (error) {
            signal?.throwIfAborted();
            if (options.length === 0) throw error;
            duration = await encodeAndVerify([]);
        }
    }
    return { output, duration, extension, contentType };
}

/** In-memory convenience wrapper for small audio inputs. */
export async function cutAudio(
    input: Buffer,
    range: CutRange,
    signal?: AbortSignal,
) {
    const directory = await mkdtemp(path.join(tmpdir(), "chatterbox-cut-"));
    try {
        const source = path.join(directory, "source");
        await writeFile(source, input);
        const result = await cutAudioFile(source, directory, range, signal);
        return { ...result, audio: await readFile(result.output) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
