import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Run ffmpeg over an in-memory input and return its stdout. `outputArgs`
 * follow `-i`. The input is read from a temporary file, not a pipe, so
 * containers that need seeking (an MP4 with its index after the media)
 * decode. Rejects when ffmpeg fails or writes nothing.
 */
export async function runFfmpeg(
    input: Buffer,
    outputArgs: readonly string[],
): Promise<Buffer> {
    const directory = await mkdtemp(path.join(tmpdir(), "riffado-ffmpeg-"));
    try {
        const inputPath = path.join(directory, "input");
        await writeFile(inputPath, input);
        return await spawnFfmpeg([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            inputPath,
            ...outputArgs,
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function spawnFfmpeg(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;

        const settleReject = (err: Error) => {
            if (settled) return;
            settled = true;
            reject(err);
        };

        ff.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
        ff.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

        ff.on("error", (err) => {
            settleReject(
                new Error(
                    `ffmpeg spawn failed (binary missing from runtime image?): ${err.message}`,
                ),
            );
        });

        ff.on("close", (code) => {
            if (settled) return;
            const stderr =
                Buffer.concat(stderrChunks).toString("utf8").trim() ||
                "(no stderr)";
            if (code !== 0) {
                settleReject(
                    new Error(`ffmpeg exited with code ${code}: ${stderr}`),
                );
                return;
            }
            const output = Buffer.concat(stdoutChunks);
            if (output.length === 0) {
                settleReject(new Error(`ffmpeg produced no output: ${stderr}`));
                return;
            }
            settled = true;
            resolve(output);
        });
    });
}

export function ffmpegToOpus(
    input: Buffer,
    bitrateKbps: number,
): Promise<Buffer> {
    return runFfmpeg(input, [
        "-vn",
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-b:a",
        `${bitrateKbps}k`,
        "-application",
        "voip",
        "-f",
        "ogg",
        "pipe:1",
    ]);
}

/** Mono 16 kHz MP3 for chat-style providers that reject Ogg/Opus. */
export function transcodeToMp3(input: Buffer): Promise<Buffer> {
    return runFfmpeg(input, [
        "-vn",
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-f",
        "mp3",
        "pipe:1",
    ]);
}
