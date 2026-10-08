import { createRelativeLink } from "fumadocs-ui/mdx";
import {
    DocsBody,
    DocsDescription,
    DocsPage,
    DocsTitle,
} from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import type { ComponentProps } from "react";
import { normalizeDocsHref } from "@/lib/docs-links";
import { env } from "@/lib/env";
import { defaultLocale } from "@/lib/i18n/config";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

interface PageProps {
    params: Promise<{ slug?: string[] }>;
}

export default async function Page({ params }: PageProps) {
    const [{ slug }, locale] = await Promise.all([params, getLocale()]);
    const page = source.getPage(slug, locale);
    if (!page) notFound();

    const MDX = page.data.body;
    const lastModified = page.data.lastModified;
    const [owner, repo] = env.DOCS_REPOSITORY.split("/");
    const RelativeLink = createRelativeLink(source, page);
    const Link = ({ href, ...props }: ComponentProps<"a">) => (
        <RelativeLink href={href ? normalizeDocsHref(href) : href} {...props} />
    );

    return (
        <DocsPage
            toc={page.data.toc}
            full={page.data.full}
            editOnGithub={{
                owner,
                repo,
                sha: "main",
                path: `content/docs/${page.path}`,
            }}
            lastUpdate={lastModified}
        >
            <DocsTitle>{page.data.title}</DocsTitle>
            <DocsDescription>{page.data.description}</DocsDescription>
            <DocsBody>
                <MDX components={getMDXComponents({ a: Link })} />
            </DocsBody>
        </DocsPage>
    );
}

export function generateStaticParams() {
    return source.getPages(defaultLocale).map((page) => ({ slug: page.slugs }));
}

export async function generateMetadata({
    params,
}: PageProps): Promise<Metadata> {
    const [{ slug }, locale] = await Promise.all([params, getLocale()]);
    const page = source.getPage(slug, locale);
    if (!page) notFound();

    const ogSegments = (page.slugs.length ? page.slugs : ["index"]).join("/");
    const ogLocale = locale === defaultLocale ? "" : `${locale}/`;
    const ogImage = `/docs-og/${ogLocale}${ogSegments}.png`;

    return {
        title: page.data.title,
        description: page.data.description,
        openGraph: {
            title: page.data.title,
            description: page.data.description,
            type: "article",
            images: [ogImage],
        },
        twitter: {
            card: "summary_large_image",
            title: page.data.title,
            description: page.data.description,
            images: [ogImage],
        },
    };
}
