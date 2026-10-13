import { spawn } from "node:child_process";
import { runFfmpeg } from "@/lib/transcription/ffmpeg";

const WAVEFORM_SAMPLE_RATE = 1_000;

/** Build normalized waveform buckets from signed 16-bit mono PCM. */
export function pcm16Peaks(pcm: Buffer, buckets: number): number[] {
    if (buckets < 1) throw new Error("buckets must be positive");

    const sampleCount = Math.floor(pcm.length / 2);
    if (sampleCount === 0) throw new Error("Decoded audio contains no samples");

    const peaks = new Array<number>(buckets).fill(0);
    let maxPeak = 0;

    for (let bucket = 0; bucket < buckets; bucket++) {
        const start = Math.floor((bucket * sampleCount) / buckets);
        const end = Math.max(
            start + 1,
            Math.floor(((bucket + 1) * sampleCount) / buckets),
        );
        let peak = 0;

        for (
            let sample = start;
            sample < Math.min(end, sampleCount);
            sample++
        ) {
            const value = Math.abs(pcm.readInt16LE(sample * 2));
            if (value > peak) peak = value;
        }

        peaks[bucket] = peak;
        if (peak > maxPeak) maxPeak = peak;
    }

    if (maxPeak === 0) return peaks;
    return peaks.map((peak) => Math.round((peak / maxPeak) * 1_000) / 1_000);
}

/** Decode any FFmpeg-supported audio container into a compact waveform. */
export async function generateServerWaveform(
    input: Buffer,
    buckets: number,
): Promise<number[]> {
    const pcm = await runFfmpeg(input, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(WAVEFORM_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    return pcm16Peaks(pcm, buckets);
}

/** Decode a file through a stream and retain only the requested peak buckets. */
export async function generateFileWaveform(
    filePath: string,
    durationMs: number,
    buckets: number,
): Promise<number[] | null> {
    const child = spawn("ffmpeg", [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        filePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(WAVEFORM_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    const finished = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part: string) => {
        stderr = (stderr + part).slice(-500);
    });
    const peaks = new Array<number>(buckets).fill(0);
    const expectedSamples = Math.max(
        1,
        (durationMs * WAVEFORM_SAMPLE_RATE) / 1000,
    );
    let sampleIndex = 0;
    let leftover: number | null = null;
    for await (const part of child.stdout) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        let offset = 0;
        if (leftover !== null && bytes.length > 0) {
            const unsigned = (bytes[0] << 8) | leftover;
            const value = Math.abs(
                unsigned > 32767 ? unsigned - 65536 : unsigned,
            );
            const bucket = Math.min(
                buckets - 1,
                Math.floor((sampleIndex / expectedSamples) * buckets),
            );
            peaks[bucket] = Math.max(peaks[bucket], value);
            sampleIndex++;
            leftover = null;
            offset = 1;
        }
        for (; offset + 1 < bytes.length; offset += 2) {
            const value = Math.abs(bytes.readInt16LE(offset));
            const bucket = Math.min(
                buckets - 1,
                Math.floor((sampleIndex / expectedSamples) * buckets),
            );
            peaks[bucket] = Math.max(peaks[bucket], value);
            sampleIndex++;
        }
        if (offset < bytes.length) leftover = bytes[offset];
    }
    if ((await finished) !== 0 || sampleIndex === 0) {
        console.warn("Waveform generation failed:", stderr);
        return null;
    }
    const max = Math.max(...peaks);
    return max
        ? peaks.map((value) => Math.round((value / max) * 1_000) / 1_000)
        : peaks;
}
