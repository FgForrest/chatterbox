import { redirect } from "next/navigation";
import { itemDetailHref } from "@/lib/item-detail";

type SearchParam = string | string[] | undefined;

interface RecordingDetailPageProps {
    params: Promise<{ id: string }>;
    searchParams: Promise<{
        view?: SearchParam;
        playFrom?: SearchParam;
        evidenceSegment?: SearchParam;
        evidenceStart?: SearchParam;
        evidenceEnd?: SearchParam;
    }>;
}

function first(value: SearchParam): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function RecordingDetailPage({
    params,
    searchParams,
}: RecordingDetailPageProps) {
    const [{ id }, query] = await Promise.all([params, searchParams]);
    redirect(
        itemDetailHref(id, {
            view: first(query.view) === "org" ? "org" : "private",
            playFrom: first(query.playFrom),
            evidenceSegment: first(query.evidenceSegment),
            evidenceStart: first(query.evidenceStart),
            evidenceEnd: first(query.evidenceEnd),
        }),
    );
}
