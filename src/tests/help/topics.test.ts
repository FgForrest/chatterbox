import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableOfContents } from "fumadocs-core/content/toc";
import { describe, expect, it } from "vitest";
import {
    HELP_TOPICS,
    type HelpTopic,
    helpTarget,
    helpUrl,
    topicForLocation,
} from "@/lib/help/topics";

const GUIDE = join(process.cwd(), "content/docs/user-guide");

const at = (pathname: string, search = "", hash = "") =>
    topicForLocation({ pathname, search, hash });

describe("topicForLocation", () => {
    it("opens the chapter about the screen", () => {
        expect(at("/dashboard")).toBe("recordings");
        expect(at("/dashboard", "?recording=r1")).toBe("transcripts");
        expect(at("/dashboard", "?folder=f1")).toBe("recordings.folders");
        expect(at("/recordings/r1")).toBe("transcripts");
        expect(at("/tasks", "?tab=tracked")).toBe("tasks.page");
        expect(at("/almanac")).toBe("almanac.people");
        expect(at("/almanac/p1")).toBe("almanac.people");
        expect(at("/almanac/things/e1")).toBe("almanac.things");
        expect(at("/almanac/vocabulary")).toBe("almanac.vocabulary");
        expect(at("/almanac/review")).toBe("almanac.review");
    });

    it("follows the open settings section", () => {
        expect(at("/settings", "", "#summary")).toBe("settings.summary");
        expect(at("/settings", "", "#storage")).toBe("settings.storage");
        expect(at("/settings")).toBe("settings.providers");
        expect(at("/settings", "", "#nonsense")).toBe("settings.providers");
    });

    it("falls back to the guide's first page", () => {
        expect(at("/changelog")).toBe("guide");
    });
});

describe("helpUrl", () => {
    it("builds the drawer's and the full guide's address", () => {
        const target = helpTarget("tasks.review");
        expect(helpUrl(target, "/help")).toBe(
            "/help/user-guide/summaries-and-tasks#tasks-from-a-summary",
        );
        expect(helpUrl(target, "/docs")).toBe(
            "/docs/user-guide/summaries-and-tasks#tasks-from-a-summary",
        );
        expect(helpUrl(helpTarget("guide"), "/docs")).toBe("/docs/user-guide");
    });
});

describe("every topic leads to a page and heading of the guide", () => {
    for (const [topic, target] of Object.entries(HELP_TOPICS)) {
        it(topic, () => {
            const file = join(GUIDE, `${target.page}.md`);
            expect(existsSync(file), file).toBe(true);
            const anchor = (target as { anchor?: string }).anchor;
            if (!anchor) return;
            const headings = getTableOfContents(readFileSync(file, "utf8")).map(
                (item) => item.url,
            );
            expect(headings).toContain(`#${anchor}`);
        });
    }

    it("knows every settings section", () => {
        const topic: HelpTopic = "settings.google-account";
        expect(helpTarget(topic).anchor).toBe("to-google-drive");
    });
});
