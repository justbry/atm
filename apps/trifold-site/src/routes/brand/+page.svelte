<script lang="ts">
	import Mark from "#lib/components/Mark.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import ThreeChecks from "#lib/components/ThreeChecks.svelte";
	import Wordmark from "#lib/components/Wordmark.svelte";

	const COLORS = [
		{ name: "Ink", token: "--background", dark: "#07090F", light: "#F7F3EA", use: "The page" },
		{ name: "Raised", token: "--card", dark: "#0E1424", light: "#FFFDF8", use: "Cards and panels" },
		{ name: "Text", token: "--foreground", dark: "#E9ECF4", light: "#16203A", use: "Text and links" },
		{ name: "Muted", token: "--muted-foreground", dark: "#9AA3B8", light: "#5B6680", use: "Secondary text" },
		{ name: "Ledger green", token: "--proof", dark: "#5BE3A1", light: "#2F7D5B", use: "Matched, verified, ✓" },
		{ name: "Saffron", token: "--seal (--primary)", dark: "#F2B447", light: "#C98A22", use: "Sealed months, primary action" },
		{ name: "Ember", token: "--ember", dark: "#FF9B54", light: "#C2672A", use: "The next chapter" },
		{ name: "Dawn blue", token: "--witness", dark: "#7FB8FF", light: "#2D6BC4", use: "Reserved for the witness" },
		{ name: "Clay", token: "--alert", dark: "#E07A5F", light: "#B5533C", use: "Mismatches and warnings only" },
	];

	const NAMES = [
		["Trifold", "The company, the customer brand and the hosted service."],
		["tfd", "The engine and its command-line tool (the atm command until the rename lands). Source-available on GitHub."],
		["Rifo", 'The AI assistant, said "REE-foh". On the roadmap; it never computes a number.'],
	] as const;

	const WORDS = [
		["check, verify, signed, sealed", "blockchain, crypto, immutable"],
		["books, receipts, close, families, members", '"AI magic", "autopilot", "set and forget"'],
		['"append-only", "replayable"', '"unhackable", "100% accurate"'],
		['"with your CPA"', '"we do your taxes", "automated filing"'],
		['"Get early access", "design partner"', '"Start free" (until the hosted service opens)'],
	] as const;
	const DARK_TILE = "--background:#07090f;--foreground:#e9ecf4;--seal:#f2b447;--border:#ffffff14;--muted-foreground:#9aa3b8";
	const LIGHT_TILE = "--background:#f7f3ea;--foreground:#16203a;--seal:#c98a22;--border:#e4dccb;--muted-foreground:#5b6680";
	const section = "border-t border-border py-[clamp(48px,6vw,88px)]";
	const intro = "mt-3 max-w-[64ch] text-muted-foreground";
</script>

<Seo
	title="Brand"
	description="Trifold's press kit: the mark and wordmark, colors in dark and light, type, and the basics of how we write."
/>

<PageHero
	eyebrow="Brand · press kit"
	title="Light is never decoration."
	lede="Money arrives as a dim stream, and each check gives off light. Here is how the Trifold brand looks, reads and sounds."
/>

