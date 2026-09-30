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
