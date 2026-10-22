// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingLanguage } from "@/components/dashboard/recording-language";
import { LearnLanguageItem } from "@/components/learn/language-item";
import { LearnWidget } from "@/components/learn/learn-widget";

const transcribe = vi.fn();

const fetchMock = vi.fn();
const reload = vi.fn();
const resummarize = vi.fn();

function control(readOnly = false, view: "private" | "org" = "private") {
    return render(
        <RecordingLanguage
            recordingId="invented-rec"
            detectedLanguage="hun"
            readOnly={readOnly}
            view={view}
            refreshKey={0}
            onReload={reload}
            onResummarize={resummarize}
            resummarizeDisabled={false}
            transcriptionDisabled={false}
            source="riffado"
            onTranscribe={transcribe}
        />,
    );
}

describe("recording language control", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
            Response.json(
                init?.method === "PATCH"
                    ? {
                          confirmedLanguage: "cs",
                          needsResummary: true,
                          needsTitleRegeneration: false,
                      }
                    : {
                          confirmedLanguage: null,
                          needsResummary: false,
                          needsTitleRegeneration: false,
                          canChange: true,
                      },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it.each([
        "private",
        "org",
    ] as const)("shows detected vs confirmed and offers explicit actions in %s", async (view) => {
        control(false, view);
        const select = await screen.findByRole("combobox", {
            name: "Transcript language",
        });
        expect(screen.getByText("Detected language")).toBeTruthy();
        expect((select as HTMLSelectElement).value).toBe("auto");
        fireEvent.change(select, { target: { value: "cs" } });
        await screen.findByText("Confirmed language");
        fireEvent.click(
            await screen.findByRole("button", { name: "Re-summarize" }),
        );
        expect(resummarize).toHaveBeenCalledOnce();
        expect(
            screen.queryByRole("button", { name: "Regenerate title" }),
        ).toBeNull();
        expect(transcribe).not.toHaveBeenCalled();
        const patch = fetchMock.mock.calls.find(
            ([, init]) => init?.method === "PATCH",
        );
        expect(patch?.[0]).toBe(
            `/api/recordings/invented-rec/language${view === "org" ? "?view=org" : ""}`,
        );
        expect(JSON.parse(patch?.[1]?.body as string)).toEqual({
            language: "cs",
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Re-transcribe in Czech" }),
        );
        await screen.findByRole("alertdialog");
        expect(transcribe).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Re-transcribe" }));
        expect(transcribe).toHaveBeenCalledWith("riffado", true, "cs");
    });

    it.each([
        "private",
        "org",
    ] as const)("offers only title regeneration for a title mismatch in %s and refreshes afterward", async (view) => {
        let regenerated = false;
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) => {
                if (init?.method === "POST") {
                    regenerated = true;
                    return Response.json({ filename: "Invented title" });
                }
                return Response.json({
                    confirmedLanguage: "cs",
                    needsResummary: false,
                    needsTitleRegeneration: !regenerated,
                    canChange: true,
                });
            },
        );
        control(false, view);
        const button = await screen.findByRole("button", {
            name: "Regenerate title",
        });
        expect(
            screen.queryByRole("button", { name: "Re-summarize" }),
        ).toBeNull();
        expect(
            fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
        ).toBe(false);
        fireEvent.click(button);
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: "Regenerate title" }),
            ).toBeNull(),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            `/api/recordings/invented-rec/title${view === "org" ? "?view=org" : ""}`,
            { method: "POST" },
        );
        expect(reload).toHaveBeenCalledOnce();
        expect(resummarize).not.toHaveBeenCalled();
    });

    it("keeps the title offer available after a refused regeneration", async () => {
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) =>
                init?.method === "POST"
                    ? Response.json({ error: "Forbidden" }, { status: 403 })
                    : Response.json({
                          confirmedLanguage: "cs",
                          needsResummary: false,
                          needsTitleRegeneration: true,
                          canChange: true,
                      }),
        );
        control();
        fireEvent.click(
            await screen.findByRole("button", { name: "Regenerate title" }),
        );
        await waitFor(() =>
            expect(
                (
                    screen.getByRole("button", {
                        name: "Regenerate title",
                    }) as HTMLButtonElement
                ).disabled,
            ).toBe(false),
        );
        expect(reload).not.toHaveBeenCalled();
    });

    it("clears confirmation with Automatic and skips unchanged choices", async () => {
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
            Response.json({
                confirmedLanguage: init?.method === "PATCH" ? null : "cs",
                canChange: true,
                needsResummary: false,
            }),
        );
        control();
        const select = await screen.findByRole("combobox");
        fireEvent.change(select, { target: { value: "cs" } });
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
        ).toHaveLength(0);
        fireEvent.change(select, { target: { value: "auto" } });
        await screen.findByText("Detected language");
        expect(
            JSON.parse(
                fetchMock.mock.calls.find(
                    ([, init]) => init?.method === "PATCH",
                )?.[1]?.body as string,
            ),
        ).toEqual({ language: null });
        fireEvent.change(select, { target: { value: "auto" } });
        expect(
            fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
        ).toHaveLength(1);
    });

    it.each([
        "hu",
        "hun",
        "hu-HU",
    ])("omits re-transcription when detection %s matches confirmation", async (detectedLanguage) => {
        fetchMock.mockImplementation(async () =>
            Response.json({
                confirmedLanguage: "hu",
                needsResummary: false,
                canChange: true,
            }),
        );
        render(
            <RecordingLanguage
                recordingId="invented-rec"
                detectedLanguage={detectedLanguage}
                readOnly={false}
                refreshKey={0}
                onReload={reload}
                onTranscribe={transcribe}
                resummarizeDisabled={false}
                transcriptionDisabled={false}
            />,
        );
        await screen.findByText("Confirmed language");
        expect(
            screen.queryByRole("button", { name: /Re-transcribe in/ }),
        ).toBeNull();
    });

    it.each([
        undefined,
        "und",
        "unknown",
    ])("omits re-transcription without a known detected language (%s)", async (detectedLanguage) => {
        fetchMock.mockImplementation(async () =>
            Response.json({
                confirmedLanguage: "cs",
                needsResummary: false,
                canChange: true,
            }),
        );
        render(
            <RecordingLanguage
                recordingId="invented-rec"
                detectedLanguage={detectedLanguage}
                readOnly={false}
                refreshKey={0}
                onReload={reload}
                onTranscribe={transcribe}
                resummarizeDisabled={false}
                transcriptionDisabled={false}
            />,
        );
        await screen.findByText("Confirmed language");
        expect(
            screen.queryByRole("button", { name: /Re-transcribe in/ }),
        ).toBeNull();
    });

    it("leaves a rejected Learn language unselected until an explicit accepted choice", async () => {
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
            Response.json(
                init?.method === "PATCH"
                    ? { version: 1 }
                    : {
                          available: true,
                          run: { id: "invented-run", status: "ready" },
                          names: {},
                          types: {},
                          relations: {},
                          items: [
                              {
                                  id: "invented-item",
                                  kind: "language",
                                  preTicked: true,
                                  decision: "rejected",
                                  choice: null,
                                  version: 0,
                                  dependsOnLabel: null,
                                  payload: {
                                      language: "cs",
                                      detectedLanguage: "hu",
                                      confidence: 0.99,
                                  },
                              },
                          ],
                      },
            ),
        );
        render(<LearnWidget recordingId="invented-rec" showTrigger={false} />);
        const provider = await screen.findByRole("radio", {
            name: "Keep detected Hungarian",
        });
        expect((provider as HTMLInputElement).checked).toBe(false);
        expect(
            (
                screen.getByRole("radio", {
                    name: "Use Czech",
                }) as HTMLInputElement
            ).checked,
        ).toBe(false);
        fireEvent.click(provider);
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/recordings/invented-rec/review/items/invented-item?source=riffado",
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({
                        decision: "accepted",
                        version: 0,
                        choice: { language: "hu" },
                    }),
                }),
            ),
        );
        await waitFor(() =>
            expect((provider as HTMLInputElement).checked).toBe(true),
        );
    });

    it.each([
        true,
        false,
    ])("enforces read-only UI and server permission (readOnly=%s)", async (readOnly) => {
        fetchMock.mockResolvedValue(
            Response.json({
                confirmedLanguage: "cs",
                needsResummary: true,
                needsTitleRegeneration: true,
                canChange: false,
            }),
        );
        control(readOnly);
        await screen.findByText("Confirmed language: Czech");
        expect(screen.queryByRole("combobox")).toBeNull();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("rolls back an optimistic change when the server refuses it", async () => {
        fetchMock.mockImplementation(
            async (_url: string, init?: RequestInit) =>
                init?.method === "PATCH"
                    ? Response.json({ error: "Forbidden" }, { status: 403 })
                    : Response.json({
                          confirmedLanguage: null,
                          canChange: true,
                      }),
        );
        control();
        fireEvent.change(await screen.findByRole("combobox"), {
            target: { value: "cs" },
        });
        await waitFor(() =>
            expect(
                (screen.getByRole("combobox") as HTMLSelectElement).value,
            ).toBe("auto"),
        );
        expect(reload).not.toHaveBeenCalled();
    });

    it("preselects Learn's language and offers provider and list choices", () => {
        const choose = vi.fn();
        render(
            <LearnLanguageItem
                language="cs"
                detectedLanguage="hu"
                chosen="cs"
                disabled={false}
                onChoose={choose}
            />,
        );
        expect(
            (
                screen.getByRole("radio", {
                    name: "Use Czech",
                }) as HTMLInputElement
            ).checked,
        ).toBe(true);
        fireEvent.click(
            screen.getByRole("radio", { name: "Keep detected Hungarian" }),
        );
        expect(choose).toHaveBeenCalledWith("hu");
        fireEvent.change(
            screen.getByRole("combobox", { name: "Pick another language" }),
            { target: { value: "sk" } },
        );
        expect(choose).toHaveBeenCalledWith("sk");
    });
});
