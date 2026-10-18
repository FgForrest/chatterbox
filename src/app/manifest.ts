import type { MetadataRoute } from "next";
import { deploymentProductName } from "@/lib/deployment-brand";
import { defaultLocale } from "@/lib/i18n/config";

export default function manifest(): MetadataRoute.Manifest {
    const name = deploymentProductName(defaultLocale);
    return {
        name,
        short_name: name,
        description:
            "Open-source AI transcription for the voice recorder you already own.",
        start_url: "/",
        display: "standalone",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        icons: [
            {
                src: "/icon-192.png",
                sizes: "192x192",
                type: "image/png",
                purpose: "any",
            },
            {
                src: "/icon-512.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "any",
            },
        ],
    };
}
