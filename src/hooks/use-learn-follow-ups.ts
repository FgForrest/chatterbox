"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How often the follow-ups are checked while something is pending. */
const POLL_MS = 2_500;
/** Past the slowest summary; what is still running then finishes unseen. */
const POLL_LIMIT_MS = 15 * 60 * 1000;
/**
 * Checks a finished review waits for its release to queue anything: the
 * hold outlives it while another run on the recording is still open.
 */
const RELEASE_WAIT_CHECKS = 6;

interface FollowUps {
    held: boolean;
    pending: string[];
}

/**
 * What automatic Learn held back on the owner's private view: whether the
 * title, summary and topics still wait for the review (`held`), and, once
 * `follow()` is called (the review was finished) or the page opens with
 * any of them queued, the jobs that make them, polled until none is left.
 * `onChange` runs whenever that set of jobs changes, so the page can pick
 * up jobs just queued and read back what one just made.
 */
export function useLearnFollowUps({
    recordingId,
    enabled,
    onChange,
}: {
    recordingId: string;
    enabled: boolean;
    onChange: () => void;
}): { held: boolean; follow: () => void } {
    const [held, setHeld] = useState(false);
    const [following, setFollowing] = useState(0);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        if (!enabled) {
            setHeld(false);
            return;
        }
        // A follow started by a finished review, rather than the page opening.
        const afterReview = following > 0;
        const controller = new AbortController();
        const startedAt = Date.now();
        // After a review, the first answer is news too: what it queued.
        let previous: string | null = afterReview ? "\u0000" : null;
        let idleChecks = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const check = async () => {
            let state: FollowUps | null = null;
            try {
                const response = await fetch(
                    `/api/recordings/${recordingId}/follow-ups`,
                    { signal: controller.signal },
                );
                if (response.ok) {
                    const body = (await response.json()) as Partial<FollowUps>;
                    if (
                        typeof body?.held === "boolean" &&
                        Array.isArray(body.pending)
                    ) {
                        state = { held: body.held, pending: body.pending };
                    }
                }
            } catch {
                // A blip: the next check tries again.
            }
            if (controller.signal.aborted) return;
            if (state) {
                setHeld(state.held);
                const current = state.pending.join(",");
                if (previous !== null && current !== previous) {
                    onChangeRef.current();
                }
                previous = current;
                // Nothing queued, and either nothing waits or it waits for
                // a review not finished yet: nothing to follow.
                if (state.pending.length === 0) {
                    if (!state.held || !afterReview) return;
                    if (++idleChecks >= RELEASE_WAIT_CHECKS) return;
                }
            }
            if (Date.now() - startedAt > POLL_LIMIT_MS) return;
            timer = setTimeout(check, POLL_MS);
        };
        void check();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [recordingId, enabled, following]);

    const follow = useCallback(() => setFollowing((count) => count + 1), []);
    return { held, follow };
}
