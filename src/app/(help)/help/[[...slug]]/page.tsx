import { createRelativeLink } from "fumadocs-ui/mdx";
import { DocsBody } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import type { ComponentProps } from "react";
import { HelpChapterPicker } from "@/components/help/help-chapter-picker";
import { normalizeDocsHref } from "@/lib/docs-links";
import { defaultLocale } from "@/lib/i18n/config";
import { helpSource, userGuideChapters } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

interface PageProps {
    params: Promise<{ slug?: string[] }>;
}

export default async function HelpPage({ params }: PageProps) {
    const [{ slug }, locale] = await Promise.all([params, getLocale()]);
    const page = helpSource.getPage(slug, locale);
    if (!page) notFound();

    const MDX = page.data.body;
    const RelativeLink = createRelativeLink(helpSource, page);
    // Pages within the docs stay in the frame; anything else opens a tab.
    const Link = ({ href = "", ...props }: ComponentProps<"a">) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            return <a href={href} target="_blank" rel="noopener" {...props} />;
        }
        return (
            <RelativeLink
                href={normalizeDocsHref(
                    href.replace(/^\/docs(?=\/|$|#)/, "/help"),
                )}
                {...props}
            />
        );
    };
    const chapters = userGuideChapters(locale);

    return (
        <article
            data-help-page=""
            data-help-title={page.data.title}
            className="mx-auto w-full max-w-3xl px-5 pb-10"
        >
            {chapters.some((chapter) => chapter.url === page.url) ? (
                <HelpChapterPicker chapters={chapters} current={page.url} />
            ) : null}
            <h1 className="mt-5 text-2xl font-semibold">{page.data.title}</h1>
            {page.data.description ? (
                <p className="mt-2 text-fd-muted-foreground">
                    {page.data.description}
                </p>
            ) : null}
            <DocsBody className="mt-6">
                <MDX components={getMDXComponents({ a: Link })} />
            </DocsBody>
        </article>
    );
}

export function generateStaticParams() {
    return helpSource
        .getPages(defaultLocale)
        .map((page) => ({ slug: page.slugs }));
}

export async function generateMetadata({
    params,
}: PageProps): Promise<Metadata> {
    const [{ slug }, locale] = await Promise.all([params, getLocale()]);
    const page = helpSource.getPage(slug, locale);
    if (!page) notFound();
    return {
        title: page.data.title,
        robots: { index: false },
    };
}
