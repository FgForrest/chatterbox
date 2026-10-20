"use client";

import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { type RefObject, useCallback, useEffect, useRef } from "react";
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
export function AppUploadButton({
    buttonRef,
}: {
    buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
    const i18n = useExtracted();
    const { push } = useRouter();
    const mountedRef = useRef(false);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    const handleUploadComplete = useCallback(
        ({ recordingId, resumed }: UploadCompletion) => {
            const href = `/dashboard?recording=${encodeURIComponent(recordingId)}`;
            if (!mountedRef.current || resumed) {
                return {
                    label: i18n("Open"),
                    onClick: () => push(href),
                };
            }
            push(href);
        },
        [i18n, push],
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
                            ref={buttonRef}
                            type="button"
                            onClick={triggerUpload}
                            disabled={isProcessing}
                            variant="outline"
                            size="sm"
                            className="h-9 px-2 sm:px-3"
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
