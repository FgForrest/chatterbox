import { beforeEach, expect, it, vi } from "vitest";
import StatisticsRoute from "@/app/(app)/statistics/page";
import { GET } from "@/app/api/statistics/route";
import { loadStatistics } from "@/db/queries/statistics";
import { TIME_ZONE_COOKIE } from "@/lib/i18n/time-zone";
import { requestTimeZone, userTimeZone } from "@/lib/i18n/user-time-zone";
import { statisticsFixture } from "./fixtures";

const cookie = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookie }) }));
vi.mock("next-intl/server", () => ({ getExtracted: vi.fn() }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/statistics/statistics-page", () => ({
    StatisticsPage: () => null,
}));
vi.mock("@/lib/auth-server", () => ({
    requireAuth: async () => ({ user: { id: "viewer" } }),
    requireApiSession: async () => ({ user: { id: "viewer" } }),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/i18n/user-time-zone", () => ({
    userTimeZone: vi.fn(),
    requestTimeZone: vi.fn(),
}));
vi.mock("@/db/queries/statistics", () => ({
    statisticsScopes: async () => ["mine"],
    loadStatistics: vi.fn(),
}));

beforeEach(() => {
    vi.clearAllMocks();
    cookie.mockReturnValue({ value: "Europe%2FPrague" });
    vi.mocked(userTimeZone).mockResolvedValue("Asia/Tokyo");
    vi.mocked(requestTimeZone).mockResolvedValue("Asia/Tokyo");
    vi.mocked(loadStatistics).mockResolvedValue(statisticsFixture());
});

it("uses the shared saved-preference resolver and browser hint for SSR", async () => {
    await StatisticsRoute();
    expect(cookie).toHaveBeenCalledWith(TIME_ZONE_COOKIE);
    expect(userTimeZone).toHaveBeenCalledWith("viewer", "Europe%2FPrague");
    expect(loadStatistics).toHaveBeenCalledWith("viewer", "mine", "Asia/Tokyo");
});

it("uses the shared request resolver when the API omits a zone", async () => {
    const request = new Request("http://localhost/api/statistics", {
        headers: { cookie: `${TIME_ZONE_COOKIE}=Europe%2FPrague` },
    });
    expect((await GET(request)).status).toBe(200);
    expect(requestTimeZone).toHaveBeenCalledWith("viewer", request);
    expect(loadStatistics).toHaveBeenCalledWith("viewer", "mine", "Asia/Tokyo");
});

it("keeps an explicit API zone for scope prefetches", async () => {
    const request = new Request(
        "http://localhost/api/statistics?tz=Europe%2FPrague",
    );
    expect((await GET(request)).status).toBe(200);
    expect(loadStatistics).toHaveBeenCalledWith(
        "viewer",
        "mine",
        "Europe/Prague",
    );
    expect(requestTimeZone).not.toHaveBeenCalled();
});
