#!/usr/bin/env bash
# Retake the user guide's screenshots from the seeded demo stack.
# Usage: capture.sh [section...]   (no section: all of them, in order)
# See docs/user-guide/demo/README.md.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
images="$repo/content/docs/user-guide/images"
app="${USER_GUIDE_APP_URL:-http://localhost:3312}"
project="${USER_GUIDE_PROJECT:-riffado-user-guide}"
session="${USER_GUIDE_BROWSER_SESSION:-riffado-user-guide}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$images"
cd "$repo"

ab() { agent-browser --session "$session" "$@"; }

js() { ab eval -b "$(printf '%s' "$1" | base64 -w0)" | tr -d '"'; }

# Tag the element holding the text `$2` (or its closest `$3` ancestor) as
# data-shot="$1", for `shot` and `crop` to find.
tag() {
    js "(() => {
        const name = \"$1\", text = \"$2\", closest = \"${3:-}\";
        document.querySelectorAll('[data-shot=\"' + name + '\"]')
            .forEach((e) => e.removeAttribute('data-shot'));
        const owners = [...document.querySelectorAll('body *')].filter((e) =>
            [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === text));
        for (const owner of owners) {
            const target = closest ? owner.closest(closest) : owner;
            if (target) { target.setAttribute('data-shot', name); return 'ok'; }
        }
        throw new Error('No element holds ' + text);
    })()" >/dev/null
}

selector_of() {
    if [[ "$1" == css:* ]]; then echo "${1#css:}"; else echo "[data-shot=\"$1\"]"; fi
}

# Screenshot one element (a tag or css:<selector>) as `$2`.
shot() {
    local selector
    selector="$(selector_of "$1")"
    ab scrollintoview "$selector" >/dev/null 2>&1 || true
    ab wait 500 >/dev/null
    ab screenshot "$selector" "$images/$2.png" >/dev/null
    echo "  $2.png"
}

# Screenshot the viewport as `$1`.
page() {
    ab wait 600 >/dev/null
    ab screenshot "$images/$1.png" >/dev/null
    echo "  $1.png"
}

# Screenshot the top `$2` pixels of the viewport as `$1`.
top() {
    ab wait 600 >/dev/null
    ab screenshot "$work/viewport.png" >/dev/null
    docker compose -p "$project" -f docker-compose.e2e.yml \
        -f docs/user-guide/demo/docker-compose.demo.yml exec -T app \
        ffmpeg -nostdin -loglevel error -f png_pipe -i pipe:0 -vf "crop=iw:$2:0:0" \
        -f image2pipe -c:v png pipe:1 <"$work/viewport.png" >"$images/$1.png"
    echo "  $1.png"
}

# Screenshot the viewport, cropped to the box around every element given
# (tags or css:<selector>) plus a margin, as `$1`.
crop() {
    local out="$1" selectors="" item box
    shift
    for item in "$@"; do selectors+="\"$(selector_of "$item" | sed 's/"/\\"/g')\","; done
    ab wait 600 >/dev/null
    box="$(js "(() => {
        const rects = [${selectors}].flatMap((s) =>
            [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect()))
            .filter((r) => r.width > 0 && r.height > 0);
        if (rects.length === 0) throw new Error('Nothing to crop to');
        const m = 16, W = innerWidth, H = innerHeight;
        const x = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.left)) - m));
        const y = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.top)) - m));
        const r = Math.min(W, Math.ceil(Math.max(...rects.map((r) => r.right)) + m));
        const b = Math.min(H, Math.ceil(Math.max(...rects.map((r) => r.bottom)) + m));
        return [r - x, b - y, x, y].join(':');
    })()")"
    ab screenshot "$work/viewport.png" >/dev/null
    docker compose -p "$project" -f docker-compose.e2e.yml \
        -f docs/user-guide/demo/docker-compose.demo.yml exec -T app \
        ffmpeg -nostdin -loglevel error -f png_pipe -i pipe:0 -vf "crop=$box" \
        -f image2pipe -c:v png pipe:1 <"$work/viewport.png" >"$images/$out.png"
    echo "  $out.png"
}

