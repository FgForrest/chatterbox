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
