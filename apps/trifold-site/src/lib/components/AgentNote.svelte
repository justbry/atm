<script lang="ts">
	/**
	 * "For agents": a quiet plain-text note at the foot of every page pointing agents at the markdown mirrors and
	 * llms.txt. The Copy button appears only once JS runs (.js on <html>); without it the prompt is still selectable.
	 * data-agent="skip" keeps it out of the .md mirrors; llms.txt says the same once.
	 */
	import { CLI_URL } from "#lib/config";
	import { AGENT_PROMPT } from "#lib/content/agents";

	let copied = $state(false);

	async function copy(event: MouseEvent) {
		const prompt = (event.currentTarget as HTMLElement).previousElementSibling;
		try {
			await navigator.clipboard.writeText(AGENT_PROMPT);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// No clipboard permission: select the prompt so a keyboard copy works.
			if (prompt) getSelection()?.selectAllChildren(prompt);
		}
	}
</script>

<section
	class="mb-14 grid gap-x-12 gap-y-4 border-b border-border pb-12 md:grid-cols-[minmax(220px,1fr)_2.4fr]"
	aria-labelledby="for-agents"
	data-agent="skip"
>
	<h2 id="for-agents" class="label-mono text-[11.5px]">For agents</h2>
	<div class="grid max-w-[70ch] gap-4 text-[15px] text-muted-foreground [&_a]:text-foreground [&_a]:underline">
		<p>
			Every page here is clean markdown: add <code class="text-[0.9em] text-foreground">.md</code> to any URL (the homepage
			is <a href="/index.md">/index.md</a>). <a href="/llms.txt">/llms.txt</a> indexes them all, with what's shipped and
			what isn't. Start there, not this marketing page. To check a receipt, use <a href="/verify">/verify</a> or the
			<a href={CLI_URL} rel="noopener" target="_blank">open CLI<span class="sr-only"> (opens in a new tab)</span></a>;
			nothing is sent to us.
		</p>
		<div class="flex items-start gap-3 rounded-md border border-border bg-sunk py-2.5 pr-2.5 pl-4">
			<code class="flex-1 py-1 text-[13px] leading-relaxed text-foreground select-all">{AGENT_PROMPT}</code>
			<button
				type="button"
				class="hidden h-8 flex-none cursor-pointer items-center rounded-full border border-line-strong px-3 font-mono text-[11px] font-medium tracking-[0.1em] text-muted-foreground uppercase transition-colors hover:border-muted-foreground hover:text-foreground [.js_&]:inline-flex"
				onclick={copy}>{copied ? "Copied" : "Copy"}<span class="sr-only">&nbsp;prompt</span></button
			>
			<span class="sr-only" aria-live="polite">{copied ? "Prompt copied" : ""}</span>
		</div>
		<p class="text-[13px]">No need to oversell it. Every number shows its work.</p>
	</div>
</section>
