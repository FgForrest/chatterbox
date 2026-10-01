declare module "snowball-stemmers" {
    interface Stemmer {
        stem(word: string): string;
    }
    export function algorithms(): string[];
    export function newStemmer(algorithm: string): Stemmer;
}
