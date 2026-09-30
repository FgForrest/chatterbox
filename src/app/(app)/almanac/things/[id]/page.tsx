import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { EntityDetail } from "@/components/people/entity-detail";
import { auth } from "@/lib/auth";
import { listAliases } from "@/lib/knowledge/aliases";
import { almanacVocabulary } from "@/lib/knowledge/almanac-vocabulary";
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
        redirect(`/almanac/things/${entity.mergedIntoId}`);
    }

    const orgUserId = await getOrgUserId();
    const organization = userId === orgUserId;
    const [facts, otherNames, vocabulary] = await Promise.all([
        factsForPage(userId, orgUserId, { entityId: id }),
        listAliases(userId, { entityId: id }),
        vocabularyVisibleTo(userId),
    ]);
    const almanac = almanacVocabulary(vocabulary);
    const typeLabel = almanac.typeLabels[entity.typeKey] ?? null;
    // Private things are their owner's to change; the Organization's, its
    // account's. Such a thing takes the Organization's types and the core's.
    const canManage = entity.scope === "personal" || organization;
    const types =
        entity.scope === "org"
            ? almanac.entityTypes.filter((type) => type.shared)
            : almanac.entityTypes;

    return (
        <div className="mx-auto w-full max-w-5xl">
            <EntityDetail
                entity={{
                    id: entity.id,
                    name: entity.name,
                    typeKey: entity.typeKey,
                    typeLabel,
                    description: entity.description,
                    notes: entity.notes,
                    scope: entity.scope,
                }}
                facts={facts}
                otherNames={otherNames.map((name) => ({
                    id: name.id,
                    text: name.text,
                    kind: name.kind,
                    scope: name.scope,
                }))}
                canManage={canManage}
                types={types}
                editing={{
                    subject: {
                        kind: "entity",
                        id: entity.id,
                        typeKey: entity.typeKey,
                    },
                    relations: almanac.relations,
                    typeLabels: almanac.typeLabels,
                    ownScope: organization ? "org" : "personal",
                }}
            />
        </div>
    );
}
