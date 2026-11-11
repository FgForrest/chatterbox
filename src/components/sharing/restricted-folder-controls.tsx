"use client";

import { FolderLock, LockOpen } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionTooltip } from "@/components/ui/tooltip";
import type { RecordingFolder } from "@/types/folder";
import { FolderRestrictionDialog } from "./folder-restriction-dialog";
import { RestrictedAudienceDialog } from "./restricted-audience-dialog";
import { useRestrictedFolders } from "./restricted-folder-context";

/** Compact header entry points into the same dialogs used by the tree. */
export function RestrictedFolderControls({
    folder,
    folders,
    canCurate,
}: {
    folder: RecordingFolder;
    folders: RecordingFolder[];
    canCurate: boolean;
}) {
    const i18n = useExtracted();
    const { writable } = useRestrictedFolders();
    const [action, setAction] = useState<
        "audience" | "restrict" | "lift" | null
    >(null);
    if (
        folder.scope !== "org" ||
        folder.kind !== "custom" ||
        folder.access === false
    )
        return null;
    const restricted = folder.restricted || folder.restricting;
    const canLift =
        writable &&
        folder.restricted &&
        (canCurate ||
            folder.restrictedRole === "manager" ||
            folder.restrictedRole === "curator");
    return (
        <>
            {restricted && (folder.restricted || folder.restrictedRole) && (
                <ActionTooltip label={i18n("Who can see it…")}>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={i18n("Who can see it…")}
                        onClick={() => setAction("audience")}
                    >
                        <FolderLock className="size-4 text-restricted" />
                    </Button>
                </ActionTooltip>
            )}
            {canLift && (
                <ActionTooltip label={i18n("Open to the whole Organization…")}>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={i18n("Open to the whole Organization…")}
                        onClick={() => setAction("lift")}
                    >
                        <LockOpen className="size-4" />
                    </Button>
                </ActionTooltip>
            )}
            {writable && canCurate && !folder.restricted && (
                <ActionTooltip
                    label={
                        folder.restricting
                            ? i18n("Retry restriction…")
                            : i18n("Restrict…")
                    }
                >
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={
                            folder.restricting
                                ? i18n("Retry restriction…")
                                : i18n("Restrict…")
                        }
                        onClick={() => setAction("restrict")}
                    >
                        <FolderLock className="size-4" />
                    </Button>
                </ActionTooltip>
            )}
            {action === "audience" && (
                <RestrictedAudienceDialog
                    folder={folder}
                    onOpenChange={(open) => {
                        if (!open) setAction(null);
                    }}
                />
            )}
            {action && action !== "audience" && (
                <FolderRestrictionDialog
                    folder={folder}
                    folders={folders}
                    action={action}
                    onOpenChange={(open) => {
                        if (!open) setAction(null);
                    }}
                />
            )}
        </>
    );
}
