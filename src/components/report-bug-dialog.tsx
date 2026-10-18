"use client";

import { Mail } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { Github } from "@/components/icons/icons";
import { useProductName } from "@/components/product-name-provider";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    buildReportBugBodyPreview,
    buildReportBugMailto,
    buildReportBugUrl,
} from "@/lib/report-bug";

interface ReportBugDialogProps {
    isHosted: boolean;
    /** Optional correlation id from `details.errorId` on a 5xx response. */
    errorId?: string;
    /** Optional one-line summary of what the user was doing. */
    errorContext?: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/** Renders the bug-report dialog and its pre-filled report preview. */
export function ReportBugDialog({
    isHosted,
    errorId,
    errorContext,
    open,
    onOpenChange,
}: ReportBugDialogProps) {
    const i18n = useExtracted();
    const name = useProductName();
    const page =
        typeof window !== "undefined" ? window.location.pathname : undefined;
    const opts = { isHosted, errorId, errorContext, page, name };
    const githubUrl = buildReportBugUrl(opts);
    const mailtoUrl = buildReportBugMailto(opts);
    const preview = buildReportBugBodyPreview(opts);
    let description = i18n(
        "Pick how you'd like to report this. Your version and deployment mode are pre-filled to save you typing.",
    );
    if (errorId) {
        description = i18n(
            "Something went wrong. The details below will be pre-filled — add what you were doing and we'll take a look.",
        );
    } else if (!isHosted) {
        description = i18n(
            "Report this on GitHub. The details below are filled in for you.",
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{i18n("Report a bug")}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>

                <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                        {i18n("Preview")}
                    </p>
                    <pre className="max-h-48 overflow-auto rounded-md border bg-muted/50 p-3 text-xs whitespace-pre-wrap break-words">
                        {preview}
                    </pre>
                </div>

                <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
                    {isHosted ? (
                        <Button variant="outline" asChild>
                            <a
                                href={mailtoUrl}
                                rel="noopener noreferrer"
                                onClick={() => onOpenChange(false)}
                            >
                                <Mail className="size-4" /> {i18n("Email us")}
                            </a>
                        </Button>
                    ) : null}
                    <Button asChild>
                        <a
                            href={githubUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => onOpenChange(false)}
                        >
                            <Github className="size-4" />{" "}
                            {i18n("Report on GitHub")}
                        </a>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

interface ReportBugButtonProps {
    isHosted: boolean;
    /** Optional className for the trigger \u2014 lets the footer style it inline. */
    className?: string;
}

/**
 * Footer trigger for the bug-report dialog. Kept as a thin wrapper so the
 * server-rendered footer can mount it without itself becoming a client
 * component beyond this leaf.
 *
 * The button is reset to look like the surrounding inline `<Link>` siblings
 * (no border, no padding, no background, inherited font) so it doesn't get
 * the browser-default button chrome.
 */
const RESET_BUTTON_CLASSES =
    "appearance-none border-0 bg-transparent p-0 m-0 font-inherit text-inherit cursor-pointer";

export function ReportBugButton({ isHosted, className }: ReportBugButtonProps) {
    const i18n = useExtracted();
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={`${RESET_BUTTON_CLASSES} ${className ?? ""}`}
            >
                {i18n("Report a bug")}
            </button>
            <ReportBugDialog
                isHosted={isHosted}
                open={open}
                onOpenChange={setOpen}
            />
        </>
    );
}