# Open a page, its header scrolling away instead of covering what a shot
# scrolls to.
open() {
    ab open "$app$1" >/dev/null
    ab wait 2500 >/dev/null
    js "(() => {
        const style = document.createElement('style');
        style.textContent = 'header.sticky { position: static !important; }';
        document.head.append(style);
        return 'ok';
    })()" >/dev/null
}

click_text() { ab find text "$1" click >/dev/null; ab wait "${2:-900}" >/dev/null; }
click_button() { ab find role button click --name "$1" >/dev/null; ab wait "${2:-900}" >/dev/null; }
# Click the element holding the text `$1` from script, which no overlay
# can intercept.
click_js() {
    tag clicked "$1"
    js "(() => {
        document.querySelector('[data-shot=\"clicked\"]').click();
        return 'ok';
    })()" >/dev/null
    ab wait "${2:-900}" >/dev/null
}
blur() { js "(() => { document.activeElement?.blur(); return 'ok'; })()" >/dev/null; }
dialog() { ab wait 1200 >/dev/null; blur; crop "$1" "css:[role=dialog]"; }
escape() { ab press Escape >/dev/null; ab wait 700 >/dev/null; }
scroll_to() { ab scrollintoview "$(selector_of "$1")" >/dev/null; ab wait 500 >/dev/null; }

sign_in() {
    ab open "$app/login" >/dev/null
    ab cookies clear >/dev/null
    ab set viewport 1440 900 >/dev/null
    ab open "$app/login" >/dev/null
    ab find label "Email" fill "$1" >/dev/null
    ab find label "Password" fill "$2" >/dev/null
    click_button "SIGN IN" 4000
    ab wait 4000 >/dev/null
}

select_recording() {
    open "/dashboard"
    click_text "$1" 2500
}

section_onboarding() {
    open "/settings#export"
    click_button "Re-run Onboarding" 1500
    open "/dashboard"
    page onboarding-welcome
    click_button "Next"
    page onboarding-plaud
    click_button "Skip"
    page onboarding-ai-provider
    click_button "Skip"
    page onboarding-done
    click_button "Get Started" 1500
}

section_dashboard() {
    select_recording "Weekly product sync"
    page dashboard
    click_button "Needs review (1)"
    shot "css:.bg-card:has(input[aria-label='Search recordings'])" recording-list-needs-review
    click_button "Needs review (1)"
}

section_recording() {
    select_recording "Weekly product sync"
    click_button "Erase recording artifacts"
    crop erase-menu "css:[role=menu]" "css:button[aria-label='Erase recording artifacts']"
    escape
    click_button "Add to folder"
    crop add-to-folder "css:[role=menu]" "css:button[aria-label='Add to folder']"
    escape
    click_text "Estimated AI spend"
    tag title "Weekly product sync" "h1"
    crop ai-spend title "css:details[open] *"
    click_text "Estimated AI spend"
}

section_transcript() {
    select_recording "Weekly product sync"
    tag guesses "Speaker guesses" "[aria-label='Speaker guesses']"
    tag transcript "Transcription" ".bg-card"
    scroll_to guesses
    crop transcript-speakers guesses transcript
    tag topics "Topics (4)" "button"
    click_button "Topics (4)"
    crop topics-menu "css:[role=menu]" topics
    escape
    click_js "Morning." 1500
    click_button "Pause" 500
    scroll_to transcript
    crop sentence-playback transcript
    select_recording "Design review: driver onboarding"
    tag transcript "Transcription" ".bg-card"
    scroll_to transcript
    crop transcript-corrected transcript
    click_button "Show original"
    crop transcript-original transcript
    click_button "Show edited"
    select_recording "Lecture: field research methods"
    tag transcript "Transcription" ".bg-card"
    scroll_to transcript
    crop transcript-lecture transcript
}

section_learn() {
    select_recording "Weekly product sync"
    click_button "Review (5)" 1500
    dialog learn-review
    escape
}

section_summary() {
    select_recording "Weekly product sync"
    tag summary "Summary" ".bg-card"
    scroll_to summary
    crop summary summary
    click_button "Review tasks (3)" 1500
    dialog task-review
    escape
    select_recording "Design review: driver onboarding"
    tag summary "Summary" ".bg-card"
    scroll_to summary
    js "(() => {
        const box = document.querySelector('[data-shot=\"summary\"] section.overflow-y-auto');
        box.scrollTop = box.scrollHeight;
        return 'ok';
    })()" >/dev/null
    crop summary-multi-pass summary
}

