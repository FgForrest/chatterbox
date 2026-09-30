import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { EntityDetail } from "@/components/people/entity-detail";
import { auth } from "@/lib/auth";
import { listAliases } from "@/lib/knowledge/aliases";
import { getEntity } from "@/lib/knowledge/entities";
import { factsForPage } from "@/lib/knowledge/fact-page";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { getOrgUserId } from "@/lib/org/config";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export default async function EntityPage({ params }: Params) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) {
        redirect("/login");
    }

    const { id } = await params;
    const userId = session.user.id;

    // The viewer's own entities and the Organization's; anyone else's is
    // not found.
    const entity = await getEntity(userId, id);
    if (!entity) {
        notFound();
    }
    if (entity.mergedIntoId) {
        redirect(`/people/entities/${entity.mergedIntoId}`);
    }

    const orgUserId = await getOrgUserId();
    const [facts, otherNames, vocabulary] = await Promise.all([
        factsForPage(userId, orgUserId, { entityId: id }),
        listAliases(userId, { entityId: id }),
        vocabularyVisibleTo(userId),
    ]);
    const typeLabel =
        vocabulary.entityTypes.find((type) => type.key === entity.typeKey)
            ?.label ?? null;

    return (
        <div className="container mx-auto max-w-7xl px-4 py-6">
            <AppHeader>
                <AppNav className="min-w-0" />
            </AppHeader>

            <div className="mx-auto w-full max-w-5xl">
                <EntityDetail
                    entity={{
                        id: entity.id,
                        name: entity.name,
                        typeLabel,
                        description: entity.description,
                        notes: entity.notes,
                        scope: entity.scope,
                    }}
                    facts={facts}
                    otherNames={otherNames.map((name) => ({
                        text: name.text,
                        kind: name.kind,
                    }))}
                />
            </div>
        </div>
    );
}
