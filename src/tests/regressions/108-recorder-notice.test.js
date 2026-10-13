import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveNoticeText } from "../../../extensions/recorder/lib/settings.js";

const localizedNotice =
    "Schůzky, které nahrávám v Klepně, se přepisují a shrnují.";

afterEach(() => vi.unstubAllGlobals());

describe("recorder notice precedence", () => {
    it("uses the localized notice for a server default", () => {
        vi.stubGlobal("chrome", {
            i18n: { getMessage: () => localizedNotice },
        });
        expect(
            effectiveNoticeText({
                noticeText: null,
                serverDefaults: {
                    noticeText:
                        "Meetings I record with Chatterbox are transcribed.",
                    noticeTextIsDefault: true,
                },
            }),
        ).toBe(localizedNotice);
    });

    it("keeps an administrator's custom server notice", () => {
        vi.stubGlobal("chrome", {
            i18n: { getMessage: () => localizedNotice },
        });
        expect(
            effectiveNoticeText({
                noticeText: null,
                serverDefaults: {
                    noticeText: "Administrator notice",
                    noticeTextIsDefault: false,
                },
            }),
        ).toBe("Administrator notice");
    });

    it("lets the user's notice override the server", () => {
        vi.stubGlobal("chrome", {
            i18n: { getMessage: () => localizedNotice },
        });
        expect(
            effectiveNoticeText({
                noticeText: "My notice",
                serverDefaults: {
                    noticeText: "Administrator notice",
                    noticeTextIsDefault: false,
                },
            }),
        ).toBe("My notice");
    });
});
