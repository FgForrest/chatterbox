import { useExtracted } from "next-intl";
import { useMemo } from "react";

/** Display core labels by key; preserve the labels of custom vocabulary. */
export function useVocabularyLabels() {
    const i18n = useExtracted();
    return useMemo(() => {
        const entityTypes: Record<string, string> = {
            person: i18n({ id: "coreType_person", message: "Person" }),
            organization: i18n({
                id: "coreType_organization",
                message: "Organization",
            }),
            team: i18n({ id: "coreType_team", message: "Team" }),
            project: i18n({ id: "coreType_project", message: "Project" }),
            product: i18n({
                id: "coreType_product",
                message: "Product or system",
            }),
            term: i18n({ id: "coreType_term", message: "Term" }),
            location: i18n({ id: "coreType_location", message: "Location" }),
            document: i18n({ id: "coreType_document", message: "Document" }),
        };
        const relations: Record<string, string> = {
            works_for: i18n({
                id: "coreRelation_works_for",
                message: "works for",
            }),
            member_of: i18n({
                id: "coreRelation_member_of",
                message: "is a member of",
            }),
            has_role: i18n({
                id: "coreRelation_has_role",
                message: "has the role",
            }),
            works_on: i18n({
                id: "coreRelation_works_on",
                message: "works on",
            }),
            leads: i18n({ id: "coreRelation_leads", message: "leads" }),
            reports_to: i18n({
                id: "coreRelation_reports_to",
                message: "reports to",
            }),
            contact_for: i18n({
                id: "coreRelation_contact_for",
                message: "is the contact for",
            }),
            project_for: i18n({
                id: "coreRelation_project_for",
                message: "is a project for",
            }),
            client_of: i18n({
                id: "coreRelation_client_of",
                message: "is a client of",
            }),
            part_of: i18n({
                id: "coreRelation_part_of",
                message: "is part of",
            }),
            uses: i18n({ id: "coreRelation_uses", message: "uses" }),
            is_a: i18n({ id: "coreRelation_is_a", message: "is a" }),
            means: i18n({ id: "coreRelation_means", message: "means" }),
        };
        return vocabularyLabels(entityTypes, relations);
    }, [i18n]);
}

/** Resolve translated core labels while leaving custom labels as supplied. */
export function vocabularyLabels(
    entityTypes: Record<string, string>,
    relations: Record<string, string>,
) {
    return {
        entityType: (key: string, fallback = key): string =>
            Object.hasOwn(entityTypes, key) ? entityTypes[key] : fallback,
        relation: (key: string, fallback = key): string =>
            Object.hasOwn(relations, key) ? relations[key] : fallback,
    };
}