section_tasks() {
    open "/tasks"
    top tasks-mine 500
    open "/tasks?tab=tracked"
    top tasks-tracked 500
}

section_folders() {
    open "/dashboard"
    click_button "Organize" 1500
    page folders
    click_text "Bluefin Logistics" 1500
    top folder-pane 640
    click_button "Settings" 1500
    dialog folder-export
    click_button "Add filesystem export" 1200
    dialog folder-export-filesystem
    escape
}

section_organization() {
    open "/dashboard"
    click_button "Organize" 1500
    click_text "Usability studies" 1500
    top organization-folder 640
    click_text "Usability test: tracking page" 2500
    page organization-recording
}

section_almanac() {
    open "/almanac"
    page almanac-people
    click_text "Lena Fischer" 2000
    page almanac-person
    open "/almanac/things"
    page almanac-things
    click_text "Harbor" 2000
    page almanac-thing
    open "/almanac/things"
    click_button "Import a list" 1000
    ab fill "[role=dialog] textarea" "project: Harbor phase 2
product: Pathfinder Lite (PF Lite)
location: Rotterdam depot, Antwerp depot" >/dev/null
    click_button "Preview" 1500
    dialog almanac-import
    escape
    open "/almanac/review"
    top almanac-review 420
}

# Open a settings section, scrolled to the heading `$2` if given, and shoot
# the dialog as `$3` (default settings-<section>).
setting() {
    open "/settings#$1"
    if [[ -n "${2:-}" ]]; then
        tag heading "$2"
        scroll_to heading
    fi
    dialog "${3:-settings-$1}"
}

section_settings() {
    ab set viewport 1440 1200 >/dev/null
    setting providers
    click_button "Edit Claude Code · claude-sonnet-5" 1200
    blur
    crop settings-provider-edit "css:[role=dialog]:last-of-type"
    escape
    setting transcription
    setting topics
    setting learning
    setting summary
    setting summary "Multi-pass summarization" settings-multi-pass
    setting display
    setting storage "Auto-delete old data" settings-retention
    setting export
    ab set viewport 1440 900 >/dev/null
}

section_help() {
    select_recording "Weekly product sync"
    click_button "Help" 3500
    blur
    page help-drawer
    escape
    open "/settings#summary"
    js "(() => {
        [...document.querySelectorAll('[role=dialog] button')]
            .find((b) => b.getAttribute('aria-label') === 'Help').click();
        return 'ok';
    })()" >/dev/null
    ab wait 3500 >/dev/null
    blur
    page help-drawer-settings
    escape
    open "/docs/user-guide/transcripts"
    page docs-user-guide
}

section_palette() {
    open "/dashboard"
    click_button "Open command palette" 1000
    page command-palette
    escape
}

# Last: finishing the review changes the demo data.
section_learn_finish() {
    select_recording "Weekly product sync"
    click_button "Review (5)" 1500
    js "(() => {
        for (const group of ['Speakers', 'New facts']) {
            let e = [...document.querySelectorAll('[role=dialog] *')].find((el) =>
                [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === group));
            const box = 'input[type=checkbox], button[role=checkbox]';
            while (e && !e.querySelector(box)) e = e.parentElement;
            e.querySelector(box).click();
        }
        return 'ok';
    })()" >/dev/null
    ab wait 500 >/dev/null
    click_button "Finish review" 3000
    js "(() => {
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent.trim().startsWith('Learned')).click();
        return 'ok';
    })()" >/dev/null
    ab wait 1500 >/dev/null
    dialog learn-results
    escape
}

sections=(onboarding dashboard recording transcript learn summary tasks folders
    organization almanac settings help palette learn_finish)
if [[ $# -gt 0 ]]; then sections=("$@"); fi

sign_in alex@example.com demo-password-123
for section in "${sections[@]}"; do
    echo "$section"
    "section_$section"
done
ab close >/dev/null
