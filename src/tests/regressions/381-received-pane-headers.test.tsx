// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import { MailDetailPane } from "@/components/mail/mail-detail-pane";
import { RestrictedFolderProvider } from "@/components/sharing/restricted-folder-context";
import type { RecordingFolder } from "@/types/folder";
import type { Recording } from "@/types/recording";

vi.mock("next/navigation", () => ({
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
vi.mock("@/components/dashboard/folder-knowledge-panel", () => ({
    KnowledgePanel: () => null,
}));
vi.mock("@/components/dashboard/recording-player", () => ({
    RecordingPlayer: () => null,
    transcriptPlayback: () => null,
}));
vi.mock("@/components/dashboard/recording-player-header", () => ({
    RecordingPlayerHeader: ({ titleReadOnly }: { titleReadOnly: boolean }) => (
        <output>Title read-only: {String(titleReadOnly)}</output>
    ),
}));
vi.mock("@/components/dashboard/transcription-panel", () => ({
    TranscriptionPanel: ({
        transcription,
        readOnly,
    }: {
        transcription: { text: string };
        readOnly: boolean;
    }) => (
        <output>
            {transcription.text}; transcript read-only: {String(readOnly)}
        </output>
    ),
}));
vi.mock("@/components/meetings/recording-agenda", () => ({
    RecordingAgenda: ({
        children,
    }: {
        children: (value: { agenda: null; nextMeeting: null }) => ReactNode;
    }) => children({ agenda: null, nextMeeting: null }),
}));
vi.mock("@/components/recordings/recording-cut", () => ({
    RecordingCutProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/recordings/trim-proposal-card", () => ({
    TrimProposalCard: () => null,
}));
vi.mock("@/components/sharing/person-sharing", () => ({
    ReceivedItemBanner: () => null,
}));
vi.mock("@/components/pipeline/item-workflow", () => ({
    ItemWorkflow: () => {
        throw new Error("Received items must stay read-only");
    },
}));
vi.mock("@/components/items/item-header", () => ({
    ItemHeader: ({ readOnly }: { readOnly: boolean }) => (
        <output>Title read-only: {String(readOnly)}</output>
    ),
}));
vi.mock("@/components/mail/mail-learn-card", () => ({
    MailLearnCard: () => {
        throw new Error("Received mail must not learn");
    },
}));
vi.mock("@/components/mail/mail-summary-card", () => ({
    MailSummaryCard: ({ canChange }: { canChange: boolean }) => (
        <output>Summary read-only: {String(!canChange)}</output>
    ),
}));
vi.mock("@/components/pipeline/workflow-widget", () => ({
    openWidget: vi.fn(),
    WorkflowWidget: ({ children }: { children: ReactNode }) => children,
}));
const root: RecordingFolder = {
    id: "org",
    name: "Organization",
    parentId: null,
    kind: "public",
    scope: "org",
    sortOrder: 0,
    version: 1,
};
const parent: RecordingFolder = {
    ...root,
    id: "project",
    parentId: root.id,
    kind: "custom",
    name: "Acme",
};
const locked: RecordingFolder = {
    ...parent,
    id: "locked",
    parentId: parent.id,
    name: "Pilot",
    restricted: true,
    access: true,
};
const recording: Recording = {
    id: "item",
    kind: "audio",
    filename: "Restricted item",
    duration: 100,
    filesize: 100,
    startTime: "2026-11-01T12:00:00Z",
    deviceSn: "local",
    isOwn: false,
    view: "received",
    ownerName: "Robin Fields",
};
const shared = {
    folders: [root, parent, locked],
    folderAssignments: [{ recordingId: recording.id, folderId: locked.id }],
    onSelectFolder: vi.fn(),
    onAddToFolder: vi.fn(),
    onRemoveFromFolder: vi.fn(),
    onMoveBetweenFolders: vi.fn(),
    hiddenOnMobile: false,
    onBackToList: vi.fn(),
};
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
it.each([
    "audio",
    "mail",
] as const)("the real received %s pane shows the restricted path/readers/owner note without mutation actions", async (kind) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) =>
        String(url).endsWith("/readers")
            ? Response.json({
                  ownerUserId: "owner",
                  restricted: true,
                  organization: false,
                  curatorsCanRead: true,
                  readers: [
                      {
                          userId: "owner",
                          name: "Robin Fields",
                          email: "robin@example.com",
                      },
                      {
                          userId: "viewer",
                          name: "Lada Cloudfern",
                          email: "lada@example.com",
                      },
                  ],
              })
            : Response.json({
                  participants: [],
                  segments: [
                      { index: 0, role: "body", text: "Owner's mail text" },
                  ],
                  attachments: [],
                  processing: null,
                  sentAt: recording.startTime,
                  receivedAt: recording.startTime,
              }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const audio: ComponentProps<typeof WorkstationDetailPane> = {
        ...shared,
        currentRecording: recording,
        currentTranscription: { text: "Owner's transcript and speaker names" },
        transcripts: undefined,
        transcriptReadOnly: true,
        isCurrentTranscribing: false,
        visibleRecordings: [recording],
        onTranscribe: vi.fn(),
        onSelectRecording: vi.fn(),
        onDelete: vi.fn(),
        onArtifactsChanged: vi.fn(),
        initialPlaybackSpeed: undefined,
        initialVolume: undefined,
        initialAutoPlayNext: undefined,
        scrubberStyle: undefined,
    };
    const { container } = render(
        <RestrictedFolderProvider writable userId="viewer">
            {kind === "audio" ? (
                <WorkstationDetailPane {...audio} />
            ) : (
                <MailDetailPane
                    {...shared}
                    mail={{ ...recording, kind }}
                    dateTimeFormat="absolute"
                    onChanged={vi.fn()}
                    isOrgAccount
                    canCurate
                />
            )}
        </RestrictedFolderProvider>,
    );
    expect(
        screen.getByRole("button", { name: "Organization / Acme / Pilot" }),
    ).toBeTruthy();
    expect(
        container.querySelector(".lucide-folder-lock.text-restricted"),
    ).toBeTruthy();
    await screen.findByRole("img", { name: "Lada Cloudfern" });
    expect(screen.getByText("and curators")).toBeTruthy();
    expect(
        screen.getByText(/The Organization Almanac does not learn/),
    ).toBeTruthy();
    expect(screen.getByText(/Title read-only: true/)).toBeTruthy();
    if (kind === "audio")
        expect(
            screen.getByText(
                /Owner's transcript and speaker names; transcript read-only: true/,
            ),
        ).toBeTruthy();
    else {
        await screen.findByText("Owner's mail text");
        expect(screen.getByText("Summary read-only: true")).toBeTruthy();
    }
    expect(
        screen.queryByRole("button", {
            name: /Remove from|Add to folder|Move to|Take out of the Organization/,
        }),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
        "/api/items/item/readers",
        expect.anything(),
    );
    if (kind === "mail")
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/item?view=received",
            expect.anything(),
        );
});
