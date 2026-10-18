import type React from "react";
import { productName } from "@/lib/brand";
import { env } from "@/lib/env";
import {
    Body,
    Container,
    Head,
    Html,
    Img,
    Link,
    Preview,
    Section,
    Text,
} from "../email-components";
import { getEmailLocale, getEmailTranslator } from "../email-template-i18n";
import { emailStyles } from "./styles";

interface EmailLayoutProps {
    /** First-line snippet shown in inbox list previews. */
    previewText: string;
    /** Optional small footer link below the main copy. */
    footerLink?: { href: string; label: string };
    /** Body content. */
    children: React.ReactNode;
}

/** Shared chrome for all application-sent emails. */
export function EmailLayout({
    previewText,
    footerLink,
    children,
}: EmailLayoutProps) {
    const i18n = getEmailTranslator();
    const name = env.IS_HOSTED ? "Riffado" : productName(getEmailLocale());
    const logoUrl = new URL(
        "/logo.png",
        env.APP_URL ?? "http://localhost:3000",
    ).toString();
    return (
        <Html>
            <Head>
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1.0"
                />
                <meta name="color-scheme" content="light" />
                <meta name="supported-color-schemes" content="light" />
            </Head>
            <Preview>{previewText}</Preview>
            <Body style={emailStyles.main}>
                <Container style={emailStyles.container}>
                    <Section style={emailStyles.header}>
                        <div style={{ textAlign: "center" }}>
                            <Img
                                src={logoUrl}
                                alt={name}
                                width="32"
                                height="32"
                                style={emailStyles.logo}
                            />
                        </div>
                    </Section>

                    <Section style={emailStyles.content}>{children}</Section>

                    <Section style={emailStyles.footer}>
                        {footerLink ? (
                            <Text style={emailStyles.footerText}>
                                <Link
                                    href={footerLink.href}
                                    style={emailStyles.link}
                                >
                                    {footerLink.label}
                                </Link>
                            </Text>
                        ) : null}
                        <Text style={emailStyles.footerText}>
                            {i18n(
                                "{name}. Your recordings, your transcripts.",
                                { name },
                            )}
                        </Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
}
