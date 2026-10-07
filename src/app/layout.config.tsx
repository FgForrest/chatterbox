import type { DocsLayoutProps } from "fumadocs-ui/layouts/docs";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { env } from "@/lib/env";

export function createBaseOptions(docsTitle: string): BaseLayoutProps {
    return {
        nav: {
            title: docsTitle,
            url: "/docs",
        },
        githubUrl: `https://github.com/${env.DOCS_REPOSITORY}`,
    };
}

export function createDocsTabs(
    titles: readonly [string, string, string, string],
): NonNullable<DocsLayoutProps["tabs"]> {
    return [
        { title: titles[0], url: "/docs/user-guide" },
        { title: titles[1], url: "/docs/guides" },
        { title: titles[2], url: "/docs/self-hosting" },
        { title: titles[3], url: "/docs/reference" },
    ];
}
