import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { mdsvex } from "mdsvex";
import { defineConfig } from "vite";
import { COMPETITORS, compareHref } from "./src/lib/compare/competitors.ts";
import { galleryCards } from "./src/lib/verticals.ts";
import { THEME_SCRIPT_HASH } from "./theme-script.ts";

const AGENT_FILE = /(\.md|^\/llms(-full)?\.txt|^\/samples\/[\w-]+\.json)$/;

export default defineConfig({
	envPrefix: ["VITE_", "PUBLIC_"],
	// The footer's Compare column, inlined at build time so the comparisons data never ships to the browser (and the
	// site needs no server load, which would add SvelteKit's data-fetching code to every page). See src/lib/compare/links.ts.
	define: {
		__COMPARE_LINKS__: JSON.stringify(
			COMPETITORS.map((competitor) => ({
				href: compareHref(competitor.slug),
				label: `vs ${competitor.name}`,
			})),
		),
		// The homepage's verticals gallery, inlined the same way (src/lib/gallery.ts).
		__GALLERY__: JSON.stringify(galleryCards()),
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			extensions: [".svelte", ".md", ".svx"],
			preprocess: [mdsvex({ extensions: [".md", ".svx"] })],
			adapter: adapter({
				pages: "build",
				assets: "build",
				fallback: "404.html",
				precompress: false,
				strict: true,
			}),
			// Prerendered pages get a <meta http-equiv> CSP with hashes of SvelteKit's own inline bootstrap script.
			// The theme script in app.html is hashed by hand (theme-script.ts); `bun test` checks the hash stays current.
			csp: {
				mode: "hash",
				directives: {
					"script-src": ["self", THEME_SCRIPT_HASH],
				},
			},
			prerender: {
				// The agent files (*.md mirrors, llms.txt, llms-full.txt, /samples/*.json) are written after the build by
				// scripts/agent-files.ts, so links to them can't resolve while prerendering. Every other 404 still fails.
				handleHttpError: ({ path, message }) => {
					if (AGENT_FILE.test(path)) return;
					throw new Error(message);
				},
				handleMissingId: "fail",
			},
		}),
	],
});
