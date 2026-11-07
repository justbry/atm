<script lang="ts">
	import ForPage from "#lib/components/ForPage.svelte";
	import Terminal from "#lib/components/Terminal.svelte";
	import { CLI_URL } from "#lib/config";
	import { ADHOC_COMMAND, SEED_42_LINES, TRY_IT_LINES, TRY_IT_NOTE } from "#lib/content/proof";
	import Body from "../../../content/for/developers.md";
</script>

<ForPage
	eyebrow="For developers and platforms"
	seoTitle="For developers"
	description="A provable ledger for credits, plans and bookings: replay Stripe events into double-entry books, sign Ed25519 receipts and seal months. Source on GitHub, free CLI."
	title="A provable ledger for credits, plans and bookings."
	subhead="tfd replays Stripe events into double-entry books, signs Ed25519 receipts and seals months. Its source is public on GitHub and free to self-host, with a free CLI, open receipt and seal formats, and test vectors."
	points={[
		{ text: "Deterministic: the same events in give the same books and the same signatures out." },
		{ text: "Export to Parquet and hledger; verify receipts and seals with the CLI or your own code." },
		{ text: "Hosted service, a hash chain per event and the witness are on the roadmap.", note: "Next" },
	]}
	cta={{ href: CLI_URL, label: "Install the CLI", code: true }}
	secondary={{ href: "/verify", label: "Try the verifier" }}
	body={Body}
	closingTitle="Read the source. Run the check."
	closingNote="The engine is source-available (FSL-1.1-ALv2); each release becomes Apache-2.0 after two years. The verifier and receipt format are Apache-2.0."
>
	{#snippet aside()}
		<Terminal
			title="tfd · verify"
			lines={[
				"$ tfd keys new --out keys --id juniper-2026-10",
				"$ tfd receipt --root . --school sch_juniper --key keys/juniper-2026-10.private.pem --key-id juniper-2026-10 --event 01M41M0YW0JH3ARC874HFM8291 > receipt.json",
				"$ tfd verify receipt receipt.json --keys keys/keys.json",
				'{"ok":true}',
				"$ sed -i '' 's/80000/120000/' receipt.json && tfd verify receipt receipt.json --keys keys/keys.json",
				'{"ok":false,"reason":"bad_signature"}',
			]}
		/>
		<div class="mt-[clamp(40px,5vw,64px)] grid items-start gap-8 lg:grid-cols-2 [&>*]:min-w-0">
			<div>
				<p class="label-mono">Same numbers, three ways</p>
				<h2 class="display-3 mt-3.5">Run the simulator.</h2>
				<p class="mt-3 mb-5 text-muted-foreground [&_a]:underline">
					A seeded school year through the engine, hledger and DuckDB, one KPI hash each. {TRY_IT_NOTE} See
					<a href="/proof">the proof</a> for the output and the end-to-end check.
				</p>
				<Terminal title="try it" lines={TRY_IT_LINES} />
			</div>
			<div>
				<p class="label-mono">What would you simulate?</p>
				<h2 class="display-3 mt-3.5">Turn the knobs.</h2>
				<p class="mt-3 mb-5 text-muted-foreground">
					Members, churn, refunds, yearly prepay, disputes, seat changes, upgrades, currency and Stripe's fees are all
					knobs. Presets cover a school, a studio, a church, a SaaS product and a course creator.
				</p>
				<Terminal title="packages/atm · simulate" lines={SEED_42_LINES} />
			</div>
		</div>
		<div class="mt-[clamp(40px,5vw,64px)]">
			<p class="label-mono">Any org, ad hoc</p>
			<h2 class="display-3 mt-3.5">Simulate your own org.</h2>
			<p class="mt-3 mb-6 max-w-[64ch] text-muted-foreground [&_a]:underline">
				Give an org and some knobs on stdin. The simulated SaaS product and course creator have their own pages:
				<a href="/for/saas">SaaS and digital products</a> and <a href="/for/creators">creators and online courses</a>.
				See <a href="/proof#simplify">where the simulations simplify</a>.
			</p>
			<Terminal title="packages/atm · ad-hoc org scenario" lines={[`$ ${ADHOC_COMMAND}`]} />
		</div>
	{/snippet}
</ForPage>
