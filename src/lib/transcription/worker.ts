/// <reference lib="webworker" />

import {
    type AutomaticSpeechRecognitionPipeline,
    pipeline,
} from "@huggingface/transformers";

const pipelines = new Map<string, AutomaticSpeechRecognitionPipeline>();

async function getTranscriber(
    model: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
    const cached = pipelines.get(model);
    if (cached) {
        return cached;
    }

    const pipe = await pipeline("automatic-speech-recognition", model, {
        revision: "main",
        device: "wasm",
        dtype: "q8",
        progress_callback: (data) => {
            if (data.status === "progress") {
                self.postMessage({
                    type: "progress",
                    status: "loading-model",
                });
            }
        },
    });
    pipelines.set(model, pipe);
    return pipe;
}

self.addEventListener("message", async (event: MessageEvent) => {
    const { type, samples, model } = event.data ?? {};

    if (type !== "transcribe") {
        return;
    }

    try {
        const pipe = await getTranscriber(model);

        self.postMessage({ type: "progress", status: "transcribing" });

        const result = await pipe(samples as Float32Array, {
            return_timestamps: false,
            chunk_length_s: 30,
            stride_length_s: 5,
        });

        self.postMessage({
            type: "complete",
            text: result.text,
            detectedLanguage: null,
        });
    } catch (error) {
        self.postMessage({
            type: "error",
            error:
                error instanceof Error ? error.message : "Transcription failed",
        });
    }
});

self.postMessage({ type: "ready" });
