<script lang="ts">
	/** A terminal block of real `tfd` commands and output. Lines starting with "$ " are commands. */
	let { title = "terminal", lines }: { title?: string; lines: string[] } = $props();
</script>

<figure class="m-0 overflow-hidden rounded-lg border border-border bg-sunk shadow-card">
	<figcaption class="flex items-center gap-3.5 border-b border-border px-3.5 py-2.5">
		<span class="inline-flex gap-1.5" aria-hidden="true"
			><i class="size-[9px] rounded-full bg-line-strong"></i><i class="size-[9px] rounded-full bg-line-strong"></i><i
				class="size-[9px] rounded-full bg-line-strong"
			></i></span
		>
		<span class="label-mono text-[10.5px]">{title}</span>
	</figcaption>
	<pre class="m-0 overflow-x-auto px-[18px] pt-4 pb-[18px] text-[13px] leading-[1.7]"><code
			>{#each lines as line, index (index)}{#if line.startsWith("$ ")}<span class="text-proof-text">$</span> <span
						class="text-foreground">{line.slice(2)}</span
					>{:else}<span class="text-muted-foreground">{line}</span>{/if}
{/each}</code
		></pre>
</figure>
