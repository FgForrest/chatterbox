// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { localizeDocument } from "../../../extensions/recorder/lib/i18n.js";

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

it.each([
    ["en", "Another agenda…", "Close panel"],
    ["cs", "Jiná agenda…", "Zavřít panel"],
])("labels the agenda navigation actions in %s", (locale, other, close) => {
    const messages = JSON.parse(
        readFileSync(
            `extensions/recorder/_locales/${locale}/messages.json`,
            "utf8",
        ),
    );
    vi.stubGlobal("chrome", {
        i18n: {
            getUILanguage: () => locale,
            getMessage: (key) => messages[key]?.message ?? "",
        },
    });
    document.documentElement.innerHTML = readFileSync(
        "extensions/recorder/agenda/agenda.html",
        "utf8",
    );
    localizeDocument();
    expect(document.getElementById("other").textContent).toBe(other);
    expect(document.getElementById("close-panel").textContent).toBe(close);
});
