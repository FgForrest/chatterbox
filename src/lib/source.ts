import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { defaultLocale, locales } from "@/lib/i18n/config";

const docsI18n = {
    languages: [...locales],
    defaultLanguage: defaultLocale,
    hideLocale: "always" as const,
};

// `baseUrl` must match the route group mount (`src/app/(docs)/docs`).
export const source = loader({
    baseUrl: "/docs",
    i18n: docsI18n,
    source: docs.toFumadocsSource(),
});

/** The same pages under `/help`, the chrome-less view the help drawer frames. */
export const helpSource = loader({
    baseUrl: "/help",
    i18n: docsI18n,
    source: docs.toFumadocsSource(),
});

/** The user guide's chapters in sidebar order, as `/help` links. */
export function userGuideChapters(locale: string = defaultLocale): {
    name: string;
    url: string;
}[] {
    const folder = helpSource
        .getPageTree(locale)
        .children.find(
            (node) =>
                node.type === "folder" &&
                node.index?.url === "/help/user-guide",
        );
    if (folder?.type !== "folder" || !folder.index) return [];
    return [folder.index, ...folder.children].flatMap((node) =>
        node.type === "page"
            ? [{ name: String(node.name), url: node.url }]
            : [],
    );
}
