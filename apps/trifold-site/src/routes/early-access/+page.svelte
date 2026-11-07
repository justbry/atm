<script lang="ts">
	import { onMount } from "svelte";
	import Seo from "#lib/components/Seo.svelte";
	import { Button } from "#lib/components/ui/button";
	import { Input } from "#lib/components/ui/input";
	import { Label } from "#lib/components/ui/label";
	import { CONTACT_EMAIL, FORM_ENDPOINT } from "#lib/config";

	const ROLES = [
		["school", "School or microschool"],
		["church", "Church"],
		["nonprofit", "Non-profit or co-op"],
		["studio", "Studio, gym or tutoring"],
		["saas", "SaaS or digital product"],
		["creator", "Creator or online courses"],
		["accountant", "Accountant or bookkeeper"],
		["developer", "Developer or platform"],
		["network", "School network or federation"],
	] as const;

	let role = $state("school");
	let source = $state("");
	let status = $state<"idle" | "sending" | "sent" | "error">("idle");
	let form = $state<HTMLFormElement>();

	const isAccountant = $derived(role === "accountant");

	onMount(() => {
		const params = new URLSearchParams(location.search);
		const wanted = params.get("role");
		if (wanted && ROLES.some(([id]) => id === wanted)) role = wanted;
		source = params.get("src")?.slice(0, 80) ?? "";
	});

	function mailtoFrom(data: FormData): string {
		const lines = [...data.entries()]
			.filter(([key]) => key !== "website")
			.map(([key, value]) => `${key}: ${String(value)}`);
		const subject = isAccountant ? "Trifold partner list" : "Trifold early access";
		return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
	}

	async function onSubmit(event: SubmitEvent) {
		if (!form) return;
		const data = new FormData(form);
		if (data.get("website")) {
			event.preventDefault();
			status = "sent";
			return;
		}
		if (!FORM_ENDPOINT) {
			event.preventDefault();
			window.location.href = mailtoFrom(data);
			return;
		}
		event.preventDefault();
		status = "sending";
		try {
			const response = await fetch(FORM_ENDPOINT, {
				method: "POST",
				body: data,
				headers: { accept: "application/json" },
			});
			status = response.ok ? "sent" : "error";
		} catch {
			status = "error";
		}
	}
	const field = "grid min-w-0 gap-1.5";
	const select =
		"h-[46px] w-full rounded-md border border-line-strong bg-sunk px-3.5 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid";
</script>

<Seo
	title="Early access"
	description="Become a Trifold design partner: founder onboarding, free during the pilot, and a say in the roadmap. One short form."
/>

<section class="pt-[clamp(56px,8vw,110px)] pb-[clamp(80px,10vw,140px)]">
	<div class="container-page grid items-start gap-[clamp(32px,6vw,88px)] md:grid-cols-2">
		<div>
			<p class="label-mono">{isAccountant ? "Partner list" : "Early access · design partners"}</p>
			<h1 class="display-2 mt-4">{isAccountant ? "Join the partner list." : "Get early access."}</h1>
			<p class="lede mt-[18px]">
				{isAccountant
					? "We'll send a sample client file and talk through what you'd need from us. Your firm's seats are free on every client's books (planned)."
					: "We're onboarding a small group of design partners, starting with schools in Idaho and Utah."}
			</p>
			<h2 class="label-mono mt-9 font-mono">What design partners get</h2>
			<ul class="mt-3.5 grid gap-2.5 text-[17px]">
				{#each ["Onboarding from the founder", "Free during the pilot", "A say in the roadmap", "Named in the case study, only if you want"] as item (item)}
					<li><span class="font-bold text-proof-text" aria-hidden="true">✓</span> {item}</li>
				{/each}
			</ul>
			<p class="mt-6 max-w-[52ch] text-sm text-muted-foreground">
				What happens next: the founder replies by email to set up a short call. No sales sequence, no newsletter unless you
				ask.
			</p>
		</div>

		<div class="rounded-lg border border-border bg-card p-[clamp(20px,3vw,32px)] shadow-card">
			{#if status === "sent"}
				<div role="status">
					<p class="font-display text-[26px]"><span class="text-proof-text" aria-hidden="true">✓</span> Thanks. We've got it.</p>
					<p class="text-muted-foreground">The founder will reply by email.</p>
				</div>
			{:else}
				<form
					bind:this={form}
					method="POST"
					action={FORM_ENDPOINT || `mailto:${CONTACT_EMAIL}`}
					onsubmit={onSubmit}
					class="grid gap-4"
				>
					<div class={field}><Label for="name">Name</Label><Input id="name" name="name" autocomplete="name" required /></div>
					<div class={field}>
						<Label for="email">Email</Label><Input id="email" name="email" type="email" autocomplete="email" required />
					</div>
					<div class={field}>
						<Label for="org">Organization</Label><Input id="org" name="organization" autocomplete="organization" required />
					</div>
					<div class={field}>
						<Label for="role">You are</Label>
						<select id="role" name="role" bind:value={role} class={select}>
							{#each ROLES as [id, label] (id)}
								<option value={id}>{label}</option>
							{/each}
						</select>
					</div>
					<div class="grid gap-4 sm:grid-cols-2">
						<div class={field}>
							<Label for="size">{isAccountant ? "Clients you serve" : "Families or members"}</Label>
							<Input id="size" name="size" type="number" min="0" inputmode="numeric" />
						</div>
						<fieldset class={field}>
							<legend class="mb-1.5 text-sm font-medium">Payments on Stripe?</legend>
							<div class="flex min-h-[46px] items-center gap-[18px]">
								<label class="inline-flex items-center gap-2"><input type="radio" name="stripe" value="yes" checked class="size-[18px] accent-seal" /> Yes</label>
								<label class="inline-flex items-center gap-2"><input type="radio" name="stripe" value="no" class="size-[18px] accent-seal" /> Not yet</label>
							</div>
						</fieldset>
					</div>
					<input type="hidden" name="source" value={source} />
					<div class="absolute -left-[9999px] size-px overflow-hidden" aria-hidden="true">
						<label for="website">Leave this empty</label>
						<input id="website" name="website" tabindex="-1" autocomplete="off" />
					</div>
					<Button type="submit" class="mt-1.5 w-full" disabled={status === "sending"}>
						{status === "sending" ? "Sending…" : isAccountant ? "Join the partner list" : "Get early access"}
					</Button>
					{#if status === "error"}
						<p class="text-sm text-alert-text" role="alert">
							That didn't go through. Please email <a class="underline" href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a> instead.
						</p>
					{/if}
					{#if !FORM_ENDPOINT}
						<p class="text-sm text-muted-foreground">
							This opens your email app with the form filled in. Or write to <a class="underline" href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.
						</p>
					{/if}
					<p class="text-sm text-muted-foreground">We use what you send only to contact you about the pilot.</p>
				</form>
			{/if}
		</div>
	</div>
</section>
