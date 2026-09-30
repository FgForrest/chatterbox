/**
 * The core vocabulary, the one every user and the Organization share, and
 * the topics no vocabulary may be about.
 *
 * Pure, so the prompt code and the client can read it without a database.
 * Aligned with CoNLL-2003, ACE 2005, TACRED, schema.org and Wikidata, which
 * is why the keys are English and stable: they are identifiers, the labels
 * are what people read.
 */

export interface CoreEntityType {
    key: string;
    label: string;
}

export interface CoreRelation {
    key: string;
    label: string;
    subjectTypes: readonly string[];
    objectTypes: readonly string[];
    /** `literal`: the object is text (a role, a definition). */
    objectKind: "entity" | "literal";
    /** `one`: a subject holds one object at a time; a new one replaces it. */
    cardinality: "one" | "many";
}

export const CORE_ENTITY_TYPES: readonly CoreEntityType[] = [
    { key: "person", label: "Person" },
    { key: "organization", label: "Organization" },
    { key: "team", label: "Team" },
    { key: "project", label: "Project" },
    { key: "product", label: "Product or system" },
    { key: "term", label: "Term" },
    { key: "location", label: "Location" },
    { key: "document", label: "Document" },
];

const ANY_ENTITY = CORE_ENTITY_TYPES.map((type) => type.key);
const GROUPS = ["organization", "team"];
const WORK = ["project", "product"];

export const CORE_RELATIONS: readonly CoreRelation[] = [
    {
        key: "works_for",
        label: "works for",
        subjectTypes: ["person"],
        objectTypes: ["organization"],
        objectKind: "entity",
        cardinality: "one",
    },
    {
        key: "member_of",
        label: "is a member of",
        subjectTypes: ["person"],
        objectTypes: GROUPS,
        objectKind: "entity",
        cardinality: "many",
    },
    {
        key: "has_role",
        label: "has the role",
        subjectTypes: ["person"],
        objectTypes: [],
        objectKind: "literal",
        cardinality: "many",
    },
    {
        key: "works_on",
        label: "works on",
        subjectTypes: ["person", ...GROUPS],
        objectTypes: WORK,
        objectKind: "entity",
        cardinality: "many",
    },
    {
        key: "leads",
        label: "leads",
        subjectTypes: ["person"],
        objectTypes: [...GROUPS, ...WORK],
        objectKind: "entity",
        cardinality: "many",
    },
    {
        key: "reports_to",
        label: "reports to",
        subjectTypes: ["person"],
        objectTypes: ["person"],
        objectKind: "entity",
        cardinality: "one",
    },
    {
        key: "contact_for",
        label: "is the contact for",
        subjectTypes: ["person"],
        objectTypes: [...GROUPS, ...WORK],
        objectKind: "entity",
        cardinality: "many",
    },
    {
        key: "project_for",
        label: "is a project for",
        subjectTypes: ["project"],
        objectTypes: ["organization"],
        objectKind: "entity",
        cardinality: "one",
    },
    {
        key: "client_of",
        label: "is a client of",
        subjectTypes: ["organization"],
        objectTypes: ["organization"],
        objectKind: "entity",
        cardinality: "many",
    },
    {
        key: "part_of",
        label: "is part of",
        subjectTypes: [...GROUPS, ...WORK, "location", "document"],
        objectTypes: [...GROUPS, ...WORK, "location", "document"],
        objectKind: "entity",
        cardinality: "one",
    },
    {
        key: "uses",
        label: "uses",
        subjectTypes: ["person", ...GROUPS, "project"],
        objectTypes: ["product", "document"],
        objectKind: "entity",
        cardinality: "many",
    },
    {
        key: "is_a",
        label: "is a",
        subjectTypes: ANY_ENTITY,
        objectTypes: ["term"],
        objectKind: "entity",
        cardinality: "many",
    },
    {
        key: "means",
        label: "means",
        subjectTypes: ["term"],
        objectTypes: [],
        objectKind: "literal",
        cardinality: "one",
    },
];

export interface DeniedTopic {
    id: string;
    /** What the topic is, for the model's screening prompt (Phase 3). */
    description: string;
    /**
     * Words that name the topic outright, in the languages Riffado is used
     * in. A floor for labels people type (a type named "diagnosis"), not a
     * classifier: the model screens what it proposes, and a person reviews.
     */
    terms: readonly string[];
}

/**
 * What knowledge about people must never be about: nothing here may become
 * a relation or entity type, and facts about it are screened out.
 */
export const DENIED_TOPICS: readonly DeniedTopic[] = [
    {
        id: "health",
        description:
            "physical or mental health, illness, diagnoses, disability, medication, pregnancy",
        terms: [
            "health",
            "illness",
            "sick",
            "disease",
            "diagnosis",
            "disability",
            "medication",
            "pregnant",
            "pregnancy",
            "cancer",
            "depression",
            "therapy",
            "treated",
            "treatment",
            "patient",
            "surgery",
            "zdravi",
            "rakovina",
            "deprese",
            "terapie",
            "lecba",
            "leceni",
            "lecen",
            "pacient",
            "nemoc",
            "diagnoza",
            "postizeni",
            "lek",
            "leky",
            "tehotenstvi",
            "tehotna",
        ],
    },
    {
        id: "family",
        description:
            "family and relationships: partners, children, marriage, divorce, relatives",
        terms: [
            "family",
            "married",
            "marriage",
            "divorce",
            "wife",
            "husband",
            "girlfriend",
            "boyfriend",
            "children",
            "rodina",
            "manzel",
            "manzelka",
            "manzelstvi",
            "rozvod",
            "pritel",
            "pritelkyne",
            "deti",
        ],
    },
    {
        id: "personality",
        description:
            "personality, character, temperament, psychological traits",
        terms: [
            "personality",
            "character",
            "temperament",
            "osobnost",
            "povaha",
        ],
    },
    {
        id: "performance",
        description:
            "judgments of a person's performance, competence, reliability or worth",
        terms: [
            "performance",
            "competence",
            "incompetent",
            "lazy",
            "unreliable",
            "vykon",
            "kompetence",
            "neschopny",
            "liny",
            "nespolehlivy",
        ],
    },
    {
        id: "demographics",
        description:
            "inferred demographics: age, ethnicity, religion, sexual orientation, political views, nationality",
        terms: [
            "age",
            "ethnicity",
            "race",
            "religion",
            "religious",
            "orientation",
            "sexuality",
            "political",
            "nationality",
            "vek",
            "etnicita",
            "rasa",
            "nabozenstvi",
            "orientace",
            "politicky",
            "narodnost",
        ],
    },
];

/** Lowercase, drop diacritics and split into words, the same for any script. */
function words(value: string): string[] {
    return value
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/**
 * The denied topic a label names, if any: a whole word of it is one of the
 * topic's terms. Used when a person creates a type; see `DENIED_TOPICS`.
 */
export function deniedTopicOf(label: string): DeniedTopic | null {
    const labelWords = new Set(words(label));
    return (
        DENIED_TOPICS.find((topic) =>
            topic.terms.some((term) => labelWords.has(term)),
        ) ?? null
    );
}
