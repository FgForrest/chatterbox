import { afterEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({ envMock: { IS_HOSTED: false } }));

vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
    },
}));
vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
}));
vi.mock("next-intl/server", () => ({
    getExtracted: async () => (message: string) => message,
}));
vi.mock("@/components/landing/landing-nav", () => ({ LandingNav: () => null }));
vi.mock("@/components/landing-footer", () => ({ LandingFooter: () => null }));
vi.mock("@/components/marketing/newsletter-form", () => ({
    NewsletterForm: () => null,
}));

import RebrandPage from "@/app/rebrand/page";
import UpdatesPage from "@/app/updates/page";

afterEach(() => {
    envMock.IS_HOSTED = false;
});

describe.each([
    ["/rebrand", RebrandPage],
    ["/updates", UpdatesPage],
])("%s", (_path, Page) => {
    it("is not found on self-host", () => {
        expect(() => Page()).toThrow("NEXT_NOT_FOUND");
    });

    it("renders on hosted", () => {
        envMock.IS_HOSTED = true;
        expect(Page()).toBeTruthy();
    });
});
