// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelsSection } from "@/components/statistics/spending-sections";
import { useStatisticsView } from "@/components/statistics/use-statistics-view";
import { statisticsFixture } from "@/tests/statistics/fixtures";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (message: string, values?: Record<string, string>) =>
        message.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
}));
afterEach(cleanup);

function Models({ failed }: { failed: number }) {
    const data = statisticsFixture();
    data.models = [["Example", "test-model"]];
    data.modelDays = [[364, 0, 2, 2, 0.5, 0, failed]];
    const view = useStatisticsView(data, { start: 0, end: 364 });
    return <ModelsSection view={view} />;
}

it.each([
    0, 1,
])("gates model failure details in tooltips and tables (failed=%s)", async (failed) => {
    render(<Models failed={failed} />);
    fireEvent.focus(screen.getByRole("button", { name: /test-model/ }));
    const tooltip = screen.getByRole("tooltip").textContent;
    expect(tooltip).not.toContain("0 failed");
    if (failed) expect(tooltip).toContain("1 failed");
    else expect(tooltip).not.toContain("failed");
    const details = screen.getByText("Show as a table").closest("details");
    if (!details) throw new Error("Missing models table");
    fireEvent.click(details.querySelector("summary") as HTMLElement);
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    const table = within(screen.getByRole("table"));
    expect(table.queryByText(/0 failed/)).toBeNull();
    if (failed) expect(table.getByText(/1 failed/)).toBeTruthy();
    else expect(table.queryByText(/failed/)).toBeNull();
});
