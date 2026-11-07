# Trifold website

The Trifold marketing site: SvelteKit 3 (Svelte 5, runes) built as a fully static site with `@sveltejs/adapter-static`,
for Cloudflare Pages. Styling is Tailwind CSS v4 (CSS-first, `src/app.css`), with shadcn-svelte components where they
save work: Button, Accordion (FAQs off the homepage), Toggle Group and Slider (pricing), Sheet (mobile menu), Input,
Textarea and Label. A standalone package: its own `package.json` and `bun.lock`, not part of the repo's workspaces.

## Commands

```sh
bun install          # dependencies
bun run dev          # dev server on http://localhost:5173
bun run build        # prerender every route into build/
bun run preview      # serve build/ on http://localhost:4173
bun test             # browser verifier vs tfd's own checks; the agent files (run `bun run build` first)
bun run samples      # regenerate src/lib/samples/*.json with tfd (new demo key each run)
bun run check        # svelte-check
```

## Layout

- `src/app.css` the whole design system: brand tokens mapped onto shadcn's variables (`--background`, `--primary` =
  saffron seal, `--ring`, …) for light (`:root`, "ink and foil") and dark (`.dark`, "the vault at night"); Trifold's own
  tokens (`--proof`, `--seal`, `--ember`, `--witness`, `--alert`, `--fg-dim`, `--proof-blend`, `--seal-surface`) exposed
  through `@theme` so `text-proof`, `bg-seal`, `border-ember` work; a few `@utility` helpers (`label-mono`, `display-1..3`,
  `lede`, `num`, `container-page`); and a small effects layer for what utilities can't say (seal glow and foil, fold line,
  reveal, proof sweep, prose).
- Dark mode is the `.dark` class on `<html>`, set before first paint by the inline script in `src/app.html` (system
  default, toggle persisted in `localStorage` as `trifold-theme`). Its CSP hash is computed by `theme-script.ts`.
- `src/lib/components/ui/` shadcn-svelte components (`components.json`, alias `#lib`). They carry the brand styling as
  their defaults, and `cn` is plain `clsx` without tailwind-merge (saves ~7 KB gzip per page): add only non-conflicting
  classes (spacing, width) at call sites. bits-ui emits `data-state`/`data-orientation`, so variants are written as
  `data-[state=open]:` rather than `data-open:`.
- SvelteKit 3 removed `$lib`; this app uses Node subpath imports (`#lib/...`, see `package.json` `imports`).
- `src/routes/` pages; long-form copy lives in markdown under `src/content/` (mdsvex), so it can be edited as text.
- `src/lib/components/` header, footer, hero canvas (`HeroField`), ledger panel, receipt card, verifiers, pricing.
- `src/lib/verify/` the in-browser verifier: `core.ts` is a line-for-line port of tfd's canonical bytes, sha256,
  Ed25519 (strict RFC 8032) and schema checks; `check.ts` adds the books and seal checks. It loads on first use.
- `src/lib/samples/` the sample receipt, a tampered copy, the demo public key, the sample school's October books and
  seal, all made by `scripts/make-samples.ts` from `packages/atm/src`. The private key is generated in memory and
  discarded; it is never written.
- `src/lib/config.ts` site constants, including `SITE_ORIGIN`, `DEMO_URL` (the live demo; every demo link reads it) and
  `PAGES` (every page; the build fails if one is missing).
- `src/lib/content/proof.ts` the verified simulator runs, try-it commands, knobs and the golden end-to-end check with
  its findings, shared by `/proof`, `/for/developers` and `llms.txt` (`proof-summary.ts` holds the part the homepage
  shows). `src/lib/verticals.ts` the verticals: the school's live dashboard and four simulated orgs with their verified preset
  numbers. The homepage gallery gets a compact copy inlined by `vite.config.ts` (`__GALLERY__`, `src/lib/gallery.ts`), so
  it doesn't ship the module; restart `bun run dev` after editing it.

## Licensing

