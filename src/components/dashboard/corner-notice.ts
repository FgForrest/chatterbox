import type { ReactElement } from "react";
import { toast } from "sonner";

/** What the dashboard's one corner notice can announce. */
export type CornerNoticeKind = "arrival" | "invitation";

const NOTICE_ID = "new-item";
const notices: Record<CornerNoticeKind, (() => ReactElement) | null> = {
    arrival: null,
    invitation: null,
};

function render() {
    const content = notices.invitation ?? notices.arrival;
    if (!content) {
        toast.dismiss(NOTICE_ID);
        return;
    }
    toast.custom(content, {
        id: NOTICE_ID,
        duration: Infinity,
        dismissible: false,
        className: "w-[var(--width)]",
    });
}

/**
 * Show a notice in the dashboard's one corner slot. An invitation waits for
 * an answer, so an arrival waits behind it and shows once it is closed.
 */
export function showCornerNotice(
    kind: CornerNoticeKind,
    content: () => ReactElement,
): void {
    notices[kind] = content;
    render();
}

/** Close one kind of corner notice; the other, if waiting, takes the slot. */
export function closeCornerNotice(kind: CornerNoticeKind): void {
    if (!notices[kind]) return;
    notices[kind] = null;
    render();
}
