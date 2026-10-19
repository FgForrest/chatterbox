// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
    LearnEvidence,
    LearnOutcomeLine,
    LearnReviewRow,
} from "@/components/learn/review-parts";

afterEach(cleanup);

it("renders the shared Learn row, evidence, and outcome", () => {
    const onCheckedChange = vi.fn();
    render(
        <LearnReviewRow
            kind="fact"
            checked={false}
            checkboxLabel="Apply this fact"
            onCheckedChange={onCheckedChange}
        >
            <span>Jan leads Orion</span>
            <LearnEvidence quote="I lead Orion" provenance="Quoted" />
            <LearnOutcomeLine>Applied</LearnOutcomeLine>
        </LearnReviewRow>,
    );

    const row = document.querySelector('[data-shared-learn-row="fact"]');
    expect(row).toBeTruthy();
    expect(screen.getByText(/I lead Orion/)).toBeTruthy();
    expect(screen.getByText("Quoted")).toBeTruthy();
    expect(screen.getByText("Applied")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply this fact" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
});

it("keeps a record reason directly before its clipped quote and expands only that quote", () => {
    render(
        <>
            <LearnEvidence quote="First quoted words">
                <div>First reason</div>
            </LearnEvidence>
            <LearnEvidence quote="Second quoted words">
                <div>Second reason</div>
            </LearnEvidence>
        </>,
    );
    const [first, second] = screen.getAllByRole("button", {
        name: "Full quote",
    });
    const quote = document.getElementById(
        first.getAttribute("aria-controls") ?? "",
    );
    expect(quote?.parentElement?.previousElementSibling?.textContent).toBe(
        "First reason",
    );
    expect(quote?.classList.contains("truncate")).toBe(true);
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(first.textContent).toBe("Shorten");
    expect(quote?.classList.contains("truncate")).toBe(false);
    expect(second.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(first);
    expect(quote?.classList.contains("truncate")).toBe(true);
});
