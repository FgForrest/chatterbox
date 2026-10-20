import { t } from "./i18n.js";

/** Browser and platform names used by the visible microphone instructions. */
export function setupBrowserInfo(nav = navigator) {
    const brands = nav.userAgentData?.brands?.map((entry) => entry.brand) ?? [];
    const ua = nav.userAgent ?? "";
    const browser =
        brands.some((brand) => /Brave/i.test(brand)) ||
        /Brave\//.test(ua) ||
        nav.brave
            ? "brave"
            : brands.some((brand) => /Microsoft Edge/i.test(brand)) ||
                /Edg\//.test(ua)
              ? "edge"
              : brands.includes("Google Chrome") || /Chrome\//.test(ua)
                ? "chrome"
                : "chromium";
    const platform = nav.userAgentData?.platform || nav.platform || ua;
    return {
        browser,
        name: {
            chrome: "Google Chrome",
            edge: "Microsoft Edge",
            brave: "Brave",
            chromium: "Chromium",
        }[browser],
        platform: /Mac/i.test(platform)
            ? "mac"
            : /Win/i.test(platform)
              ? "windows"
              : "other",
    };
}

/** Chrome's verified labels; other browsers use neutral instructions. */
export function microphonePromptCopy(info = setupBrowserInfo()) {
    return {
        intro: t(
            info.browser === "chrome" ? "setupMicChrome" : "setupMicNeutral",
            info.name,
        ),
        permanent: t(
            info.browser === "chrome"
                ? "micAllowPermanent"
                : "micPermanentNeutral",
        ),
        temporary: t(
            info.browser === "chrome" ? "micAllowOnce" : "micTemporaryNeutral",
        ),
        deny: t(info.browser === "chrome" ? "micNeverAllow" : "micDenyNeutral"),
        hint: t(
            info.browser === "chrome"
                ? "setupMicTemporary"
                : "setupMicTemporaryNeutral",
        ),
    };
}

/** OS refusal is distinguishable from the browser's generic NotAllowedError. */
export function setupMicrophoneFailure(error, info = setupBrowserInfo()) {
    if (
        error?.name === "NotAllowedError" &&
        /permission denied by system/i.test(error.message ?? "")
    ) {
        return t(
            info.platform === "mac"
                ? "micSystemMac"
                : info.platform === "windows"
                  ? "micSystemWindows"
                  : "micSystemOther",
            info.name,
        );
    }
    if (/policy|administrator|managed/i.test(error?.message ?? ""))
        return t("micManaged", info.name);
    return null;
}