<section class={section}>
	<div class="container-page">
		<h2 class="display-3">The mark</h2>
		<p class={intro}>
			Three panels folding into a triangle: a receipt folded in thirds, and the three records of every dollar. The hero
			animation ends on this same fold.
		</p>
		<div class="mt-7 grid gap-4 md:grid-cols-3">
			{#each [{ style: DARK_TILE, caption: "On ink", mark: false }, { style: LIGHT_TILE, caption: "On paper", mark: false }, { style: DARK_TILE, caption: "The mark alone, for small spaces and the favicon", mark: true }] as tile (tile.caption)}
				<figure class="m-0 overflow-hidden rounded-lg border border-border bg-background text-foreground" style={tile.style}>
					<div class="grid h-[180px] place-items-center">
						{#if tile.mark}<Mark size={96} />{:else}<Wordmark size={44} class="[&>span:last-child]:text-[38px]" />{/if}
					</div>
					<figcaption class="border-t border-border px-3.5 py-2.5 text-[13px] text-muted-foreground">{tile.caption}</figcaption>
				</figure>
			{/each}
		</div>
		<div class="mt-6 grid gap-6 md:grid-cols-2">
			<div>
				<p class="label-mono text-proof-text">Do</p>
				<ul class="mt-2 grid list-disc gap-1.5 pl-[1.1em] text-muted-foreground">
					<li>Give the mark clear space at least the width of one panel.</li>
					<li>Use it in saffron on ink or paper, as shown.</li>
					<li>Write the name as "Trifold", one word, capital T.</li>
				</ul>
			</div>
			<div>
				<p class="label-mono text-alert-text">Don't</p>
				<ul class="mt-2 grid list-disc gap-1.5 pl-[1.1em] text-muted-foreground">
					<li>Recolor, outline, rotate or add effects to the mark.</li>
					<li>Write "TriFold", "Tri-fold" or "TRIFOLD" in running text.</li>
					<li>Use the mark to suggest we endorse a product or service.</li>
				</ul>
			</div>
		</div>
		<p class="mt-5 text-sm text-muted-foreground [&_a]:underline">
			Files: <a href="/favicon.svg" download>mark (SVG)</a> · <a href="/apple-touch-icon.png" download>mark (PNG, 180px)</a>
			· <a href="/og.png" download>social card (PNG, 1200×630)</a>
		</p>
	</div>
</section>

<section class={section}>
	<div class="container-page">
		<h2 class="display-3">Color</h2>
		<p class={intro}>
			Two modes, each with its own physics. Dark is the vault at night, lit from inside by proofs. Light is ink and foil: a
			ledger page on a sunlit desk, stamped and foiled. Never two glow colors in one view. No purple.
		</p>
		<div class="mt-7 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
			{#each COLORS as color (color.token)}
				<div>
					<div class="mb-2.5 grid h-[72px] grid-cols-2 overflow-hidden rounded-md border border-border">
						<span style="background: {color.dark}" title="Dark {color.dark}"></span>
						<span style="background: {color.light}" title="Light {color.light}"></span>
					</div>
					<p class="font-semibold">{color.name}</p>
					<p class="num text-sm text-muted-foreground">{color.dark} · {color.light}</p>
					<p class="text-sm text-muted-foreground">{color.use}</p>
				</div>
			{/each}
		</div>
	</div>
</section>

<section class={section}>
	<div class="container-page">
		<h2 class="display-3">Type</h2>
		<div class="mt-6 grid gap-4 md:grid-cols-3">
			<div class="grid content-start gap-3.5 rounded-lg border border-border bg-card p-[22px]">
				<p class="label-mono">Display · Fraunces</p>
				<p class="font-display text-[38px] leading-[1.05] font-[340] tracking-[-0.02em] [font-variation-settings:'opsz'_144,'SOFT'_50,'WONK'_1]">Books that show their work.</p>
				<p class="text-sm text-muted-foreground">Weights 300–400, high optical size, soft. The hero alone turns on Wonk.</p>
			</div>
			<div class="grid content-start gap-3.5 rounded-lg border border-border bg-card p-[22px]">
				<p class="label-mono">Body and UI · Inter</p>
				<p class="text-[19px]">Every Stripe payment becomes a signed receipt your families can check.</p>
				<p class="text-sm text-muted-foreground">16–18px for reading.</p>
			</div>
			<div class="grid content-start gap-3.5 rounded-lg border border-border bg-card p-[22px]">
				<p class="label-mono">Labels and numbers · JetBrains Mono</p>
				<p class="num text-xl tracking-[0.08em]">03 · PROOF &nbsp; 171,400.00</p>
				<p class="text-sm text-muted-foreground">Tabular figures on every number; uppercase labels tracked 0.12em.</p>
			</div>
		</div>
	</div>
</section>

<section class={section}>
	<div class="container-page grid items-start gap-[clamp(32px,5vw,72px)] md:grid-cols-2">
		<div>
			<h2 class="display-3">Voice</h2>
			<p class={intro}>
				Calm, plain and exact, like a trusted bookkeeper. Short sentences, real numbers. We say what ships, and we mark
				everything else Next or Later.
			</p>
			<div class="mt-5"><ThreeChecks /></div>
			<h3 class="mt-8 text-[22px] font-[420]">Names</h3>
			<dl class="mt-3 grid gap-2.5">
				{#each NAMES as [name, what] (name)}
					<div class="grid grid-cols-[80px_1fr] gap-3">
						<dt class="font-mono text-ember-text dark:text-seal">{name}</dt>
						<dd class="text-muted-foreground">{what}</dd>
					</div>
				{/each}
			</dl>
		</div>
		<div class="rounded-lg border border-border bg-card px-5 py-2">
			<div class="label-mono grid grid-cols-2 gap-4 border-b border-border py-3">
				<span class="text-proof-text">Use</span><span class="text-alert-text">Avoid</span>
			</div>
			{#each WORDS as [use, avoid] (use)}
				<div class="grid grid-cols-2 gap-4 border-b border-border py-3 text-[15px] last:border-0">
					<span>{use}</span><span class="text-muted-foreground">{avoid}</span>
				</div>
			{/each}
		</div>
	</div>
</section>

<section class={section}>
	<div class="container-page">
		<p class="text-muted-foreground [&_a]:underline">
			Press questions: <a href="/about">contact us</a>. Trademark use: see the <a href="/legal#trademark">trademark policy</a> (draft).
		</p>
	</div>
</section>
