"use client";

import { useExtracted } from "next-intl";
import { toast } from "sonner";
import { TaskRequestError } from "@/components/tasks/task-api";

function localizedMergeRule(
    message: string,
    copy: {
        visible: string;
        open: string;
        organization: string;
        curator: string;
        ownerOrCurator: string;
        owner: string;
        shareFirst: string;
    },
): string {
    switch (message) {
        case "Merge rule: both tasks must be visible to the person merging":
            return copy.visible;
        case "Merge rule: the target must be an open task":
            return copy.open;
        case "Merge rule: an Organization task can be merged only into an Organization task":
            return copy.organization;
        case "Merge rule: merging someone else's task into your own requires a curator":
            return copy.curator;
        case "Merge rule: only the home owner or a curator may merge that owner's tasks":
            return copy.ownerOrCurator;
        case "Merge rule: only the merged task's home owner may attach it to someone else's task":
            return copy.owner;
        case "Merge rule: a private task can join an Organization task only after its home item is shared":
            return copy.shareFirst;
        default:
            return message;
    }
}

interface MergeFailureCopy {
    visible: string;
    open: string;
    organization: string;
    curator: string;
    ownerOrCurator: string;
    owner: string;
    shareFirst: string;
    fallback: string;
}

/** Shows the server's merge refusal in the Tasks UI. */
export function showTaskMergeFailure(
    error: unknown,
    copy: MergeFailureCopy,
): void {
    if (error instanceof TaskRequestError && error.status === 403) {
        toast.error(localizedMergeRule(error.message, copy));
        return;
    }
    toast.error(
        error instanceof Error && error.message ? error.message : copy.fallback,
    );
}

/** Share localized merge refusals across task views. */
export function useTaskMergeFailure() {
    const i18n = useExtracted();
    return (error: unknown) => {
        showTaskMergeFailure(error, {
            visible: i18n("Merge rule: you must be able to see both tasks."),
            open: i18n("Merge rule: the target must be an open task."),
            organization: i18n(
                "Merge rule: an Organization task can only join another Organization task.",
            ),
            curator: i18n(
                "Merge rule: a curator must merge someone else's task into yours.",
            ),
            ownerOrCurator: i18n(
                "Merge rule: only the task's home owner or a curator may merge it.",
            ),
            owner: i18n(
                "Merge rule: only the merged task's home owner may attach it to someone else's task.",
            ),
            shareFirst: i18n(
                "Merge rule: share the private task's home item before merging it into an Organization task.",
            ),
            fallback: i18n("Could not merge the tasks"),
        });
    };
}
