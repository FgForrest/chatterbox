"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
    PendingUpload,
    PendingUploadPhase,
} from "@/components/dashboard/pending-upload-row";
import { followJob, type JobProgressSnapshot } from "@/lib/jobs/client";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";
import {
    formatUploadLimit,
    isSupportedUpload,
    shouldExtractVideo,
} from "@/lib/uploads/media-types";

interface UploadStarted {
    uploadId: string;
    filename: string;
}

/** Identifies an upload after its recording has been saved. */
export interface UploadCompletion extends UploadStarted {
    recordingId: string;
    resumed: boolean;
}

/** Optional action attached to the queue's upload-success toast. */
export interface UploadCompletionAction {
    label: string;
    onClick: () => void;
}

interface Options {
    onUploadStarted?: (upload: UploadStarted) => void;
    onUploadFailed?: (uploadId: string) => void;
    onUploadComplete: (
        upload: UploadCompletion,
    ) => UploadCompletionAction | undefined;
}

/**
 * Media upload queue: transfer progress, optimistic rows, and durable video
 * conversion tracking. Active conversions are recovered after a page reload.
 *
 * The input is wired by attaching `uploadInputRef` to a hidden input
 * and calling `triggerUpload()` from a visible button. The hook also
 * resets `e.target.value` after pickup so picking the same file twice
 * in a row still fires a `change` event.
 */
