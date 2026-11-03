import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
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
            "pcm_s16le",
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
    try {
        await execute("ffmpeg", [...base, "-c:a", "copy", output], { signal });
        if (extension === "wav") duration = await durationOf(output, signal);
    } catch {
        signal?.throwIfAborted();
    }
    // Compressed packets can retain private samples beyond a cut edge despite an accurate container duration.
    if (
        extension !== "wav" ||
        Math.abs(duration - expected) > 1 ||
        duration === 0
    ) {
        await execute(
            "ffmpeg",
            [...base, "-c:a", encoderFor(extension, inputCodec), output],
            { signal },
        );
        duration = await durationOf(output, signal);
    }
    const metadata = await parseFile(output, { duration: true });
    const tolerance = durationToleranceMs(
        extension,
        inputCodec,
        metadata.format.sampleRate ?? 48000,
    );
    if (!duration || Math.abs(duration - expected) > tolerance)
        throw new Error("The cut audio duration could not be verified");
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
