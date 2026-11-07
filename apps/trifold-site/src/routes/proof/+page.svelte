<script lang="ts">
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Tag from "#lib/components/Tag.svelte";
	import Terminal from "#lib/components/Terminal.svelte";
	import ThreeWays from "#lib/components/ThreeWays.svelte";
	import { Button } from "#lib/components/ui/button";
	import { CLI_URL, DEMO_URL } from "#lib/config";
	import {
		DOESNT_PROVE,
		FINDINGS,
		FINDINGS_PINNED,
		GOLDEN_DOC_URL,
		GOLDEN_RUN_DATE,
		GOLDEN_STEPS,
		GOLDEN_TEST_URL,
		KNOBS,
		PARAMS_URL,
		PRESETS,
		PRESETS_COMMAND,
		ADHOC_COMMAND,
		SIM_COMMANDS,
		SEED_7_LINES,
		SEED_42_LINES,
		TRY_IT_LINES,
		TRY_IT_NOTE,
	} from "#lib/content/proof";
	import { SCENARIO_ORGS_URL, SIMPLIFICATIONS, VERTICALS } from "#lib/verticals";

	/** Every number on this page comes from src/lib/content/proof.ts, which holds the verified runs verbatim. */
	const section = "border-t border-border py-[clamp(48px,6vw,88px)]";
	const heading = "display-3 mt-4 max-w-[26ch]";
	const text = "mt-4 max-w-[64ch] text-muted-foreground [&_strong]:text-foreground";
	const external = { rel: "noopener", target: "_blank" } as const;
	const SIMULATED = VERTICALS.filter((vertical) => vertical.status === "simulated");

	const SOURCES = [
		{ href: GOLDEN_DOC_URL, label: "The golden end-to-end check, explained", note: "packages/atm/docs/golden-e2e-check.md" },
		{ href: GOLDEN_TEST_URL, label: "The test that runs it", note: "packages/atm/tests/golden-e2e-check.test.ts" },
		{ href: PARAMS_URL, label: "The scenario knobs", note: "packages/atm/src/scenario/params.ts" },
		{ href: SCENARIO_ORGS_URL, label: "The simulated orgs", note: "packages/atm/docs/scenario-orgs.md" },
		{ href: CLI_URL, label: "The engine's source", note: "packages/atm" },
		{ href: DEMO_URL, label: "The live demo", note: "Honeycomb Hill Academy, synthetic data" },
	];
</script>

<Seo
	title="Proof, not promises"
	description="Run the engine yourself: a seeded school year gives the same numbers through the engine, hledger and DuckDB. The end-to-end check, what it found, and what it doesn't prove."
/>

<PageHero
	eyebrow="Proof · reproducible · on GitHub"
	title="Proof, not promises."
	lede="Run the simulator on your own machine and get the same hashes we did. Here is how we check the engine, what the checks found, and where they stop."
>
	<div class="flex flex-wrap items-center gap-5">
		<Button href="#three-ways">Run it yourself</Button>
		<a class="link-arrow text-foreground" href="#findings">What the check found</a>
	</div>
</PageHero>

<section class={section} id="three-ways" aria-labelledby="three-ways-title">
	<div class="container-page">
		<p class="label-mono">Same numbers, three ways</p>
		<h2 id="three-ways-title" class={heading}>One school year. Three tools. One hash.</h2>
		<p class={text}>
			The simulator generates a seeded, synthetic school year, puts it through the engine's fold, hledger and DuckDB, and
			compares one KPI hash per channel. <strong>Same seed, same events, same hash.</strong>
		</p>
		<div class="mt-10"><ThreeWays /></div>
		<div class="mt-12 grid items-start gap-8 lg:grid-cols-2 [&>*]:min-w-0">
			<div>
				<h3 class="text-[23px] font-[450]">The run, verbatim</h3>
				<p class="mt-2 mb-4 text-sm text-muted-foreground">
					atm is the engine's name until the rename to tfd lands.
				</p>
				<Terminal title="packages/atm · simulate" lines={SEED_7_LINES} />
			</div>
			<div>
				<h3 class="text-[23px] font-[450]">Try it</h3>
				<p class="mt-2 mb-4 text-sm text-muted-foreground">{TRY_IT_NOTE}</p>
				<Terminal title="try it" lines={TRY_IT_LINES} />
				<p class="mt-5 text-[15px] text-muted-foreground">
					The live demo is checked the same way: every dashboard number is checked against the engine's own export.
					<a class="font-semibold text-foreground underline" href={DEMO_URL} {...external}
						>Open the live demo ↗<span class="sr-only"> (opens in a new tab)</span></a
					>
				</p>
			</div>
		</div>
	</div>
</section>

