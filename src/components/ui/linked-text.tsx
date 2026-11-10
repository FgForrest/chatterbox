import { splitTextLinks } from "@/lib/text/links";

/** Render plain text with shortened, keyboard-accessible web links. */
export function LinkedText({ text }: { text: string }) {
    const segments = splitTextLinks(text);
    if (!segments.some((segment) => segment.type === "link")) return text;
    return segments.map((segment) =>
        segment.type === "link" ? (
            <a
                key={segment.start}
                data-text-start={segment.start}
                href={segment.href}
                title={segment.text}
                target="_blank"
                rel="noopener noreferrer"
                className="break-words rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
                {segment.label}
            </a>
        ) : (
            <span key={segment.start} data-text-start={segment.start}>
                {segment.text}
            </span>
        ),
    );
}
