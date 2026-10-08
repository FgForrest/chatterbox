import Image from "next/image";

/** Compact Klepna mark for navigation and small brand placements. */
export function WaveformLogo({ className }: { className?: string }) {
    return (
        <Image
            src="/brand/klepna-icon.svg"
            alt=""
            aria-hidden="true"
            className={className}
            width={40}
            height={40}
            unoptimized
        />
    );
}