<section class={section} id="simulate" aria-labelledby="simulate-title">
	<div class="container-page">
		<p class="label-mono">What would you simulate?</p>
		<h2 id="simulate-title" class={heading}>Turn the knobs. The hashes still match.</h2>
		<p class={text}>
			Pick a preset, change what you like, and pick a seed. Here: 120 families, 5% leaving each month, 8% of payments
			refunded, 30% paying for the year.
		</p>
		<div class="mt-8"><Terminal title="packages/atm · simulate" lines={SEED_42_LINES} /></div>
		<div class="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)] [&>*]:min-w-0">
			<div>
				<h3 class="text-[23px] font-[450]">The knobs</h3>
				<dl class="mt-4 grid gap-x-8 sm:grid-cols-2">
					{#each KNOBS as knob (knob.name)}
						<div class="grid gap-0.5 border-b border-border py-2.5">
							<dt class="num text-[13.5px] text-foreground">{knob.name}</dt>
							<dd class="text-[14.5px] text-muted-foreground">{knob.what}</dd>
						</div>
					{/each}
				</dl>
				<p class="mt-4 text-sm text-muted-foreground">
					From <a class="underline" href={PARAMS_URL} {...external}>params.ts<span class="sr-only"> (opens in a new tab)</span></a
					>, where each knob's range and meaning are defined.
				</p>
			</div>
			<div>
				<h3 class="text-[23px] font-[450]">The presets</h3>
				<p class="mt-4 text-muted-foreground">
					<code class="num rounded border border-border bg-card px-1.5 py-0.5 text-[13px] text-foreground"
						>{PRESETS_COMMAND}</code
					>
					lists every preset with its org: the school's ({PRESETS.join(", ")} and more), then a studio, a church, a SaaS
					product and a course creator, below in <a class="underline" href="#simulations">Simulations</a>.
				</p>
			</div>
		</div>
	</div>
</section>

<section class={section} id="golden-check" aria-labelledby="golden-title">
	<div class="container-page">
		<p class="label-mono">The golden end-to-end check</p>
		<h2 id="golden-title" class={heading}>The real CLI, compared byte for byte.</h2>
		<p class={text}>
			One test drives the engine the way you would, then compares everything it writes with goldens committed to the
			repo. From the full run recorded on <span class="num">{GOLDEN_RUN_DATE}</span>:
		</p>
		<ol class="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each GOLDEN_STEPS as step, index (step.title)}
				<li class="grid content-start gap-2 rounded-lg border border-border bg-card px-5 py-[18px]">
					<p class="flex items-baseline gap-2.5">
						<span class="num text-[12px] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
						<span class="font-semibold">{step.title}</span>
					</p>
					<p class="text-[15px] text-muted-foreground">{step.text}</p>
				</li>
			{/each}
		</ol>
		<p class="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
			<a class="font-semibold text-foreground underline" href={GOLDEN_DOC_URL} {...external}
				>Read how the check works ↗<span class="sr-only"> (opens in a new tab)</span></a
			>
			<a class="font-semibold text-foreground underline" href={GOLDEN_TEST_URL} {...external}
				>Read the test ↗<span class="sr-only"> (opens in a new tab)</span></a
			>
		</p>
	</div>
</section>

<section class={section} id="findings" aria-labelledby="findings-title">
	<div class="container-page">
		<p class="label-mono">What the check found</p>
		<h2 id="findings-title" class={heading}>Four findings, in plain words.</h2>
		<p class={text}>A check that never finds anything isn't checking. These are open, and we say so.</p>
		<ul class="mt-8 border-t border-border">
			{#each FINDINGS as finding (finding.id)}
				<li class="grid gap-2 border-b border-border py-5 sm:grid-cols-[72px_minmax(0,1fr)]">
					<span><Tag>{finding.id}</Tag></span>
					<div>
						<p class="font-semibold">{finding.title}</p>
						<p class="mt-1 max-w-[70ch] text-muted-foreground">{finding.text}</p>
					</div>
				</li>
			{/each}
		</ul>
		<p class="mt-5 max-w-[64ch] text-sm text-muted-foreground">{FINDINGS_PINNED}</p>
	</div>
</section>

<section class={section} id="limits" aria-labelledby="limits-title">
	<div class="container-page grid gap-8 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
		<div>
			<p class="label-mono">Where it stops</p>
			<h2 id="limits-title" class={heading}>What this doesn't prove.</h2>
		</div>
		<ul class="grid list-disc gap-3 pl-[1.2em] text-muted-foreground md:mt-9">
			{#each DOESNT_PROVE as item (item)}
				<li>{item}</li>
			{/each}
		</ul>
	</div>
</section>

<section class={section} id="simulations" aria-labelledby="simulations-title">
	<div class="container-page">
		<p class="label-mono">Simulations · invented names · synthetic data</p>
		<h2 id="simulations-title" class={heading}>A studio, a church, a SaaS product, a course creator.</h2>
		<p class={text}>
			Four invented orgs beside the school, each on the same billing rules, the same books and the same three-way check.
			None of it is a real organization's data.
		</p>
		<div class="mt-8 overflow-x-auto rounded-lg border border-border">
			<table class="w-full min-w-max border-collapse whitespace-nowrap text-left text-[14px]">
				<thead>
					<tr class="border-b border-border font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
						{#each ["Org", "Preset", "Members", "Invoices", "Refunds", "Disputes", "Gross collected", "Paying last month", "KPI hash"] as column (column)}
							<th class="px-2.5 py-2.5 font-medium" scope="col">{column}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each SIMULATED as vertical (vertical.slug)}
						{#each vertical.presets as preset (preset.name)}
							<tr class="border-b border-border last:border-0" data-preset={preset.name}>
								<th class="max-w-[11rem] px-2.5 py-2.5 font-semibold whitespace-normal" scope="row">{vertical.org}</th>
								<td class="num px-2.5 py-2.5"
									>{preset.name}<span class="block text-[12px] text-muted-foreground"
										>seed {preset.seed} · {preset.months}</span
									></td
								>
								<td class="num px-2.5 py-2.5">{preset.members}</td>
								<td class="num px-2.5 py-2.5">{preset.invoices}</td>
								<td class="num px-2.5 py-2.5">{preset.refunds}</td>
								<td class="num px-2.5 py-2.5">{preset.disputes}</td>
								<td class="num px-2.5 py-2.5">{preset.grossCollected}</td>
								<td class="num px-2.5 py-2.5"
									>{preset.payingLastMonth}{#if preset.payingNote}<span class="text-muted-foreground">&nbsp;(all yearly)</span>{/if}</td
								>
								<td class="num px-2.5 py-2.5">{preset.hash}</td>
							</tr>
						{/each}
					{/each}
				</tbody>
			</table>
			<p class="border-t border-border px-4 py-3 text-sm text-proof-text">
				<span aria-hidden="true">✓</span> Every row: atm, hledger and DuckDB gave the same KPI hash.
			</p>
		</div>
		<p class="mt-3 text-sm text-muted-foreground">
			Members is new_paying_members; invoices is payments_count; paying last month is paying_members_last_month. On
			saas-annual every plan is yearly, so nobody pays in the last month. Hashes show the first eight and last four
			characters.
		</p>
		<div class="mt-10 grid items-start gap-10 lg:grid-cols-2 [&>*]:min-w-0">
			<div>
				<h3 class="text-[23px] font-[450]">Run them</h3>
				<p class="mt-2 mb-4 text-sm text-muted-foreground">
					From packages/atm. <code>scenarios describe</code> prints the org, its knobs and copy-paste commands. Any org
					takes an ad-hoc scenario on stdin.
				</p>
				<Terminal title="packages/atm · scenarios" lines={[...SIM_COMMANDS, `$ ${ADHOC_COMMAND}`]} />
				<p class="mt-4 text-sm text-muted-foreground">
					<a class="font-semibold text-foreground underline" href={SCENARIO_ORGS_URL} {...external}
						>How the orgs are simulated ↗<span class="sr-only"> (opens in a new tab)</span></a
					>
				</p>
			</div>
			<div id="simplify">
				<h3 class="text-[23px] font-[450]">Where the simulations simplify</h3>
				<p class="mt-2 mb-4 text-sm text-muted-foreground">
					Each org is the closest honest fit to the billing engine, not an exact copy of a real business.
				</p>
				<ul class="grid list-disc gap-2 pl-[1.2em] text-muted-foreground">
					{#each SIMPLIFICATIONS as item (item)}
						<li>{item}</li>
					{/each}
				</ul>
			</div>
		</div>
	</div>
</section>

<section class={section} id="receipts" aria-labelledby="receipts-title">
	<div class="container-page grid items-end gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
		<div>
			<p class="label-mono">Receipts and seals</p>
			<h2 id="receipts-title" class={heading}>Signed receipts and sealed months ship today.</h2>
			<p class={text}>
				Every Stripe payment gets a receipt signed with Ed25519, and each month can be sealed. Check the sample receipt in
				your browser, with no account.
			</p>
		</div>
		<Button href="/verify" variant="outline">Verify a sample receipt</Button>
	</div>
</section>

<section class={section} id="sources" aria-labelledby="sources-title">
	<div class="container-page">
		<p class="label-mono">Sources</p>
		<h2 id="sources-title" class={heading}>Read it for yourself.</h2>
		<ul class="mt-6 grid gap-3">
			{#each SOURCES as source (source.href)}
				<li class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
					<a class="font-semibold text-foreground underline" href={source.href} {...external}
						>{source.label} ↗<span class="sr-only"> (opens in a new tab)</span></a
					>
					<span class="num text-[13px] text-muted-foreground">{source.note}</span>
				</li>
			{/each}
		</ul>
	</div>
</section>

<ClosingCta title="Read the source. Run the check." />
