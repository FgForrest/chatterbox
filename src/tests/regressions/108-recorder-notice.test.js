import { afterEach, describe, expect, it, vi } from "vitest";
import {
    customNoticeText,
    effectiveNoticeText,
} from "../../../extensions/recorder/lib/settings.js";

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

describe("#386 popup and panel participant notice", () => {
    it.each([
        [null, null, ""],
        [
            null,
            { noticeText: "Default from server", noticeTextIsDefault: true },
            "",
        ],
        [
            null,
            { noticeText: "Operator notice", noticeTextIsDefault: false },
            "Operator notice",
        ],
        [
            "User notice",
            { noticeText: "Operator notice", noticeTextIsDefault: false },
            "User notice",
        ],
        [
            null,
            {
                noticeText:
                    "Inform participants and obtain any required consent before recording.",
            },
            "",
        ],
        [
            null,
            {
                noticeText:
                    "Meetings I record with Chatterbox are transcribed and summarized. I will inform the other participants before recording.",
            },
            "",
        ],
        [
            null,
            {
                noticeText:
                    "Meetings I record with Riffado are transcribed and summarized. I will inform the other participants before recording.",
            },
            "",
        ],
        [
            null,
            { noticeText: "Legacy operator notice" },
            "Legacy operator notice",
        ],
        [
            "Inform participants and obtain any required consent before recording.",
            null,
            "Inform participants and obtain any required consent before recording.",
        ],
        [
            null,
            {
                noticeText:
                    "Inform participants and obtain any required consent before recording.",
                noticeTextIsDefault: false,
            },
            "Inform participants and obtain any required consent before recording.",
        ],
    ])("respects explicit customization (%s, %j)", (noticeText, serverDefaults, expected) => {
        expect(customNoticeText({ noticeText, serverDefaults })).toBe(expected);
    });
});
