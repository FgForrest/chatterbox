import { ThingsList } from "@/components/almanac/things-list";
import { requireAuth } from "@/lib/auth-server";
import { almanacVocabulary } from "@/lib/knowledge/almanac-vocabulary";
import { listEntities } from "@/lib/knowledge/entities";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { isOrgAccount } from "@/lib/org/config";

export const dynamic = "force-dynamic";

/**
 * The things the viewer sees: their own and the Organization's. The
 * organization account adds the Organization's, with its types and the
 * core's; a member adds their own, with their private types too.
 */
export default async function ThingsPage() {
    const session = await requireAuth();
    const userId = session.user.id;
    const [things, vocabulary, organization] = await Promise.all([
        listEntities(userId),
        vocabularyVisibleTo(userId),
        isOrgAccount(userId),
    ]);
    const almanac = almanacVocabulary(vocabulary);
    return (
        <ThingsList
            things={things.map((thing) => ({
                id: thing.id,
                name: thing.name,
                typeKey: thing.typeKey,
                description: thing.description,
                scope: thing.scope,
            }))}
            typeLabels={almanac.typeLabels}
            types={almanac.entityTypes
                .filter((type) => !organization || type.shared)
                .map((type) => ({ key: type.key, label: type.label }))}
        />
    );
}