The site's verifier (`src/lib/verify/*.ts`) is Apache-2.0 and carries an SPDX header. The tfd engine it ports is FSL-1.1-ALv2 (source-available; each release becomes Apache-2.0 two years after it ships), except the receipt and seal format, spec and verifier, which are Apache-2.0, and the test vectors, which are CC0-1.0. In copy, never call the engine "open source"; say "source-available" or "free to self-host". The engine is `tfd` (the `atm` command until the rename lands); keep `packages/atm/...` paths and `justbry/atm` links as they are.

## Agent files

`bun run build` runs `scripts/agent-files.ts` after `vite build`. It writes a markdown mirror of every page
(`/pricing.md`, the homepage at `/index.md`) from the page's `<main>` with turndown, so a mirror can't drift from its
page; `llms-full.txt`; `llms.txt` (llmstxt.org: summary and facts from `src/lib/content/llms.ts`, then every page);
`/samples/*.json`; and a markdown, noindex block per mirror in `build/_headers`. Mark an element `data-agent="skip"` to
keep it out of the mirrors (canvas, toggles, duplicate visuals), or `data-agent-md="<name>"` to replace it with markdown
from a data module (the pricing cards, which show one toggle state, become every price). `/brand` is mirrored but left
out of llms.txt (`AGENT_EXCLUDED`). The footer's "For agents" note (`AgentNote.svelte`) is skipped in the mirrors.

## Comparisons

`src/lib/compare/competitors.ts` holds every comparison. Add an entry to `COMPETITORS` and `/compare`,
`/compare/trifold-vs-<slug>`, the footer's Compare column, `sitemap.xml` and `llms.txt` all follow (restart `bun run
dev` to see the footer change: its links are inlined by `vite.config.ts`). Every claim about a competitor needs a page
in its `sources`; "Not stated" means its public pages don't say. Trifold's prices come from `src/lib/pricing/data.ts`.

## Placeholders to replace before launch

- **Domain.** `SITE_ORIGIN` in `src/lib/config.ts` is `https://gettrifold.com`, which is not registered yet. Canonical
  links, Open Graph URLs, `sitemap.xml` and `robots.txt` all read it.
- **Contact address.** `CONTACT_EMAIL` (`hello@gettrifold.com`) in the same file.
- **People block** on the homepage and the founder section of `/about`: marked placeholders.
- **Legal** (`src/content/legal.md`): draft stubs, `noindex`.

## The early-access form

`/early-access` is static. Set `PUBLIC_FORM_ENDPOINT` at build time to any form service URL that accepts a POST of form
fields (Formspree, Basin, a Cloudflare Worker, ...):

```sh
PUBLIC_FORM_ENDPOINT=https://example.com/f/abc bun run build
```

When it is unset, submitting opens the visitor's email app with the fields filled in, addressed to `CONTACT_EMAIL`.
`?role=school|church|nonprofit|studio|saas|creator|accountant|developer|network` preselects the role; `?src=` is passed through as a hidden
`source` field for tracking outreach links. Once an endpoint is chosen, narrow `connect-src`/`form-action` in
`static/_headers` to its origin.

## Deploy to Cloudflare Pages

Direct upload:

```sh
bun run build
bunx wrangler pages deploy build --project-name trifold-site
```

Or Git integration: build command `bun run build`, output directory `build`, root directory `apps/trifold-site`
(add `PUBLIC_FORM_ENDPOINT` as an environment variable if used). `wrangler.toml` names the project and its output.

`static/_headers` sets the security headers and long-lived caching for `/_app/immutable/*`. `build/404.html` is served
for unknown paths.

## Budget

Homepage JavaScript: about 77 KB gzip, measured as every script the page preloads; the brand guide's
target is 60 KB. Where it goes: Svelte runtime ~22 KB, SvelteKit client router ~15 KB, the homepage itself ~14 KB
(Tailwind class strings live in its hydration templates), tailwind-variants + clsx + Button ~5 KB, verifier UI and
receipt card ~6 KB, the "See it live" and "Simulate your organization" sections (static markup and the inlined
gallery cards, no new behaviour) ~5 KB, the rest small. Kept off the homepage on purpose: the verifier's crypto and the sample books (load on
first Verify), the Sheet and bits-ui dialog (load on first menu open), and the Accordion (the homepage FAQ is native
`<details>`). The plain-CSS version of this site measured ~60 KB, so Tailwind plus shadcn costs about 12 KB here.
