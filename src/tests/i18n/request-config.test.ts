import { beforeEach, expect, it, vi } from "vitest";
import { resolveTimeZone } from "@/lib/i18n/time-zone";

const mocks = vi.hoisted(() => ({
    locale: null as string | null,
    zone: "Europe%2FPrague" as string | undefined,
    language: "cs-CZ,cs;q=0.9,en;q=0.8",
}));
vi.mock("next/headers", () => ({
    headers: async () => new Headers({ "accept-language": mocks.language }),
    cookies: async () => ({
        get: () => (mocks.zone ? { value: mocks.zone } : undefined),
    }),
}));
vi.mock("@/lib/auth-server", () => ({
    getSession: async () => ({ user: { uiLocale: mocks.locale } }),
}));
vi.mock("@/lib/i18n/user-time-zone", () => ({
    userTimeZone: async (
        _userId: string | undefined,
        cookie: string | undefined,
    ) => resolveTimeZone({ cookie }),
}));

vi.mock("next-intl/server", () => ({
    getRequestConfig: (callback: () => unknown) => callback,
}));

import requestConfig from "@/i18n/request";

beforeEach(() => {
    mocks.locale = null;
    mocks.zone = "Europe%2FPrague";
    mocks.language = "cs-CZ,cs;q=0.9,en;q=0.8";
});
it("combines the browser-resolved Czech locale and validated viewer time zone", async () => {
    expect(
        await requestConfig({ requestLocale: Promise.resolve(undefined) }),
    ).toMatchObject({ locale: "cs-CZ", timeZone: "Europe/Prague" });
});
it("keeps a stored locale ahead of Accept-Language and falls back to UTC for invalid cookies", async () => {
    mocks.locale = "en";
    mocks.zone = "Invalid/Zone";
    expect(
        await requestConfig({ requestLocale: Promise.resolve(undefined) }),
    ).toMatchObject({ locale: "en", timeZone: "UTC" });
});
it("uses UTC when no cookie exists", async () => {
    mocks.zone = undefined;
    expect(
        await requestConfig({ requestLocale: Promise.resolve(undefined) }),
    ).toMatchObject({ locale: "cs-CZ", timeZone: "UTC" });
});
