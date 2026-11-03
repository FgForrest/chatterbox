"use client";

import { Cpu, Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useRecordingCut } from "@/components/recordings/recording-cut";
import { Button } from "@/components/ui/button";
import { transcribeInBrowser } from "@/lib/transcription/browser-transcriber";
import type { TranscriptionModel } from "@/types/transcription";

interface Props {
    recordingId: string;
    /** Disabled while another action is running. */
    disabled?: boolean;
    /** Called after a successful POST so the parent can refresh data. */
    onComplete: () => void;
    /** Defaults to `"whisper-base"` (~75MB download, multilingual). */
    model?: TranscriptionModel;
}

type Phase =
    | "idle"
    | "downloading-audio"
    | "decoding-audio"
    | "loading-model"
    | "transcribing";

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
    "downloading-audio": "Downloading audio…",
    "decoding-audio": "Decoding audio…",
    "loading-model": "Loading Whisper (one-time download)…",
    transcribing: "Transcribing locally…",
};

/**
 * Run Whisper in the browser via Transformers.js, then POST the result
 * to `/api/recordings/[id]/transcription/from-browser`. No API key
 * needed; audio never leaves the user's machine.
 *
 * The Whisper model is fetched from the Hugging Face CDN on first use
 * (~75MB for whisper-base) and cached by the browser, so subsequent
 * transcriptions are instant-start. Cancellation is best-effort: if the
 * user closes the tab mid-transcribe the worker is terminated by the
 * browser.
 */
export function TranscribeInBrowserButton({
    recordingId,
    disabled,
    onComplete,
    model = "whisper-base",
}: Props) {
    const i18n = useExtracted();
    const cut = useRecordingCut();
    const setBrowserTranscribing = cut?.setBrowserTranscribing;
    const [phase, setPhase] = useState<Phase>("idle");

    const run = useCallback(async () => {
        try {
            setBrowserTranscribing?.(true);
            setPhase("downloading-audio");
            const audioRes = await fetch(
                `/api/recordings/${recordingId}/audio`,
                { cache: "no-store" },
            );
            if (!audioRes.ok) {
                throw new Error(`Failed to fetch audio (${audioRes.status})`);
            }
            const blob = await audioRes.blob();
            const file = new File([blob], `recording-${recordingId}`, {
                type: blob.type || "audio/mpeg",
            });

            setPhase("decoding-audio");
            const result = await transcribeInBrowser(file, model, (status) => {
                if (status === "decoding-audio") setPhase("decoding-audio");
                if (status === "loading-model") setPhase("loading-model");
                if (status === "transcribing") setPhase("transcribing");
            });

            const postRes = await fetch(
                `/api/recordings/${recordingId}/transcription/from-browser`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        text: result.text,
                        detectedLanguage: result.detectedLanguage,
                        model,
                        audioMd5:
                            audioRes.headers?.get("X-Audio-Md5") ?? undefined,
                        audioCutAt:
                            audioRes.headers?.get("X-Recording-Cut-At") || null,
                    }),
                },
            );
            if (!postRes.ok) {
                const err = (await postRes.json().catch(() => ({}))) as {
                    error?: string;
                };
                throw new Error(
                    postRes.status === 409
                        ? i18n(
                              "The recording audio changed. Transcribe it again.",
                          )
                        : (err.error ?? "Failed to save transcription"),
                );
            }

            toast.success(i18n("Transcribed in browser"));
            onComplete();
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : i18n("Browser transcription failed"),
            );
        } finally {
            setPhase("idle");
            setBrowserTranscribing?.(false);
        }
    }, [recordingId, model, onComplete, i18n, setBrowserTranscribing]);

    const busy = phase !== "idle";

    return (
        <Button
            onClick={run}
            size="sm"
            variant="outline"
            disabled={disabled || busy || cut?.cutting}
            title={i18n(
                "Run Whisper in your browser. No API key required; audio never leaves your machine.",
            )}
        >
            {busy ? (
                <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    {PHASE_LABEL[phase as Exclude<Phase, "idle">]}
                </>
            ) : (
                <>
                    <Cpu className="size-4 mr-2" />{" "}
                    {i18n("Transcribe in browser")}
                </>
            )}
        </Button>
    );
}
