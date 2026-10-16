"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useCallback, useRef } from "react";
import { UploadDialog } from "@/components/dashboard/upload-dialog";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    type UploadCompletion,
    useUploadQueue,
} from "@/hooks/use-upload-queue";

/** Upload action for application pages outside the dashboard. */
export function AppUploadButton() {
    const i18n = useExtracted();
    const { push } = useRouter();
    const completionSequenceRef = useRef(0);
    const handleUploadComplete = useCallback(
        async ({ recordingId, filename }: UploadCompletion) => {
            const completionSequence = completionSequenceRef.current + 1;
            completionSequenceRef.current = completionSequence;
            let selectedId = recordingId;
            if (!selectedId) {
                const response = await fetch("/api/recordings").catch(
                    () => null,
                );
                if (response?.ok) {
                    const body = (await response.json()) as {
                        recordings?: { id: string; filename: string }[];
                    };
                    selectedId =
                        body.recordings?.find(
                            (recording) => recording.filename === filename,
                        )?.id ?? null;
                }
            }
            if (completionSequence !== completionSequenceRef.current) return;
            push(
                selectedId
                    ? `/dashboard?recording=${encodeURIComponent(selectedId)}`
                    : "/dashboard",
            );
        },
        [push],
    );
    const {
        isUploading,
        pendingUploads,
        uploadInputRef,
        handleUpload,
        selectedFile,
        confirmUpload,
        cancelUpload,
        triggerUpload,
    } = useUploadQueue({ onUploadComplete: handleUploadComplete });
    const isProcessing = isUploading || pendingUploads.length > 0;

    return (
        <>
            <input
                ref={uploadInputRef}
                type="file"
                accept="audio/*,video/*,.mkv,.avi,.wmv,.m4v,.3gp,.ogv"
                className="hidden"
                onChange={handleUpload}
            />
            <TooltipProvider delayDuration={200}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            onClick={triggerUpload}
                            disabled={isProcessing}
                            variant="outline"
                            size="sm"
                            className="h-9"
                            aria-label={
                                isProcessing
                                    ? i18n("Uploading")
                                    : i18n("Upload")
                            }
                        >
                            <Upload className="size-4 sm:mr-2" />
                            <span className="hidden sm:inline">
                                {isProcessing
                                    ? i18n("Uploading…")
                                    : i18n("Upload")}
                            </span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        {i18n(
                            "Upload an audio or video file from your computer",
                        )}
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
            <UploadDialog
                file={selectedFile}
                folders={[]}
                folderParents={[]}
                open={selectedFile !== null}
                onOpenChange={(open) => {
                    if (!open) cancelUpload();
                }}
                onUpload={(folderId) => void confirmUpload(folderId)}
                selectedFolderId={null}
            />
        </>
    );
}
