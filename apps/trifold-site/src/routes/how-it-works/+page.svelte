<script lang="ts">
	import ClosingCta from "#lib/components/ClosingCta.svelte";
	import PageHero from "#lib/components/PageHero.svelte";
	import Seo from "#lib/components/Seo.svelte";
	import Terminal from "#lib/components/Terminal.svelte";
	import ThreeChecks from "#lib/components/ThreeChecks.svelte";
	import Content from "../../content/how-it-works.md";
</script>

<Seo
	title="How it works"
	description="One payment, three records, a monthly seal. How Trifold turns Stripe payments into balanced books, signed receipts and sealed months, and what each check catches."
/>

<PageHero
	eyebrow="How it works"
	title="One payment, three records, one seal."
	lede="Every Stripe payment becomes balanced books and a receipt the payer keeps. At month end, a seal fixes the month's fingerprint. Here is each step, and what each check catches."
>
	<ThreeChecks />
</PageHero>

<section class="border-t border-border py-[clamp(48px,6vw,88px)]">
	<div class="container-page grid items-start gap-[clamp(32px,5vw,72px)] lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
		<div class="prose"><Content /></div>
		<aside>
			<div class="grid gap-3.5 lg:sticky lg:top-24">
				<p class="label-mono">The same steps, in the engine's CLI</p>
				<Terminal
					title="tfd · sample school"
					lines={[
						"$ tfd receipt --root . --school sch_juniper --key juniper.pem --key-id juniper-2026-10",
						'{"receipt":{"amount":80000,"currency":"usd",…},"key_id":"juniper-2026-10","sig":"Gijb…kJAw"}',
						"$ tfd seal --root . --school sch_juniper --month 2026-10 --key juniper.pem --key-id juniper-2026-10",
						'{"seal":{"month":"2026-10","events":214,…},"key_id":"juniper-2026-10","sig":"…"}',
						"$ tfd verify receipt receipt.json --keys keys.json --root . --school sch_juniper",
						'{"ok":true}',
						"$ tfd verify seals --root . --school sch_juniper --keys keys.json",
						'{"ok":true,"seals":[{"month":"2026-10","verdict":"ok"}],"unsealedLate":[]}',
						"$ tfd journal --root . --school sch_juniper --month 2026-10",
						"2026-10: 214 transactions; unchanged",
					]}
				/>
				<p class="text-sm text-muted-foreground">Output shortened. Commands from the engine's source on GitHub (the atm command until the rename lands).</p>
			</div>
		</aside>
	</div>
</section>

<ClosingCta
	title="See a receipt check itself."
	primary={{ href: "/verify", label: "Verify a sample receipt" }}
	secondary={{ href: "/early-access", label: "Get early access" }}
	note=""
/>
