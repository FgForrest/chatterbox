// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    noteDashboardUrlChange,
    useDashboardRefresh,
} from "@/hooks/use-dashboard-refresh";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("dashboard refresh after native selection", () => {
    it.each([
        "/dashboard",
        "/dev/demo-dashboard",
    ])("replaces without scrolling before a full refresh after native selection on %s", (path) => {
        window.history.replaceState({}, "", path);
        const { result } = renderHook(useDashboardRefresh);
        window.history.pushState(
            { mobileView: "detail" },
            "",
            `${path}?folder=work&recording=selected&view=org#summary`,
        );
        noteDashboardUrlChange();
        result.current();
        expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(
            `${path}?folder=work&recording=selected&view=org`,
            { scroll: false },
        );
        expect(router.replace.mock.invocationCallOrder[0]).toBeLessThan(
            router.refresh.mock.invocationCallOrder[0],
        );
        expect(window.history.state.mobileView).toBe("detail");
        vi.clearAllMocks();
        result.current();
        expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it("only refreshes when the URL has not changed natively", () => {
        window.history.replaceState({}, "", "/dashboard?recording=first");
        const { result } = renderHook(useDashboardRefresh);
        result.current();
        expect(router.refresh).toHaveBeenCalledExactlyOnceWith();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it("shares native selection tracking across refresh callers", () => {
        window.history.replaceState({}, "", "/dashboard?recording=first");
        const first = renderHook(useDashboardRefresh);
        const second = renderHook(useDashboardRefresh);
        window.history.replaceState({}, "", "/dashboard?recording=second");
        noteDashboardUrlChange();
        second.result.current();
        first.result.current();
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(
            "/dashboard?recording=second",
            { scroll: false },
        );
        expect(router.refresh).toHaveBeenCalledTimes(2);
    });

    it("keeps full refresh semantics after leaving the dashboard", () => {
        window.history.replaceState({}, "", "/dashboard?recording=first");
        noteDashboardUrlChange();
        const { result } = renderHook(useDashboardRefresh);
        window.history.replaceState({}, "", "/tasks");
        result.current();
        expect(router.refresh).toHaveBeenCalledOnce();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it.each([
        "/tasks",
        "/dev/demo-dashboard?recording=another-entry",
    ])("does not consume the pending URL when refreshing %s", (otherUrl) => {
        window.history.replaceState({}, "", "/dashboard?recording=pending");
        noteDashboardUrlChange();
        const { result } = renderHook(useDashboardRefresh);
        window.history.pushState({}, "", otherUrl);
        result.current();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.refresh).toHaveBeenCalledOnce();

        window.history.replaceState({}, "", "/dashboard?recording=pending");
        vi.clearAllMocks();
        result.current();
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(
            "/dashboard?recording=pending",
            { scroll: false },
        );
        expect(router.replace.mock.invocationCallOrder[0]).toBeLessThan(
            router.refresh.mock.invocationCallOrder[0],
        );
        expect(router.refresh).toHaveBeenCalledOnce();
    });

    it("tracks dashboard traversal while the workstation is unmounted on another page", async () => {
        window.history.replaceState({}, "", "/dashboard?recording=returning");
        noteDashboardUrlChange();
        const { result } = renderHook(useDashboardRefresh);
        result.current();
        window.history.pushState({}, "", "/tasks");
        vi.clearAllMocks();

        await act(async () => {
            const popped = new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
            window.history.back();
            await popped;
        });
        result.current();
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(
            "/dashboard?recording=returning",
            { scroll: false },
        );
        expect(router.replace.mock.invocationCallOrder[0]).toBeLessThan(
            router.refresh.mock.invocationCallOrder[0],
        );
        vi.clearAllMocks();
        result.current();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.refresh).toHaveBeenCalledOnce();

        await act(async () => {
            const popped = new Promise((resolve) =>
                window.addEventListener("popstate", resolve, { once: true }),
            );
            window.history.forward();
            await popped;
        });
        vi.clearAllMocks();
        result.current();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.refresh).toHaveBeenCalledOnce();
    });
});
