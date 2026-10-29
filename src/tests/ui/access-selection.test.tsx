// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessSection } from "@/components/settings-sections/access-section";
import { translatedSourceMessage } from "@/lib/i18n/messages";

const translate = (message: string, values?: TranslationValues) =>
    translatedSourceMessage("en", message, values);
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
}));

const { toast } = vi.hoisted(() => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/auth-client", () => ({ signIn: { oauth2: vi.fn() } }));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => vi.fn(),
}));

function person(subject: string) {
    return {
        subject,
        name: `${subject} Example`,
        email: `${subject.toLowerCase()}@example.com`,
        username: null,
        enabled: true,
        effective: [],
        managed: [],
        inherited: [],
        local: null,
        revision: "revision",
        self: false,
    };
}

function detail(subject: string, outcome = `${subject} history`) {
    return {
        access: person(subject),
        history: [
            {
                at: "2026-10-01T00:00:00Z",
                correlationId: outcome,
                action: "change",
                requested: {},
                outcome,
                revocation: "pending",
            },
        ],
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

let requests: Map<string, Promise<Response>[]>;
let fetchMock: ReturnType<typeof vi.fn>;

function enqueue(subject: string, method = "GET") {
    const response = deferred<Response>();
    const key = `${method} /api/access/subjects/${subject}`;
    const queue = requests.get(key) ?? [];
    queue.push(response.promise);
    requests.set(key, queue);
    return response;
}

async function finish(
    pending: ReturnType<typeof enqueue>,
    body: unknown,
    status = 200,
) {
    await act(async () => {
        pending.resolve(Response.json(body, { status }));
    });
}

async function select(subject: string) {
    const button = await screen.findByRole("button", {
        name: new RegExp(`^${subject} Example`),
    });
    await act(async () => {
        fireEvent.click(button);
    });
}

function expectB() {
    expect(
        screen
            .getByRole("button", { name: /^B Example/ })
            .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByText(/B history$/)).toBeTruthy();
    expect(screen.queryByText(/A history$/)).toBeNull();
}

beforeEach(() => {
    requests = new Map();
    vi.clearAllMocks();
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/access/subjects?")) {
            return Response.json({
                rows: [person("A"), person("B")],
                hasMore: false,
            });
        }
        if (url === "/api/access/pending-revocations")
            return Response.json({ people: [] });
        const pending = requests
            .get(`${init?.method ?? "GET"} ${url}`)
            ?.shift();
        if (pending) return pending;
        if (url === "/api/access/subjects/A") return Response.json(detail("A"));
        if (url === "/api/access/subjects/B") return Response.json(detail("B"));
        throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("access detail selection generations", () => {
    it.each([
        "success",
        "failure",
    ])("discards A's late %s after B's detail and history load", async (result) => {
        const first = enqueue("A");
        render(<AccessSection />);
        await select("A");
        await select("B");
        await screen.findByRole("button", { name: "Reload" });
        await finish(
            first,
            result === "success"
                ? detail("A")
                : {
                      code: "REAUTHENTICATION_REQUIRED",
                      error: "Expired",
                  },
            result === "success" ? 200 : 401,
        );
        expectB();
        expect(toast.error).not.toHaveBeenCalled();
        expect(
            screen.queryByRole("button", {
                name: "Sign in again to manage access.",
            }),
        ).toBeNull();
    });

    it("discards an earlier selection of A even after A is selected again", async () => {
        const first = enqueue("A");
        render(<AccessSection />);
        await select("A");
        await select("B");
        await screen.findByRole("button", { name: "Reload" });
        await select("A");
        await screen.findByText(/A history$/);
        await finish(first, detail("A", "Obsolete history"));
        expect(screen.getByText(/A history$/)).toBeTruthy();
        expect(screen.queryByText(/Obsolete history$/)).toBeNull();
    });

    it.each([
        "success",
        "failure",
    ])("discards an older reload's %s for the same selection", async (result) => {
        render(<AccessSection />);
        await select("A");
        const reload = await screen.findByRole("button", { name: "Reload" });
        const first = enqueue("A");
        fireEvent.click(reload);
        fireEvent.click(reload);
        await act(async () => {});
        await finish(
            first,
            result === "success"
                ? detail("A", "Obsolete history")
                : { error: "Obsolete failure" },
            result === "success" ? 200 : 500,
        );
        expect(screen.getByText(/A history$/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
        expect(screen.queryByText(/Obsolete history$/)).toBeNull();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it.each([
        "success",
        "failure with access",
        "failure without access",
    ])("preserves B and still reports A's pending write when it returns %s", async (result) => {
        render(<AccessSection />);
        await select("A");
        const toggle = await screen.findByRole("switch", {
            name: "Manages access",
        });
        const write = enqueue("A", "PATCH");
        fireEvent.click(toggle);
        await select("B");
        await screen.findByRole("button", { name: "Reload" });
        await finish(
            write,
            result === "success"
                ? {
                      access: person("A"),
                      status: "applied",
                      stillEffective: [],
                      revocation: "done",
                  }
                : {
                      error: "Expired",
                      code: "REAUTHENTICATION_REQUIRED",
                      details:
                          result === "failure with access"
                              ? { access: person("A") }
                              : undefined,
                  },
            result === "success" ? 200 : 401,
        );
        expectB();
        expect(
            fetchMock.mock.calls.filter(
                ([url, init]) =>
                    url === "/api/access/subjects/A" && !init?.method,
            ),
        ).toHaveLength(1);
        if (result === "success") {
            expect(toast.success).toHaveBeenCalledWith("Access changed");
            expect(toast.error).not.toHaveBeenCalled();
        } else {
            expect(toast.error).toHaveBeenCalledOnce();
            expect(
                screen.getByRole("button", {
                    name: "Sign in again to manage access.",
                }),
            ).toBeTruthy();
        }
    });

    it("reports an old write failure but keeps the detail after returning to the same person", async () => {
        render(<AccessSection />);
        await select("A");
        const toggle = await screen.findByRole("switch", {
            name: "Manages access",
        });
        const write = enqueue("A", "PATCH");
        fireEvent.click(toggle);
        await select("B");
        await select("A");
        await screen.findByText(/A history$/);
        await finish(
            write,
            {
                code: "REAUTHENTICATION_REQUIRED",
                error: "Obsolete failure",
                details: { access: { ...person("A"), enabled: false } },
            },
            401,
        );
        expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
        expect(
            screen.queryByText(
                "This account is disabled at the identity provider.",
            ),
        ).toBeNull();
        expect(toast.error).toHaveBeenCalledOnce();
    });

    it.each([
        "success",
        "failure",
    ])("discards A's mutation-triggered refresh %s after selecting B", async (result) => {
        render(<AccessSection />);
        await select("A");
        const toggle = await screen.findByRole("switch", {
            name: "Manages access",
        });
        const write = enqueue("A", "PATCH");
        fireEvent.click(toggle);
        const refresh = enqueue("A");
        await finish(write, {
            access: person("A"),
            status: "applied",
            stillEffective: [],
            revocation: "done",
        });
        await select("B");
        await screen.findByRole("button", { name: "Reload" });
        await finish(
            refresh,
            result === "success" ? detail("A") : { error: "Obsolete failure" },
            result === "success" ? 200 : 500,
        );
        expectB();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it.each([
        "success",
        "failure",
    ])("reports but does not refresh A after its pending session write returns %s while B is selected", async (result) => {
        render(<AccessSection />);
        await select("A");
        const end = await screen.findByRole("button", { name: "End sessions" });
        const write = enqueue("A/revoke-sessions", "POST");
        fireEvent.click(end);
        await select("B");
        await screen.findByRole("button", { name: "Reload" });
        await finish(
            write,
            result === "success"
                ? { revocation: "done" }
                : { error: "Obsolete failure" },
            result === "success" ? 200 : 500,
        );
        expectB();
        expect(
            fetchMock.mock.calls.filter(
                ([url, init]) =>
                    url === "/api/access/subjects/A" && !init?.method,
            ),
        ).toHaveLength(1);
        if (result === "success")
            expect(toast.success).toHaveBeenCalledWith("Sessions ended");
        else expect(toast.error).toHaveBeenCalledOnce();
    });
});
