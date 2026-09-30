"use client";

import { useEffect, useState } from "react";

/**
 * Said on the window when the Learn reviews waiting for the viewer may
 * have changed (one was finished), so whatever counts them counts again.
 */
const LEARN_REVIEWS_CHANGED = "riffado:learn-reviews-changed";

export function announceLearnReviewsChanged(): void {
    window.dispatchEvent(new Event(LEARN_REVIEWS_CHANGED));
}

/** Call `listener` on every announcement; returns how to stop. */
export function onLearnReviewsChanged(listener: () => void): () => void {
    window.addEventListener(LEARN_REVIEWS_CHANGED, listener);
    return () => window.removeEventListener(LEARN_REVIEWS_CHANGED, listener);
}

/**
 * How many Learn reviews wait for the viewer, counted again whenever one
 * is finished. 0 where Learn is unavailable.
 */
export function usePendingReviews(): number {
    const [pending, setPending] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const count = () =>
            fetch("/api/learn/pending")
                .then((response) =>
                    response.ok ? response.json() : { count: 0 },
                )
                .then((body: { count?: number }) => {
                    if (!cancelled) setPending(body.count ?? 0);
                })
                .catch(() => {});
        void count();
        const stop = onLearnReviewsChanged(() => void count());
        return () => {
            cancelled = true;
            stop();
        };
    }, []);
    return pending;
}
