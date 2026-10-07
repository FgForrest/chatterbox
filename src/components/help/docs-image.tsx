"use client";

import type { ImageProps } from "fumadocs-core/framework";
import Image from "next/image";

/**
 * Images in the docs, served as they are rather than through the image
 * service, which cannot reach a private instance.
 */
export function DocsImage({
    src,
    alt = "",
    width,
    height,
    ...props
}: ImageProps) {
    if (!src) return null;
    return (
        <Image
            {...props}
            src={src}
            alt={alt}
            width={width === undefined ? undefined : Number(width)}
            height={height === undefined ? undefined : Number(height)}
            unoptimized
        />
    );
}
