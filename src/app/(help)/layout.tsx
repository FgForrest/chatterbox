import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { DocsImage } from "@/components/help/docs-image";
import "fumadocs-ui/style.css";
import "../(docs)/docs.css";

/** The docs without their navigation, for the app's help drawer to frame. */
export default function HelpLayout({ children }: { children: ReactNode }) {
    // theme.enabled: false so Fumadocs doesn't double-mount next-themes.
    return (
        <RootProvider
            theme={{ enabled: false }}
            search={{ enabled: false }}
            components={{ Image: DocsImage }}
        >
            {children}
        </RootProvider>
    );
}
