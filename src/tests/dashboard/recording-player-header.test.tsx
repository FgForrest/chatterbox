// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "@/types/recording";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string, values?: Record<string, string>) =>
        message.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? ""),
    useLocale: () => "en",
}));

vi.mock("@/components/items/item-header", () => ({
    ItemHeader: ({
        metadata,
        retentionNotes,
    }: {
        metadata?: string[];
        retentionNotes?: string[];
    }) => (
        <div>
            {metadata?.map((part) => (
                <span key={part}>{part}</span>
            ))}
            {retentionNotes?.map((note) => (
                <p key={note}>{note}</p>
            ))}
        </div>
    ),
}));

import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";

const recording: Recording = {
    id: "rec-1",
    filename: "Planning session",
    duration: 60_000,
    filesize: 1024,
    startTime: "2026-10-18T10:00:00.000Z",
    deviceSn: "PLAUD-7",
};

describe("RecordingPlayerHeader", () => {
    afterEach(cleanup);

    it("keeps the device identifier reachable in the dashboard detail", () => {
        render(<RecordingPlayerHeader recording={recording} />);

        expect(screen.getByText("Device: PLAUD-7")).toBeDefined();
    });

    it("leaves out the device for an uploaded recording", () => {
        render(
            <RecordingPlayerHeader
                recording={{ ...recording, deviceSn: "local" }}
            />,
        );

        expect(screen.queryByText(/^Device:/)).toBeNull();
    });

    it("describes erased recording artifacts without attributing them to retention", () => {
        render(
            <RecordingPlayerHeader
                recording={{
                    ...recording,
                    deviceSn: "local",
                    audioReapedAt: "2026-10-18T13:00:00.000Z",
                    transcriptReapedAt: "2026-10-18T13:01:00.000Z",
                    summaryReapedAt: "2026-10-18T13:02:00.000Z",
                }}
            />,
        );

        expect(screen.getByText(/^The audio was removed on /)).toBeTruthy();
        expect(
            screen.getByText(/^Its transcript was removed on /),
        ).toBeTruthy();
        expect(screen.getByText(/^Its summary was removed on /)).toBeTruthy();
        expect(screen.queryByText(/Retention removed/)).toBeNull();
    });
});