export function useUploadQueue({
    onUploadStarted,
    onUploadFailed,
    onUploadComplete,
}: Options) {
    const [isUploading, setIsUploading] = useState(false);
    const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const followers = useRef<Map<string, AbortController>>(new Map());
    // Known once the active-uploads request answers; until then the server
    // is the only judge of size.
    const limits = useRef<UploadLimits | null>(null);

    const updatePending = useCallback(
        (id: string, update: Partial<PendingUpload>) => {
            setPendingUploads((previous) =>
                previous.map((upload) =>
                    upload.id === id ? { ...upload, ...update } : upload,
                ),
            );
        },
        [],
    );

    const completeUpload = useCallback(
        (upload: UploadCompletion, message: string) => {
            invalidateItemProcessing(upload.recordingId);
            const action = onUploadComplete(upload);
            toast.success(
                message,
                action === undefined ? undefined : { action },
            );
        },
        [onUploadComplete],
    );

    const failUpload = useCallback(
        (uploadId: string, message: string) => {
            toast.error(message);
            onUploadFailed?.(uploadId);
            setPendingUploads((previous) =>
                previous.filter((upload) => upload.id !== uploadId),
            );
        },
        [onUploadFailed],
    );

    const watchConversion = useCallback(
        (
            jobId: string,
            placeholderId: string,
            filename: string,
            savedFilename: string,
            resumed: boolean,
        ) => {
            if (followers.current.has(jobId)) return;
            const controller = new AbortController();
            followers.current.set(jobId, controller);

            void followJob(jobId, {
                signal: controller.signal,
                onProgress: (progress) => {
                    updatePending(placeholderId, pendingFromProgress(progress));
                },
            })
                .then((job) => {
                    if (controller.signal.aborted) return;
                    if (job?.status === "completed") {
                        completeUpload(
                            {
                                recordingId: recordingIdFromResult(job.result),
                                uploadId: placeholderId,
                                filename: savedFilename,
                                resumed,
                            },
                            `Audio from "${filename}" is ready`,
                        );
                    } else {
                        failUpload(
                            placeholderId,
                            job?.error ||
                                `Could not finish converting "${filename}"`,
                        );
                    }
                    if (job?.status === "completed") {
                        setPendingUploads((previous) =>
                            previous.filter(
                                (upload) => upload.id !== placeholderId,
                            ),
                        );
                    }
                })
                .catch((error: unknown) => {
                    if (controller.signal.aborted) return;
                    failUpload(
                        placeholderId,
                        error instanceof Error
                            ? error.message
                            : `Could not finish converting "${filename}"`,
                    );
                })
                .finally(() => {
                    followers.current.delete(jobId);
                });
        },
        [completeUpload, failUpload, updatePending],
    );

    useEffect(() => {
        const controller = new AbortController();
        void fetch("/api/recordings/upload", { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) return;
                const body = (await response.json()) as ActiveUploadsResponse;
                if (
                    typeof body.limits?.audioMaxBytes === "number" &&
                    typeof body.limits.videoMaxBytes === "number"
                ) {
                    limits.current = body.limits;
                }
                if (!Array.isArray(body.uploads)) return;

                for (const upload of body.uploads) {
                    if (
                        typeof upload.jobId !== "string" ||
                        typeof upload.filename !== "string" ||
                        typeof upload.filesize !== "number"
                    ) {
                        continue;
                    }
                    const placeholderId = `conversion:${upload.jobId}`;
                    const progress = pendingFromProgress(upload.progress);
                    setPendingUploads((previous) =>
                        previous.some((item) => item.id === placeholderId)
                            ? previous
                            : [
                                  ...previous,
                                  {
                                      id: placeholderId,
                                      filename: upload.filename,
                                      filesize: upload.filesize,
                                      ...progress,
                                  },
                              ],
                    );
                    onUploadStarted?.({
                        uploadId: placeholderId,
                        filename: uploadBasename(upload.filename),
                    });
                    watchConversion(
                        upload.jobId,
                        placeholderId,
                        upload.filename,
                        uploadBasename(upload.filename),
                        true,
                    );
                }
            })
            .catch(() => {});

        return () => {
            controller.abort();
            for (const follower of followers.current.values()) {
                follower.abort();
            }
            followers.current.clear();
        };
    }, [onUploadStarted, watchConversion]);

    const handleUpload = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;
            // Reset so picking the same file twice still fires change.
            e.target.value = "";

            const sizeError = uploadSizeError(file, limits.current);
            if (sizeError) {
                toast.error(sizeError);
                return;
            }
            // The server refuses this too, but only once the request
            // arrives, and a browser mid-way through sending gigabytes may
            // report that as a bare network error.
            if (
                followers.current.size > 0 &&
                shouldExtractVideo(file.name, file.type)
            ) {
                toast.error(
                    "Another video is already being converted. Try this upload again when it finishes.",
                );
                return;
            }

            setSelectedFile(file);
        },
        [],
    );

    const confirmUpload = useCallback(
        async (folderId: string | null) => {
            const file = selectedFile;
            if (!file) return;
            setSelectedFile(null);

            // Optimistic placeholder in the list. Uses a `pending:`
            // prefixed id namespace so the row can't collide with a
            // server-issued recording id.
            const placeholderId = `pending:${Date.now()}:${Math.random()
                .toString(36)
                .slice(2)}`;
            setPendingUploads((prev) => [
                ...prev,
                {
                    id: placeholderId,
                    filename: file.name,
                    filesize: file.size,
                    phase: "uploading",
                    progress: 0,
                },
            ]);
            onUploadStarted?.({
                uploadId: placeholderId,
                filename: uploadBasename(file.name),
            });

            setIsUploading(true);
            let conversionStarted = false;
            try {
                const data = await sendUpload(file, folderId, (progress) => {
                    updatePending(placeholderId, { progress });
                });

                if (data.conversion) {
                    conversionStarted = true;
                    updatePending(placeholderId, {
                        phase: "queued",
                        progress: null,
                    });
                    toast.success(
                        `"${file.name}" uploaded. Extracting audio in the background.`,
                    );
                    watchConversion(
                        data.jobId,
                        placeholderId,
                        file.name,
                        data.filename,
                        false,
                    );
                } else {
                    completeUpload(
                        {
                            recordingId: data.recordingId,
                            uploadId: placeholderId,
                            filename: data.filename,
                            resumed: false,
                        },
                        `"${data.filename}" uploaded`,
                    );
                }
            } catch (error) {
                failUpload(
                    placeholderId,
                    error instanceof Error
                        ? error.message
                        : "Failed to upload recording",
                );
            } finally {
                setIsUploading(false);
                if (!conversionStarted) {
                    setPendingUploads((prev) =>
                        prev.filter((p) => p.id !== placeholderId),
                    );
                }
            }
        },
        [
            onUploadStarted,
            selectedFile,
            completeUpload,
            failUpload,
            updatePending,
            watchConversion,
        ],
    );

    const cancelUpload = useCallback(() => setSelectedFile(null), []);

    const triggerUpload = useCallback(() => {
        uploadInputRef.current?.click();
    }, []);

    return {
        isUploading,
        pendingUploads,
        uploadInputRef,
        handleUpload,
        selectedFile,
        confirmUpload,
        cancelUpload,
        triggerUpload,
    };
}

