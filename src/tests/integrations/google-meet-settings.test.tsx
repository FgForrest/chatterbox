import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useExtracted: () => (text: string) => text }));
vi.mock("@/components/integrations/google-connection-panel", () => ({
    GoogleConnectionPanel: () => null,
}));
vi.mock("@/hooks/use-google-connection", () => ({
    useGoogleConnection: vi.fn(),
    useGoogleConnectOutcome: vi.fn(),
}));

import { GoogleAccountSection } from "@/components/settings-sections/google-account-section";
import { useGoogleConnection } from "@/hooks/use-google-connection";

describe("Google Meet settings consent", () => {
    beforeEach(() => {
        vi.mocked(useGoogleConnection).mockReturnValue({
            state: {
                available: false,
                calendarAvailable: true,
                meetAvailable: true,
                connection: {
                    email: "a@example.com",
                    hostedDomain: null,
                    status: "active",
                    calendarGranted: true,
                    meetGranted: false,
                },
            },
            loading: false,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
    });

    it("offers a separate Meet consent action on an active Google account", () => {
        const html = renderToStaticMarkup(<GoogleAccountSection />);
        expect(html).toContain("Google Meet for Learn");
        expect(html).toContain("Connect Meet");
        expect(html).toContain("attended a selected Google Meet call");
    });

    it("prevents Meet consent before a Google account is connected", () => {
        vi.mocked(useGoogleConnection).mockReturnValue({
            state: {
                available: false,
                meetAvailable: true,
                connection: null,
            },
            loading: false,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        const html = renderToStaticMarkup(<GoogleAccountSection />);
        expect(html).toMatch(/disabled=""[^>]*>Connect Meet</);
    });
});
