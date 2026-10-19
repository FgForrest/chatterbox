import { getTranslations } from "next-intl/server";
import {
    CORE_ENTITY_TYPES,
    CORE_RELATIONS,
} from "@/lib/knowledge/vocabulary-core";
import { vocabularyLabels } from "@/lib/knowledge/vocabulary-labels";

/** Translate core vocabulary for server-rendered Almanac pages. */
export async function getVocabularyLabels() {
    const i18n = await getTranslations();
    return vocabularyLabels(
        Object.fromEntries(
            CORE_ENTITY_TYPES.map((type) => [
                type.key,
                i18n(`coreType_${type.key}`),
            ]),
        ),
        Object.fromEntries(
            CORE_RELATIONS.map((relation) => [
                relation.key,
                i18n(`coreRelation_${relation.key}`),
            ]),
        ),
    );
}
