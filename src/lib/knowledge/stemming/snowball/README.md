# Snowball stemmers

The JavaScript stemmers of [Snowball](https://snowballstem.org) 3.1.1, unchanged:
`base-stemmer.js` and one `<language>-stemmer.js` per language the Almanac stems with
(see `../index.ts`). Licensed under the BSD 3-Clause License (`COPYING`).

They are not edited by hand. `scripts/snowball-stemmers.sh` compiles Snowball's compiler
from the release's source, generates these files, requires them to equal Snowball's own
JavaScript distribution (and `base-stemmer.js` to equal the release's commit on GitHub),
and compares them with this directory; `--write` replaces them. To move to a new release,
change its version, checksums and commit in the script.

Each stemmer expects a word in lowercase, Unicode NFC.
