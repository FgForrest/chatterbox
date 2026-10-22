import { notFound } from "next/navigation";
import { getExtracted } from "next-intl/server";
import { CareQueue } from "@/components/almanac/care-queue";
import { requireAuth } from "@/lib/auth-server";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { listDuplicateCandidates } from "@/lib/knowledge/duplicates";

export const dynamic = "force-dynamic";

export default async function CarePage() {
    const session = await requireAuth();
    if (!(await userCuratesOrganizationNow(session.user.id))) notFound();
    const [initial, i18n] = await Promise.all([
        listDuplicateCandidates(session.user.id, { kind: "person" }),
        getExtracted(),
    ]);
    return (
        <section className="space-y-4">
            <div>
                <h1 className="text-xl font-semibold">{i18n("Care")}</h1>
                <p className="text-sm text-muted-foreground">
                    {i18n(
                        "Keep the Organization Almanac in order. Every suggestion shows why it is here.",
                    )}
                </p>
            </div>
            <CareQueue initial={initial} sessionKey={session.user.id} />
        </section>
    );
}
