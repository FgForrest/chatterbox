// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgenda } from "@/components/meetings/use-agenda";
import { detail, point } from "./ui-fixtures";

const { errorToast } = vi.hoisted(() => ({ errorToast: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: errorToast } }));
vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
it("drops a stale suggestion overlay and reloads all suggestions with a toast", async () => {
    const initial = detail();
    const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
            Response.json(
                {
                    code: "STALE_AGENDA_SUGGESTION",
                    error: "stale",
                    details: { reason: "stale_suggestion_sources" },
                },
                { status: 409 },
            ),
        )
        .mockResolvedValue(Response.json(initial));
    vi.stubGlobal("fetch", fetchMock);
    function Agenda() {
        const agenda = useAgenda("agenda", initial, { pollEnabled: false });
        return (
            <>
                <button
                    type="button"
                    onClick={() =>
                        void agenda.mutate(
                            "/suggestions/stale",
                            "PATCH",
                            { state: "added" },
                            (value) => ({
                                ...value,
                                points: [
                                    ...value.points,
                                    point("withdrawn source"),
                                ],
                            }),
                        )
                    }
                >
                    Accept suggestion
                </button>
                {agenda.detail?.points.map((entry) => (
                    <p key={entry.id}>{entry.text}</p>
                ))}
            </>
        );
    }
    render(<Agenda />);
    fireEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));
    await waitFor(() =>
        expect(errorToast).toHaveBeenCalledWith(
            "This suggestion is no longer available. Suggestions have been refreshed.",
        ),
    );
    await waitFor(() =>
        expect(screen.queryByText("withdrawn source")).toBeNull(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/meetings/agenda",
        expect.anything(),
    );
});

it.each([
    [
        "RESTRICTED_FOLDER_NO_ACCESS",
        "You no longer have access to this restricted folder.",
    ],
    ["RESTRICTED_FOLDER_LEAF", "A restricted folder has no subfolders."],
    ["FORBIDDEN", "You no longer have permission for this action."],
    [
        "SHARE_REQUIREMENTS_UNMET",
        "Not shared. Transcribe the recording before sharing it.",
    ],
])("rolls back refused agenda filing and localizes %s", async (code, message) => {
    errorToast.mockClear();
    const initial = detail();
    const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
            Response.json(
                {
                    code,
                    error: "server text",
                    details: { problems: [{ kind: "no_transcript" }] },
                },
                { status: code === "FORBIDDEN" ? 403 : 409 },
            ),
        )
        .mockResolvedValue(Response.json(initial));
    vi.stubGlobal("fetch", fetchMock);
    function AgendaFiling() {
        const agenda = useAgenda("agenda", initial, { pollEnabled: false });
        return (
            <>
                <button
                    type="button"
                    onClick={() =>
                        void agenda.mutate(
                            "/api/recordings/item/folders",
                            "POST",
                            { folderId: "folder" },
                            (value) => ({
                                ...value,
                                points: [
                                    ...value.points,
                                    point("optimistic filing"),
                                ],
                            }),
                        )
                    }
                >
                    File agenda
                </button>
                {agenda.conflict && <p>generic conflict</p>}
                {agenda.detail?.points.map((entry) => (
                    <p key={entry.id}>{entry.text}</p>
                ))}
            </>
        );
    }
    render(<AgendaFiling />);
    fireEvent.click(screen.getByRole("button", { name: "File agenda" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(message));
    await waitFor(() =>
        expect(screen.queryByText("optimistic filing")).toBeNull(),
    );
    expect(screen.queryByText("generic conflict")).toBeNull();
});
