import { notFound, redirect } from "next/navigation";
import { EntityDetail } from "@/components/people/entity-detail";
import { requireAuth } from "@/lib/auth-server";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { listAliases } from "@/lib/knowledge/aliases";
import { almanacVocabulary } from "@/lib/knowledge/almanac-vocabulary";
import { getEntity } from "@/lib/knowledge/entities";
import { factsForPage } from "@/lib/knowledge/fact-page";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { getVocabularyLabels } from "@/lib/knowledge/vocabulary-labels-server";
import { getOrgUserId } from "@/lib/org/config";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export default async function EntityPage({ params }: Params) {
    const session = await requireAuth();
    const labels = await getVocabularyLabels();

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
    const organization = await userCuratesOrganizationNow(userId);
    const [facts, otherNames, vocabulary] = await Promise.all([
        factsForPage(userId, orgUserId, { entityId: id }),
        listAliases(userId, { entityId: id }),
        vocabularyVisibleTo(userId),
    ]);
    const almanac = almanacVocabulary(vocabulary, labels);
    const typeLabel = almanac.typeLabels[entity.typeKey] ?? null;
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
                    canCurateOrganization: organization,
                }}
            />
        </div>
    );
}
