// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemHeader } from "@/components/items/item-header";

vi.mock("@/components/recordings/ai-cost-summary", () => ({
    AiCostSummary: () => null,
}));
vi.mock("@/components/recordings/recording-title", () => ({
    RecordingTitle: ({ filename }: { filename: string }) => (
        <span>{filename}</span>
    ),
}));
vi.mock("@/components/sharing/person-sharing", () => ({
    usePersonSharing: () => false,
}));
afterEach(cleanup);
describe.each(["audio", "mail"] as const)("%s Knowledge header", (kind) => {
    it.each([
        "private",
        "org",
        "received",
    ] as const)("opens Knowledge in the %s view", (view) => {
        const open = vi.fn();
        render(
            <ItemHeader
                itemId="item"
                kind={kind}
                title="Invented item"
                metadata={[]}
                view={view}
                onKnowledge={open}
            />,
        );
        const button = screen.getByRole("button", { name: "Knowledge" });
        expect(button.getAttribute("aria-pressed")).toBe("false");
        expect(button.className).toContain("size-8");
        expect(button.querySelector("svg.lucide-book-open")).toBeTruthy();
        fireEvent.click(button);
        expect(open).toHaveBeenCalledOnce();
        expect(screen.queryByRole("status")).toBeNull();
    });
    it("keeps Knowledge pressed while its panel is open and clears it on Back", () => {
        const props = {
            itemId: "item",
            kind,
            title: "Invented item",
            metadata: [],
        };
        const { rerender } = render(<ItemHeader {...props} knowledgeOpen />);
        const button = screen.getByRole("button", { name: "Knowledge" });
        expect(button.getAttribute("aria-pressed")).toBe("true");
        expect(button.className).toContain("border");
        rerender(<ItemHeader {...props} knowledgeOpen={false} />);
        expect(button.getAttribute("aria-pressed")).toBe("false");
    });
    it("badges only a review waiting for this person in the review colour", () => {
        render(
            <ItemHeader
                itemId="item"
                kind={kind}
                title="Invented item"
                metadata={[]}
                pendingLearnCount={3}
            />,
        );
        const badge = screen.getByRole("status", { name: "Review (3)" });
        expect(badge.textContent).toBe("3");
        expect(badge.className).toContain("--step-review");
    });
});
