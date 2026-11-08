// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachRecordingDialog } from "@/components/meetings/attach-recording-dialog";
import {
    AttachmentShareChoice,
    useAttachmentShareChoice,
} from "@/components/meetings/attachment-disclosure";
import { RecordingAgenda } from "@/components/meetings/recording-agenda";
import { RecordingShareBanner } from "@/components/meetings/recording-share-banner";
import { useAgenda } from "@/components/meetings/use-agenda";
import { PersonSharingProvider } from "@/components/sharing/person-sharing";
import { subscribeEvents } from "@/lib/events/client";
import { detail } from "./ui-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-intl", () => ({
    useExtracted:
        () => (text: string, values?: Record<string, string | number>) =>
            text.replace(/\{(\w+)\}/g, (match, key: string) =>
                String(values?.[key] ?? match),
            ),
    useFormatter: () => ({
        dateTime: () => "2026-11-08",
        list: (values: string[]) => values.join(", "),
    }),
}));
vi.mock("@/components/meetings/agenda-body", () => ({
    AgendaBody: () => <div />,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/events/client", () => ({
    subscribeEvents: vi.fn(() => () => {}),
}));
const request = vi.fn();
beforeEach(() => {
    window.localStorage.clear();
    request
        .mockReset()
        .mockResolvedValue(
            Response.json({ people: [{ id: "receiver", name: "Petr Novák" }] }),
        );
    vi.stubGlobal("fetch", request);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe.each([
    "choice",
    "dialog",
    "recording",
] as const)("explicit recording sharing in %s", (variant) => {
    it("defaults the invitation choice on and lets the owner keep the recording private", async () => {
        function Choice() {
            const choice = useAttachmentShareChoice("agenda", "recording");
            return <AttachmentShareChoice choice={choice} />;
        }
        const attached = vi.fn();
        if (variant === "recording")
            request.mockImplementation(
                async (url: string, init?: RequestInit) => {
                    if (url.includes("recording-shares"))
                        return Response.json({
                            people: [{ id: "receiver", name: "Petr Novák" }],
                        });
                    if (url.includes("agenda-candidates"))
                        return Response.json({
                            candidates: [
                                {
                                    id: "agenda",
                                    title: "Project agenda",
                                    folders: [],
                                    overlapMs: 60000,
                                    widensSharing: false,
                                },
                            ],
                        });
                    if (init?.method === "POST")
                        return Response.json({ success: true });
                    if (url.endsWith("/next-meeting"))
                        return Response.json({ event: null });
                    return Response.json({
                        agenda: detail({ recordingItemId: "recording" }),
                    });
                },
            );
        const recording = {
            id: "recording",
            filename: "Project review",
            duration: 60000,
            filesize: 1,
            startTime: new Date().toISOString(),
            deviceSn: "demo",
        };
        render(
            <PersonSharingProvider value>
                {variant === "choice" ? (
                    <Choice />
                ) : variant === "dialog" ? (
                    <AttachRecordingDialog
                        detail={detail()}
                        recordings={[recording]}
                        folders={[]}
                        open
                        onOpenChange={vi.fn()}
                        onAttached={attached}
                    />
                ) : (
                    <RecordingAgenda
                        recording={{ ...recording, agendaCandidateCount: 1 }}
                        folders={[]}
                        userId="owner"
                        onChanged={attached}
                    />
                )}
            </PersonSharingProvider>,
        );
        if (variant !== "choice")
            fireEvent.click(await screen.findByRole("radio"));
        const checkbox = await screen.findByRole("checkbox", {
            name: /Share the recording with these people too: Petr Novák/,
        });
        expect(checkbox).toHaveProperty("checked", true);
        fireEvent.click(checkbox);
        expect(checkbox).toHaveProperty("checked", false);
        if (variant !== "choice") {
            if (variant === "dialog")
                request.mockResolvedValueOnce(Response.json({ success: true }));
            fireEvent.click(
                screen.getByRole("button", {
                    name: variant === "dialog" ? "Attach" : "Attach agenda",
                }),
            );
            await waitFor(() => expect(attached).toHaveBeenCalled());
            expect(request).toHaveBeenCalledWith(
                "/api/meetings/agenda/attach",
                expect.objectContaining({
                    body: JSON.stringify({
                        recordingItemId: "recording",
                        shareRecording: false,
                    }),
                }),
            );
        }
    });
});

it("remembers Keep private per user and recording", async () => {
    const frame = (userId: string, recordingId: string) => (
        <PersonSharingProvider value>
            <RecordingShareBanner
                agendaId="agenda"
                title="Project agenda"
                userId={userId}
                recordingId={recordingId}
            />
        </PersonSharingProvider>
    );
    const { rerender, unmount } = render(frame("owner", "recording"));
    await screen.findByText(/The recording is not shared with them yet/);
    fireEvent.click(screen.getByRole("button", { name: "Keep private" }));
    expect(screen.queryByText(/The recording is not shared/)).toBeNull();
    rerender(frame("owner", "other-recording"));
    await screen.findByText(/The recording is not shared with them yet/);
    rerender(frame("other-owner", "recording"));
    await screen.findByText(/The recording is not shared with them yet/);
    unmount();
    render(frame("owner", "recording"));
    await waitFor(() =>
        expect(screen.queryByText(/The recording is not shared/)).toBeNull(),
    );
});

it("sends ordinary invitations and hides the banner once all people are invited", async () => {
    render(
        <PersonSharingProvider value>
            <RecordingShareBanner
                agendaId="agenda"
                title="Project agenda"
                userId="owner"
                recordingId="recording"
            />
        </PersonSharingProvider>,
    );
    await screen.findByText(/The recording is not shared/);
    request
        .mockResolvedValueOnce(
            Response.json({
                recordingShare: { invited: ["receiver"], skipped: [] },
            }),
        )
        .mockResolvedValueOnce(Response.json({ people: [] }));
    fireEvent.click(
        screen.getByRole("button", {
            name: "Invite them to the recording too",
        }),
    );
    await waitFor(() =>
        expect(screen.queryByText(/The recording is not shared/)).toBeNull(),
    );
    expect(request).toHaveBeenCalledWith(
        "/api/meetings/agenda/recording-shares",
        expect.objectContaining({ method: "POST" }),
    );
});

it("refreshes agenda filing on a share event and clears detail immediately after revocation", async () => {
    function View() {
        const agenda = useAgenda("agenda", detail());
        return <p>{agenda.detail?.title ?? agenda.error ?? "Loading"}</p>;
    }
    request.mockResolvedValueOnce(
        Response.json(detail({ title: "Updated filing" })),
    );
    render(<View />);
    await act(async () => {
        vi.mocked(subscribeEvents).mock.calls.at(-1)?.[0]({ type: "share" });
    });
    expect(await screen.findByText("Updated filing")).toBeTruthy();
    request.mockResolvedValueOnce(
        Response.json(
            { code: "NOT_FOUND", error: "Agenda not found" },
            { status: 404 },
        ),
    );
    await act(async () => {
        vi.mocked(subscribeEvents).mock.calls.at(-1)?.[0]({ type: "share" });
    });
    expect(await screen.findByText("Could not load the agenda")).toBeTruthy();
    expect(screen.queryByText("Updated filing")).toBeNull();
});

describe.each([
    "dialog",
    "recording",
] as const)("attachment consent in %s", (variant) => {
    const recording = {
        id: "recording",
        filename: "Project review",
        duration: 60000,
        filesize: 1,
        startTime: new Date().toISOString(),
        deviceSn: "demo",
    };
    function frame(attached = vi.fn()) {
        return (
            <PersonSharingProvider value>
                {variant === "dialog" ? (
                    <AttachRecordingDialog
                        detail={detail()}
                        recordings={[
                            recording,
                            {
                                ...recording,
                                id: "second",
                                filename: "Second review",
                            },
                        ]}
                        folders={[]}
                        open
                        onOpenChange={vi.fn()}
                        onAttached={attached}
                        {...{ userId: "owner" }}
                    />
                ) : (
                    <RecordingAgenda
                        recording={{ ...recording, agendaCandidateCount: 2 }}
                        folders={[]}
                        userId="owner"
                        onChanged={attached}
                    />
                )}
            </PersonSharingProvider>
        );
    }
    function setup(offer: () => Promise<Response>) {
        request.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes("recording-shares")) return offer();
            if (url.includes("agenda-candidates"))
                return Response.json({
                    candidates: ["agenda", "second"].map((id) => ({
                        id,
                        title:
                            id === "agenda"
                                ? "Project agenda"
                                : "Second agenda",
                        folders: [],
                        overlapMs: 60000,
                        widensSharing: false,
                    })),
                });
            if (init?.method === "POST")
                return Response.json({ success: true });
            if (url.endsWith("/next-meeting"))
                return Response.json({ event: null });
            return Response.json({
                agenda: detail({ recordingItemId: "recording" }),
            });
        });
    }
    it.each([
        "pending",
        "rejected",
        "empty",
    ])("attaches without invitations for a %s offer", async (status) => {
        setup(() =>
            status === "pending"
                ? new Promise<Response>(() => {})
                : status === "rejected"
                  ? Promise.reject(new Error("offline"))
                  : Promise.resolve(Response.json({ people: [] })),
        );
        const attached = vi.fn();
        render(frame(attached));
        fireEvent.click((await screen.findAllByRole("radio"))[0]);
        await act(async () => {});
        expect(screen.queryByRole("checkbox")).toBeNull();
        fireEvent.click(
            screen.getByRole("button", {
                name: variant === "dialog" ? "Attach" : "Attach agenda",
            }),
        );
        await waitFor(() => expect(attached).toHaveBeenCalled());
        expect(request).toHaveBeenCalledWith(
            "/api/meetings/agenda/attach",
            expect.objectContaining({
                body: JSON.stringify({
                    recordingItemId: "recording",
                    shareRecording: false,
                }),
            }),
        );
    });
    it("does not reuse an offer for a different selected pair", async () => {
        let calls = 0;
        setup(() =>
            ++calls === 1
                ? Promise.resolve(
                      Response.json({
                          people: [{ id: "receiver", name: "Petr Novák" }],
                      }),
                  )
                : new Promise<Response>(() => {}),
        );
        const attached = vi.fn();
        render(frame(attached));
        const radios = await screen.findAllByRole("radio");
        fireEvent.click(radios[0]);
        await screen.findByRole("checkbox");
        fireEvent.click(radios[1]);
        expect(screen.queryByRole("checkbox")).toBeNull();
        fireEvent.click(
            screen.getByRole("button", {
                name: variant === "dialog" ? "Attach" : "Attach agenda",
            }),
        );
        await waitFor(() => expect(attached).toHaveBeenCalled());
        expect(request).toHaveBeenCalledWith(
            `/api/meetings/${variant === "dialog" ? "agenda" : "second"}/attach`,
            expect.objectContaining({
                body: JSON.stringify({
                    recordingItemId:
                        variant === "dialog" ? "second" : "recording",
                    shareRecording: false,
                }),
            }),
        );
    });
    it("remembers an explicit unticked choice after attachment", async () => {
        setup(() =>
            Promise.resolve(
                Response.json({
                    people: [{ id: "receiver", name: "Petr Novák" }],
                }),
            ),
        );
        const attached = vi.fn();
        const { unmount } = render(frame(attached));
        fireEvent.click((await screen.findAllByRole("radio"))[0]);
        fireEvent.click(await screen.findByRole("checkbox"));
        fireEvent.click(
            screen.getByRole("button", {
                name: variant === "dialog" ? "Attach" : "Attach agenda",
            }),
        );
        await waitFor(() => expect(attached).toHaveBeenCalled());
        expect(
            window.localStorage.getItem(
                "klepna:agenda-recording-private:owner:recording",
            ),
        ).toBe("true");
        unmount();
        render(
            <PersonSharingProvider value>
                <RecordingShareBanner
                    agendaId="agenda"
                    title="Project agenda"
                    userId="owner"
                    recordingId="recording"
                />
            </PersonSharingProvider>,
        );
        await act(async () => {});
        expect(
            screen.queryByRole("button", { name: "Keep private" }),
        ).toBeNull();
    });
});
