# 20 Forms, 40+ Designs

A browser playground for comparing the same form across React component libraries.
Choose forms and libraries, compare their native controls, and switch between light
and dark themes. Each preview runs in an iframe so one library's CSS reset does not
change another library's appearance.

This folder contains **documentation only**. Run the application from the
[implementation repository](https://github.com/evgenyvinnik/20forms-20designs), or
open the [live demo](https://evgenyvinnik.github.io/20forms-20designs/).

## What the project demonstrates

- Multiple form and library selections, with previews grouped by library or form.
- Twenty form types, including login, registration, checkout, onboarding, and search.
- Independent library applications, each with its own styles and React root.
- A theme toggle and a “Light only” indicator for entries marked without dark mode.
- Comparison preferences saved in local storage and encoded in URL parameters.
- Links from preview cards to the corresponding form's source code.
- Static build assembly and deployment to GitHub Pages.

These are UI demonstrations. Login and checkout forms do not provide authentication
or payment services; for example, the MUI login handler prevents submission and
calls a demo alert. There is no application backend or database to configure.

## Source snapshot and scope

Reviewed on 2026-09-09 against upstream commit
[`bc34aba`](https://github.com/evgenyvinnik/20forms-20designs/tree/bc34aba76a4cabe9bfe545bc8dccf3689808e482).
The shell registry has **46 enabled comparison entries**, including the unstyled
“React + No CSS” baseline, and 20 forms. That permits 920 form/library selections;
it is a catalog count, not a claim that every combination has passed visual or
behavioral tests. The source contains 47 app packages: one shell and 46 previews.

The active catalog is defined in
[apps/shell/src/config.ts](https://github.com/evgenyvinnik/20forms-20designs/blob/bc34aba76a4cabe9bfe545bc8dccf3689808e482/apps/shell/src/config.ts).
Consult it for current names and theme flags rather than relying on the historical
“20 Forms, 40 Designs” title or a duplicated library list.

## Architecture overview

```
┌──────────────────────────────┐
│ Shell: selection and grouping│
│ React + Zustand              │
└──────────────┬───────────────┘
               │ iframe URLs + theme messages
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌─────────────┐
│ Library A   │  │ Library B   │
│ Own document│  │ Own document│
└─────────────┘  └─────────────┘
```

Bun workspaces organize the applications; Vite builds them separately. The shell
uses TypeScript and Zustand, while many preview apps use JavaScript/JSX. The build
script builds the shell first, then the existing consolidated preview apps using
up to 14 workers. It assembles their output into one static deployment.

See [architecture.md](./architecture.md) for source evidence, implementation
limitations, and a separate production design. The
[frontend](./system-design-answer-frontend.md),
[backend/infrastructure](./system-design-answer-backend.md), and
[fullstack](./system-design-answer-fullstack.md) answers present proposed designs
for an interview.

## Run the complete comparison locally

Install Bun and a compatible Node.js runtime. The reviewed upstream deployment
workflow uses Node.js 22; its package manifest declares Bun >= 1.0.0. Commands below
run in the **external repository**, not this documentation folder.

```bash
git clone https://github.com/evgenyvinnik/20forms-20designs.git
cd 20forms-20designs
bun install
bun run build
bun run preview
```

Open the URL printed by the preview server, normally
[localhost:3000/20forms-20designs/](http://localhost:3000/20forms-20designs/).
It tries another port if 3000 is occupied. To choose one explicitly:

```bash
PORT=4000 bun run preview
```

The complete preview serves the assembled shell and library assets with their
production base paths. No Docker or native database installation is needed because
this application has no infrastructure services.

## Develop and check the shell

```bash
# Shell development server; does not start every library app
bun run dev:shell

# Lint source across the external monorepo
bun run lint

# Run the shell's browser tests
cd apps/shell
bunx playwright install chromium
bunx playwright test --project=chromium
```

The Playwright configuration starts the shell Vite server. Its tests cover controls,
preview containers, URL state, and persistence; they do not establish that all
built library documents load successfully or render equivalent forms. Use the
assembled production preview to inspect iframe contents and asset paths.

## Known limitations in the reviewed source

- Every selected form/library pair mounts a frame immediately. Selecting the full
  catalog can create 920 frames; lazy loading and a bounded frame cache are future work.
- Theme changes update both frame URLs and send `SET_THEME` messages, so changing
  theme can reload a document and reset form input. Frames are removed on deselection.
- URLs encode partial selections, but omit empty and all-selected lists. Those
  states can restore differently in another browser because omitted values fall
  back to saved preferences or defaults. URL history is replaced, not appended.
- Preview build failures are logged without necessarily failing the overall build.
  Check the build summary and assembled previews before relying on the output.
- The iframe setup separates styles but is not a sandbox for arbitrary untrusted
  code. The current project embeds its own curated library apps.

This documentation review inspected source and configuration; it did not run a
full upstream build or claim measured load times, bundle budgets, or visual parity.
