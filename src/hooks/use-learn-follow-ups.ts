"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How often the follow-ups are checked while something is pending. */
const POLL_MS = 2_500;
/** Past the slowest summary; what is still running then finishes unseen. */
const POLL_LIMIT_MS = 15 * 60 * 1000;
/**
 * How often a hold with nothing queued is checked: it can be released
 * without this page (a run that found nothing, another tab, its expiry).
 */
const HELD_POLL_MS = 30_000;
/**
 * Checks a finished review waits at the quick pace for its release to
 * queue anything, before the hold is only checked now and then.
 */
const RELEASE_WAIT_CHECKS = 6;

interface FollowUps {
    held: boolean;
    pending: string[];
}

/** The correction pass's job kind (`correction-pass-queue.ts`). */
const CORRECTION_JOB_KIND = "learn.correct";

/**
 * What automatic Learn held back on the owner's private view: whether the
 * title, summary and topics still wait for the review (`held`), whether
 * the correction pass is reading the transcript again (`correcting`), and
 * the jobs that make them, polled until none is left. A hold is checked now
 * and then, and quickly once `follow()` is called (the review was
 * finished). `onChange` runs whenever that set of jobs changes or the hold
 * is released, so the page can pick up jobs just queued and read back what
 * one just made.
 */
export function useLearnFollowUps({
    recordingId,
    enabled,
    onChange,
}: {
    recordingId: string;
    enabled: boolean;
    onChange: () => void;
}): { held: boolean; correcting: boolean; follow: () => void } {
    const [held, setHeld] = useState(false);
    const [correcting, setCorrecting] = useState(false);
    const [following, setFollowing] = useState(0);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        if (!enabled) {
            setHeld(false);
            setCorrecting(false);
            return;
        }
        // A follow started by a finished review, rather than the page opening.
        const afterReview = following > 0;
        const controller = new AbortController();
        // When the jobs now followed were first seen, for the poll limit.
        let activeSince: number | null = null;
        // After a review, the first answer is news too: what it queued.
        let previous: string | null = afterReview ? "\u0000" : null;
        let wasHeld = false;
        let idleChecks = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const check = async () => {
            let state: FollowUps | null = null;
            try {
                const response = await fetch(
                    `/api/recordings/${recordingId}/follow-ups`,
                    { signal: controller.signal },
                );
                // Not the owner's, or gone: there is nothing to follow.
                if (response.status >= 400 && response.status < 500) return;
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
            // A failed check is tried again, but not at the quick pace.
            let delay = state ? POLL_MS : HELD_POLL_MS;
            if (state) {
                setHeld(state.held);
                setCorrecting(state.pending.includes(CORRECTION_JOB_KIND));
                const current = state.pending.join(",");
                const released = wasHeld && !state.held;
                if (previous !== null && (current !== previous || released)) {
                    onChangeRef.current();
                }
                previous = current;
                wasHeld = state.held;
                if (state.pending.length > 0) {
                    activeSince ??= Date.now();
                    if (Date.now() - activeSince > POLL_LIMIT_MS) return;
                } else {
                    activeSince = null;
                    // Nothing queued and nothing waits: nothing to follow.
                    if (!state.held) return;
                    // Waiting for a release: quickly just after a review,
                    // then now and then.
                    if (!afterReview || ++idleChecks >= RELEASE_WAIT_CHECKS) {
                        delay = HELD_POLL_MS;
                    }
                }
            }
            timer = setTimeout(check, delay);
        };
        void check();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [recordingId, enabled, following]);

    const follow = useCallback(() => setFollowing((count) => count + 1), []);
    return { held, correcting, follow };
}
