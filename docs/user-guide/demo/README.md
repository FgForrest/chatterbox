# User guide demo data

The screenshots in [`content/docs/user-guide/images`](../../../content/docs/user-guide/images) are taken from a Riffado stack filled with invented demo data. Everything needed to rebuild that stack and retake every screenshot lives here, so a changed screen means one re-run, not starting over.

| File | What it is |
| --- | --- |
| [`src/lib/demo/user-guide/fixtures.ts`](../../../src/lib/demo/user-guide/fixtures.ts) | The demo data: users, Almanac people and things, AI providers, folders, and the recordings with their transcripts, topics, summaries, tasks, Learn proposals and AI costs. Edit this to change what the screenshots show. |
| [`src/lib/demo/user-guide/seed.ts`](../../../src/lib/demo/user-guide/seed.ts) | Writes the fixtures into the database through the app's own helpers, so encryption, lookup hashes and sharing work as in real use. It lives under `src/` so `pnpm type-check` keeps it in step with the schema. |
| [`docker-compose.demo.yml`](docker-compose.demo.yml) | Overrides `docker-compose.e2e.yml`: its own ports, the organization account, folder exports and a placeholder Google configuration. |
| [`seed.sh`](seed.sh) | Replaces the stack's data with the demo data and gives every recording audio. |
| [`capture.sh`](capture.sh) | Signs in as the demo user and retakes the screenshots with `agent-browser` (`npm i -g agent-browser`). |

The demo user is **alex@example.com** / `demo-password-123`. Priya Raman (**priya@example.com**, same password) owns the recording shared with the Organization. The organization account is **org@example.com** / `demo-organization-pass`. None of these credentials protect anything real.

## Retaking the screenshots

Needs Docker, Node with the repository's dependencies installed (`pnpm install`), and `agent-browser`.

```bash
# 1. Build and start the stack (first build takes a few minutes).
docker compose -p riffado-user-guide -f docker-compose.e2e.yml \
  -f docs/user-guide/demo/docker-compose.demo.yml up -d --build

# 2. Fill it with the demo data. Deletes everything else in this stack.
docs/user-guide/demo/seed.sh

# 3. Retake every screenshot, or only some sections.
docs/user-guide/demo/capture.sh
docs/user-guide/demo/capture.sh transcript settings
```

The sections are `onboarding dashboard recording transcript learn summary tasks folders organization almanac settings help palette learn_finish`. `learn_finish` finishes a Learn review and so changes the data: seed again before retaking `learn` or the review shots.

Stop the stack with `docker compose -p riffado-user-guide ... stop`, which keeps the data, or `down -v` to remove it.

### Settings

| Variable | Default | Use |
| --- | --- | --- |
| `USER_GUIDE_APP_URL` | `http://localhost:3312` | Where the app answers. Also the stack's `APP_URL`, so set it before step 1 too. |
| `USER_GUIDE_APP_PORT`, `USER_GUIDE_DB_PORT` | `3312`, `5435` | Published ports. |
| `USER_GUIDE_DB_HOST` | `localhost` | Where `seed.sh` reaches PostgreSQL. |
| `USER_GUIDE_PROJECT` | `riffado-user-guide` | The compose project name. |

Inside a sandbox whose Docker daemon runs elsewhere, publish on that host and point the variables at it, for example `USER_GUIDE_APP_URL=http://docker:3312 USER_GUIDE_DB_HOST=docker`.

## How the capture works

`capture.sh` drives the browser at 1440×900 (1440×1200 for Settings). Each section opens a page, clicks to the state it needs, and saves one of three kinds of image:

- `page NAME`: the whole window.
- `shot TARGET NAME`: one element, such as a dialog.
- `crop NAME TARGET...`: the window cropped to the box around several elements, such as a menu together with the button that opened it. Cropping runs FFmpeg inside the app container, so no image tools are needed on the host.

Targets are either CSS selectors (`css:[role=dialog]`) or elements found by their text with `tag NAME "text" "closest-selector"`, so most layout changes do not break the script. When a label in the app changes, update the text it looks for.

## Changing the demo data

Edit `fixtures.ts`, run `pnpm type-check`, then seed and capture again. Keep everything invented: no real people, companies or recordings. Dates are relative to the day you seed, so "today" and "overdue" stay true.
