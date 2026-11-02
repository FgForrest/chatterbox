// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWatcher } from "@/components/auth/session-watcher";
import {
    clearSsoReturnPath,
    recalledSsoReturnPath,
    rememberSsoReturnPath,
} from "@/lib/auth/return-path";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession } }));
vi.mock("next/link", () => ({ default: vi.fn() }));

const originalFetch = window.fetch;
const now = new Date("2026-01-01T00:00:00Z").getTime();
const expiry = (delay: number) => new Date(now + delay).toISOString();

async function advance(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

async function visible() {
    await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    getSession.mockReset();
    clearSsoReturnPath();
    vi.mocked(Link).mockClear();
    getSession.mockResolvedValue({ data: null, error: null });
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
    window.fetch = vi.fn().mockImplementation(() => {
        const response = Response.json(
            { code: "AUTH_SESSION_MISSING" },
            { status: 401 },
        );
        vi.spyOn(response, "clone").mockImplementation(() =>
            Response.json({ code: "AUTH_SESSION_MISSING" }, { status: 401 }),
        );
        return Promise.resolve(response);
    });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.fetch = originalFetch;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
});

describe("SessionWatcher", () => {
    it("checks exactly at expiresAt and opens one prompt for a confirmed missing session", async () => {
        render(<SessionWatcher expiresAt={expiry(5_000)} />);
        await advance(4_999);
        expect(getSession).not.toHaveBeenCalled();
        await advance(1);
        expect(getSession).toHaveBeenCalledWith({
            query: { disableCookieCache: true },
        });
        expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
        expect(screen.getByText("Your sign-in has expired")).toBeTruthy();
        await act(async () => {
            await window.fetch("/api/tasks");
        });
        expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    });

    it.each([
        "network",
        "server",
    ])("does not expire the session on a %s failure", async (failure) => {
        if (failure === "network")
            getSession.mockRejectedValue(new TypeError("Network unavailable"));
        else
            getSession.mockResolvedValue({
                data: null,
                error: { status: 503 },
            });
        render(<SessionWatcher expiresAt={expiry(1_000)} />);
        await advance(1_000);
        expect(screen.queryByRole("alertdialog")).toBeNull();
        await advance(120_000);
        expect(getSession).toHaveBeenCalledTimes(1);
    });

    it("throttles visible and online checks together and ignores hidden tabs", async () => {
        getSession.mockResolvedValue({
            data: { session: { expiresAt: expiry(600_000) } },
            error: null,
        });
        render(<SessionWatcher expiresAt={expiry(600_000)} />);
        Object.defineProperty(document, "visibilityState", { value: "hidden" });
        await visible();
        expect(getSession).not.toHaveBeenCalled();
        Object.defineProperty(document, "visibilityState", {
            value: "visible",
        });
        await visible();
        await visible();
        await act(async () => {
            window.dispatchEvent(new Event("online"));
        });
        expect(getSession).toHaveBeenCalledTimes(1);
        await advance(59_999);
        await visible();
        expect(getSession).toHaveBeenCalledTimes(1);
        await advance(1);
        await act(async () => {
            window.dispatchEvent(new Event("online"));
        });
        expect(getSession).toHaveBeenCalledTimes(2);
    });

    it("replaces the original deadline with a refreshed expiresAt", async () => {
        getSession.mockResolvedValueOnce({
            data: { session: { expiresAt: expiry(10_000) } },
            error: null,
        });
        render(<SessionWatcher expiresAt={expiry(1_000)} />);
        await advance(1_000);
        expect(screen.queryByRole("alertdialog")).toBeNull();
        await advance(8_999);
        expect(getSession).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(getSession).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("alertdialog")).toBeTruthy();
    });

    it("closes the prompt when a successful check confirms the session again", async () => {
        render(<SessionWatcher expiresAt={expiry(1_000)} />);
        await advance(1_000);
        expect(screen.getByRole("alertdialog")).toBeTruthy();
        getSession.mockResolvedValue({
            data: { session: { expiresAt: expiry(600_000) } },
            error: null,
        });
        await advance(60_000);
        await visible();
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("retries clock-skewed expiry with bounded backoff", async () => {
        getSession.mockResolvedValue({
            data: { session: { expiresAt: expiry(-1_000) } },
            error: null,
        });
        render(<SessionWatcher expiresAt={expiry(1_000)} />);
        await advance(1_000);
        expect(getSession).toHaveBeenCalledTimes(1);
        await advance(29_999);
        expect(getSession).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(getSession).toHaveBeenCalledTimes(2);
        await advance(60_000);
        expect(getSession).toHaveBeenCalledTimes(3);
        await advance(120_000);
        expect(getSession).toHaveBeenCalledTimes(4);
        await advance(600_000);
        expect(getSession).toHaveBeenCalledTimes(4);
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("resumes normal checks when a skew retry returns a future expiry", async () => {
        getSession
            .mockResolvedValueOnce({
                data: { session: { expiresAt: expiry(-1_000) } },
                error: null,
            })
            .mockResolvedValueOnce({
                data: { session: { expiresAt: expiry(40_000) } },
                error: null,
            });
        render(<SessionWatcher expiresAt={expiry(1_000)} />);
        await advance(31_000);
        expect(getSession).toHaveBeenCalledTimes(2);
        await advance(9_000);
        expect(getSession).toHaveBeenCalledTimes(3);
        expect(screen.getByRole("alertdialog")).toBeTruthy();
    });

    it("clears the SSO retry destination when an authenticated page starts", () => {
        rememberSsoReturnPath("/tasks?x=1");
        render(<SessionWatcher expiresAt={expiry(600_000)} />);
        expect(recalledSsoReturnPath()).toBe("/dashboard");
    });

    it("caps long timers without checking early", async () => {
        const maxDelay = 2_147_483_647;
        render(<SessionWatcher expiresAt={expiry(maxDelay + 5_000)} />);
        await advance(maxDelay);
        expect(getSession).not.toHaveBeenCalled();
        await advance(5_000);
        expect(getSession).toHaveBeenCalledTimes(1);
    });

    it("lets Later preserve the page and reopens on the next definite signal", async () => {
        render(<SessionWatcher expiresAt={expiry(600_000)} />);
        await act(async () => {
            await window.fetch("/api/tasks");
        });
        fireEvent.click(screen.getByRole("button", { name: "Later" }));
        expect(screen.queryByRole("alertdialog")).toBeNull();
        await act(async () => {
            await window.fetch("/api/tasks");
        });
        expect(screen.getByRole("alertdialog")).toBeTruthy();
    });

    it("offers sign-in with the current path, query and fragment", async () => {
        window.history.replaceState(null, "", "/dashboard?x=1#notes");
        render(<SessionWatcher expiresAt={expiry(1_000)} />);
        await advance(1_000);
        const link = screen.getByRole("link", { name: "Sign in again" });
        expect(Link).not.toHaveBeenCalled();
        expect(link.getAttribute("href")).toBe(
            "/login?returnTo=%2Fdashboard%3Fx%3D1%23notes",
        );
        expect(
            screen.getByText(/Unsaved edits on this page may be lost/),
        ).toBeTruthy();
        document.addEventListener("click", (event) => event.preventDefault(), {
            once: true,
        });
        fireEvent.click(link);
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("restores fetch and removes timers and listeners on unmount", async () => {
        const fetchBeforeMount = window.fetch;
        const view = render(<SessionWatcher expiresAt={expiry(1_000)} />);
        view.unmount();
        expect(window.fetch).toBe(fetchBeforeMount);
        await advance(120_000);
        await visible();
        expect(getSession).not.toHaveBeenCalled();
    });

    it("ignores a session check that completes after unmount", async () => {
        let resolve: (result: {
            data: { session: { expiresAt: string } };
            error: null;
        }) => void = () => {};
        getSession.mockImplementation(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const view = render(<SessionWatcher expiresAt={expiry(1_000)} />);
        await advance(1_000);
        view.unmount();
        await act(async () => {
            resolve({
                data: { session: { expiresAt: expiry(600_000) } },
                error: null,
            });
        });
        expect(vi.getTimerCount()).toBe(0);
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });
});
