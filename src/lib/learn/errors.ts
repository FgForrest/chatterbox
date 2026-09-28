/**
 * The failures of a Learn pass that another attempt would not cure. Plain
 * errors, so the pure pass and its tests load nothing else; the job
 * handler fails the run on them without a retry.
 */

/** The run has used its knowledge lookups. */
export class LearnToolBudgetExhausted extends Error {
    constructor() {
        super("This run has used all its knowledge lookups");
        this.name = "LearnToolBudgetExhausted";
    }
}

/** No window's answer was the shape Learn needs, even after a repair. */
export class LearnOutputUnusable extends Error {
    constructor(detail: string) {
        super(`The model's answer is not the shape Learn needs: ${detail}`);
        this.name = "LearnOutputUnusable";
    }
}

/** Whether a Learn failure is final (the queue must not retry it). */
export function isFinalLearnError(error: unknown): boolean {
    return (
        error instanceof LearnToolBudgetExhausted ||
        error instanceof LearnOutputUnusable
    );
}
