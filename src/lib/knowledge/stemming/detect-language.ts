const LATIN = [
    [
        "cs",
        "a i v ve na do z ze k ke u o od po s se si je jsou jsem jsme jste to ten ta ty co jak že ale nebo pro při aby byl byla bylo bude není má který která které také už jen ještě než prosím posílám dobrý den",
        /[řůě]/u,
    ],
    [
        "sk",
        "a i v vo na do z zo k ku u o od po s so sa si je sú som sme ste to ten tá tie čo ako že ale alebo pre pri aby bol bola bolo bude nie má ktorý ktorá ktoré tiež už len ešte než prosím posielam dobrý deň",
        /[äľĺŕô]/u,
    ],
    [
        "pl",
        "i a w we na do z ze o od po za jest są jestem nie to ten ta co jak że ale lub dla przy aby był była było będzie który która które też już tylko jeszcze niż proszę",
        /[łąęśźżń]/u,
    ],
    [
        "ro",
        "și în la de din cu pe pentru este sunt nu un o că care ce ca se să mai dar sau al ale am fost va vă noi voi",
        /[ășțşţ]/u,
    ],
    [
        "en",
        "the a an and or but if that this these those is are was were be been being to of in on for from with as by at it its not you your we our have has had will would can could should please",
        null,
    ],
    [
        "de",
        "der die das den dem des ein eine einer einen und oder aber wenn dass ist sind war waren nicht mit für von zu im auf an als auch wir sie ihr ich haben hat wird werden bitte",
        /ß/u,
    ],
    [
        "ca",
        "el la els les un una i o però que de del dels en amb per és són no es ha hem com més aquest aquesta nosaltres vosaltres",
        /[·]/u,
    ],
    [
        "da",
        "og eller men at det den de en et er var ikke til fra med på af som vi jeg du har skal kan dette vores jer hvad hvornår",
        null,
    ],
    [
        "es",
        "el la los las un una y o pero que de del en con por para es son no se ha hemos como más este esta nosotros ustedes",
        /ñ/u,
    ],
    [
        "eu",
        "eta edo baina da dira ez bat hau hori du dute den zer nola ere izan bere gure zure dago dagoen behar",
        null,
    ],
    [
        "fi",
        "ja tai mutta että on ovat ei se ne tämä nämä kun jos niin myös kanssa varten oli olla olen olet olemme teidän meidän",
        null,
    ],
    [
        "fr",
        "le la les un une des et ou mais que de du en dans avec pour est sont ne pas ce cette ces nous vous ils elles qui au aux sur",
        /[œ]/u,
    ],
    [
        "ga",
        "agus nó ach an na ar ag le do de sa sé sí seo sin atá bhfuil ní raibh chun mar mé tú muid sibh siad",
        null,
    ],
    [
        "hu",
        "a az és vagy de hogy van vannak nem egy ez azt is meg ha mint mert volt lesz kell én te mi ön önök",
        /[őű]/u,
    ],
    [
        "it",
        "il lo la gli le un una e o ma che di del della in con per è sono non si ha abbiamo come più questo questa noi voi",
        null,
    ],
    [
        "nl",
        "de het een en of maar dat dit die is zijn was niet met voor van naar op aan als ook wij jij u heeft hebben wordt zal",
        null,
    ],
    [
        "no",
        "og eller men at det den de en et er var ikke til fra med på av som vi jeg du har skal kan dette våre hva dere når",
        null,
    ],
    [
        "pt",
        "o a os as um uma e ou mas que de do da em com por para é são não se tem temos como mais este esta nós vocês",
        /[ãõ]/u,
    ],
    [
        "sv",
        "och eller men att det den de en ett är var inte till från med på av som vi jag du har ska kan detta våra vad",
        null,
    ],
    [
        "tr",
        "ve veya ama bir bu şu o için ile de da ki mi ne nasıl ben sen biz siz değil var olan olarak daha çok",
        /[ğış]/u,
    ],
] as const;

const SCRIPTS = [
    ["ru", /\p{Script=Cyrillic}/u, /[ыэ]/u, /[іїєґўђјљњћџѓќѕ]/u],
    ["ar", /\p{Script=Arabic}/u, null, /[پچژگکیٹڈڑںےۓ]/u],
    ["hy", /\p{Script=Armenian}/u, null, null],
    ["ta", /\p{Script=Tamil}/u, null, null],
] as const;
const ADDRESSES =
    /(?<!\S)\S*\d\S*|(?<![\p{L}\p{N}._%+-])(?:(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+|(?:mailto:)?[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+)/giu;
const LATIN_WORD = /\p{Script=Latin}/u;
const WORDS = /\p{L}[\p{L}\p{M}]*/gu;
const MARKS = /\p{M}/gu;
const SPECIAL_LETTERS = /[łßøæœı]/gu;
const REPLACEMENTS: Record<string, string> = {
    ł: "l",
    ß: "ss",
    ø: "o",
    æ: "ae",
    œ: "oe",
    ı: "i",
};

function fold(text: string): string {
    return text
        .normalize("NFD")
        .replace(MARKS, "")
        .replace(SPECIAL_LETTERS, (letter) => REPLACEMENTS[letter] ?? letter);
}

const STOPWORDS = new Map<string, number[]>();
for (let index = 0; index < LATIN.length; index++) {
    for (const word of new Set(fold(LATIN[index][1]).split(" "))) {
        const candidates = STOPWORDS.get(word);
        if (candidates) candidates.push(index);
        else STOPWORDS.set(word, [index]);
    }
}

const STOPWORD_WEIGHTS = Array.from({ length: LATIN.length + 1 }, (_, count) =>
    count === 1 ? 1.5 : 1 / Math.sqrt(count),
);

/** Detects a supported language from script and function words, or null when uncertain. */
export function detectLanguage(text: string): string | null {
    const clean = text.toLowerCase().normalize("NFC").replace(ADDRESSES, " ");
    const words = fold(clean).match(WORDS);
    if (!words || words.length < 6) return null;
    for (const [language, script, required, excluded] of SCRIPTS) {
        let count = 0;
        for (const word of words) if (script.test(word)) count++;
        if (count < 6 || count / words.length < 0.7) continue;
        if (excluded?.test(clean) || (required && !required.test(clean)))
            return null;
        return language;
    }
    let latinWords = 0;
    for (const word of words) if (LATIN_WORD.test(word)) latinWords++;
    if (latinWords / words.length < 0.7) return null;
    const scores = new Float64Array(LATIN.length);
    const hits = new Uint32Array(LATIN.length);
    for (const word of words) {
        const candidates = STOPWORDS.get(word);
        if (!candidates) continue;
        const weight = STOPWORD_WEIGHTS[candidates.length];
        for (const index of candidates) {
            scores[index] += weight;
            hits[index]++;
        }
    }
    let best = -1;
    let first = 0;
    let second = 0;
    for (let index = 0; index < LATIN.length; index++) {
        if (hits[index] < 3) continue;
        const letters = LATIN[index][2];
        const score = scores[index] + (letters?.test(clean) ? 2 : 0);
        if (score > first) {
            second = first;
            first = score;
            best = index;
        } else if (score > second) second = score;
    }
    return best >= 0 &&
        first >= 2.5 &&
        first - second >= Math.max(1.5, first * 0.25)
        ? LATIN[best][0]
        : null;
}
