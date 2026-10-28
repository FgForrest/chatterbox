import { expect, it, vi } from "vitest";
import { meetingMarkdown } from "@/lib/meetings/export";
import { detail } from "./ui-fixtures";

vi.mock("@/lib/meetings/service", () => ({ getMeeting: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { APP_URL: "https://example.com" } }));
vi.mock("@/lib/meetings/access", () => ({ requireMeetingAccess: vi.fn() }));
vi.mock("@/lib/i18n/user-time-zone", () => ({ userTimeZone: vi.fn() }));
vi.mock("@/lib/integrations/google/calendar-events", () => ({
    getCalendarEvent: vi.fn(),
    writeCalendarAgenda: vi.fn(),
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: vi.fn(),
}));

it.each([
    false,
    true,
])("formats Markdown clock times for the exporter (Calendar: %s)", (calendar) => {
    const value = {
        ...detail(),
        plannedStart: new Date("2026-11-03T10:00:00Z"),
        plannedEnd: new Date("2026-11-03T11:00:00Z"),
    } as unknown as Parameters<typeof meetingMarkdown>[0];
    const markdown = meetingMarkdown(
        value,
        false,
        "cs-CZ",
        calendar,
        "Europe/Prague",
    );
    expect(markdown).toContain("3. 11. 2026 11:00");
    expect(markdown).toContain("3. 11. 2026 12:00");
    expect(markdown).not.toContain("T10:00:00");
    expect(
        meetingMarkdown(value, false, "en", calendar, "America/New_York"),
    ).toContain("5:00 AM");
});
