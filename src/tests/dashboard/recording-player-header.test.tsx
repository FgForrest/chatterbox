// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
    useLocale: () => "en",
}));

vi.mock("@/components/items/item-header", () => ({
    ItemHeader: ({ retentionNotes }: { retentionNotes?: string[] }) => (
        <div>
            {retentionNotes?.map((note) => (
                <p key={note}>{note}</p>
            ))}
        </div>
    ),
}));

afterEach(cleanup);

it("describes erased recording artifacts without attributing them to retention", () => {
    const recording: Recording = {
        id: "recording-1",
        filename: "Meeting",
        duration: 60_000,
        filesize: 1_024,
        startTime: "2026-10-18T12:00:00.000Z",
        deviceSn: "local",
        audioReapedAt: "2026-10-18T13:00:00.000Z",
        transcriptReapedAt: "2026-10-18T13:01:00.000Z",
        summaryReapedAt: "2026-10-18T13:02:00.000Z",
    };

    render(<RecordingPlayerHeader recording={recording} />);

    expect(screen.getByText("The audio was removed on {date}.")).toBeTruthy();
    expect(
        screen.getByText("Its transcript was removed on {date}."),
    ).toBeTruthy();
    expect(screen.getByText("Its summary was removed on {date}.")).toBeTruthy();
    expect(screen.queryByText(/Retention removed/)).toBeNull();
});