interface DirectUploadResponse {
    filename: string;
    recordingId: string;
    conversion?: false;
}

interface ConversionUploadResponse {
    filename: string;
    conversion: true;
    jobId: string;
}

type UploadResponse = DirectUploadResponse | ConversionUploadResponse;

interface ActiveUpload {
    jobId: string;
    filename: string;
    filesize: number;
    progress: JobProgressSnapshot | null;
}

interface UploadLimits {
    audioMaxBytes: number;
    videoMaxBytes: number;
}

interface ActiveUploadsResponse {
    uploads?: ActiveUpload[];
    limits?: UploadLimits;
}

/** Refuse an oversized file before sending it rather than after. */
function uploadSizeError(
    file: File,
    limits: UploadLimits | null,
): string | null {
    if (!limits || !isSupportedUpload(file.name, file.type)) return null;
    const maxBytes = shouldExtractVideo(file.name, file.type)
        ? limits.videoMaxBytes
        : limits.audioMaxBytes;
    if (file.size <= maxBytes) return null;
    return `"${file.name}" exceeds the ${formatUploadLimit(maxBytes)} size limit`;
}

function pendingFromProgress(
    progress: JobProgressSnapshot | null,
): Pick<PendingUpload, "phase" | "progress"> {
    const knownPhases: PendingUploadPhase[] = [
        "preparing",
        "extracting",
        "saving",
    ];
    const phase = knownPhases.includes(progress?.phase as PendingUploadPhase)
        ? (progress?.phase as PendingUploadPhase)
        : "queued";
    const percent =
        typeof progress?.completed === "number" &&
        typeof progress.total === "number" &&
        progress.total > 0
            ? Math.round((progress.completed / progress.total) * 100)
            : null;
    return { phase, progress: percent };
}

function recordingIdFromResult(result: Record<string, unknown> | null): string {
    if (typeof result?.recordingId === "string") return result.recordingId;
    throw new Error("Video conversion completed without a recording id");
}

function uploadBasename(filename: string): string {
    return filename.replace(/\.[^./]+$/, "");
}

/**
 * The file goes as the raw request body so the server can stream it to
 * storage; a multipart form would have to be held in memory whole.
 */
function sendUpload(
    file: File,
    folderId: string | null,
    onProgress: (progress: number) => void,
): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/recordings/upload");
        request.setRequestHeader(
            "X-Upload-Filename",
            encodeURIComponent(file.name),
        );
        request.setRequestHeader("X-Upload-Size", String(file.size));
        if (folderId) request.setRequestHeader("X-Upload-Folder-Id", folderId);
        request.upload.addEventListener("progress", (event) => {
            if (!event.lengthComputable || event.total <= 0) return;
            onProgress(
                Math.min(100, Math.round((event.loaded / event.total) * 100)),
            );
        });
        request.addEventListener("load", () => {
            let body: {
                error?: string;
                filename?: string;
                recordingId?: string;
                conversion?: boolean;
                jobId?: string;
            } = {};
            try {
                body = JSON.parse(request.responseText) as typeof body;
            } catch {
                body = {};
            }
            if (
                request.status >= 200 &&
                request.status < 300 &&
                typeof body.filename === "string"
            ) {
                if (
                    body.conversion === true &&
                    typeof body.jobId === "string"
                ) {
                    resolve({
                        filename: body.filename,
                        conversion: true,
                        jobId: body.jobId,
                    });
                    return;
                }
                if (typeof body.recordingId === "string") {
                    resolve({
                        filename: body.filename,
                        recordingId: body.recordingId,
                    });
                    return;
                }
                reject(new Error("Upload completed without a recording id"));
                return;
            }
            reject(new Error(body.error || "Upload failed"));
        });
        request.addEventListener("error", () => {
            reject(new Error("Failed to upload recording"));
        });
        // The browser sets Content-Type from file.type.
        request.send(file);
    });
}
