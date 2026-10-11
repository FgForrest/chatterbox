#!/usr/bin/env bash
# Rebuilds the Snowball stemmers in src/lib/knowledge/stemming/snowball from
# the official Snowball release (https://snowballstem.org): compiles the
# Snowball compiler from its source, generates each language's JavaScript,
# requires it to equal the project's own JavaScript distribution (and the
# shared runtime, which the source tarball lacks, to equal the release's
# commit on GitHub), then compares it with the committed copy (default) or
# writes it (--write).
#
# Needs curl, tar, a C compiler (cc) and sha256sum.
set -euo pipefail

VERSION="3.1.1"
SOURCE_SHA256="6b11209905d4dd728f6eb1c88d5a8408dcbe9c4d80ea965e6ebef33d8552bdb5"
JS_SHA256="793c5a4063de2a4cf6601b5a89bdef19a7655318fdd35eeb30c00c4d6a24b8db"
COMMIT="cd195b51e948a902a4312f023f4a14392516a543"
LANGUAGES=(arabic armenian basque catalan danish dutch finnish french german
    hungarian irish italian norwegian portuguese russian spanish swedish
    tamil turkish)

repo="$(cd "$(dirname "$0")/.." && pwd)"
target="$repo/src/lib/knowledge/stemming/snowball"
mode="${1:---check}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
    local file="$1" sha256="$2"
    curl --proto '=https' --tlsv1.2 -fsSL -o "$work/$file" \
        "https://snowballstem.org/dist/$file"
    echo "$sha256  $work/$file" | sha256sum -c --quiet -
}

fetch "snowball-$VERSION.tar.gz" "$SOURCE_SHA256"
fetch "jsstemmer-$VERSION.tar.gz" "$JS_SHA256"
tar -xzf "$work/snowball-$VERSION.tar.gz" -C "$work"
tar -xzf "$work/jsstemmer-$VERSION.tar.gz" -C "$work"

source_dir="$work/snowball-$VERSION"
dist_dir="$work/jsstemmer-$VERSION/javascript"
out="$work/out"
mkdir -p "$out"
cc -O2 -o "$work/snowball" "$source_dir"/compiler/*.c
curl --proto '=https' --tlsv1.2 -fsSL -o "$out/base-stemmer.js" \
    "https://raw.githubusercontent.com/snowballstem/snowball/$COMMIT/javascript/base-stemmer.js"
cp "$source_dir/COPYING" "$out/COPYING"
printf '{ "type": "module" }\n' >"$out/package.json"
for language in "${LANGUAGES[@]}"; do
    "$work/snowball" "$source_dir/algorithms/$language.sbl" -js \
        -o "$out/$language-stemmer.js"
done

for file in "$out"/*.js; do
    cmp -s "$file" "$dist_dir/$(basename "$file")" || {
        echo "$(basename "$file") differs from Snowball's own distribution" >&2
        exit 1
    }
done

case "$mode" in
--write)
    mkdir -p "$target"
    rm -f "$target"/*.js
    cp "$out"/*.js "$out/COPYING" "$out/package.json" "$target/"
    echo "Wrote Snowball $VERSION stemmers to $target"
    ;;
--check)
    diff -r --exclude=README.md "$out" "$target" && \
        echo "The committed stemmers are Snowball $VERSION's"
    ;;
*)
    echo "usage: $0 [--check|--write]" >&2
    exit 2
    ;;
esac
