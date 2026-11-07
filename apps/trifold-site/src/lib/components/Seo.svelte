<script lang="ts">
	import { page } from "$app/state";
	import { DEFAULT_DESCRIPTION, OG_IMAGE, SITE_NAME, SITE_ORIGIN } from "#lib/config";

	let {
		title,
		description = DEFAULT_DESCRIPTION,
		noindex = false,
		markdown = true,
	}: { title: string; description?: string; noindex?: boolean; markdown?: boolean } = $props();

	const fullTitle = $derived(title === SITE_NAME ? title : `${title} · ${SITE_NAME}`);
	const url = $derived(`${SITE_ORIGIN}${page.url.pathname === "/" ? "/" : page.url.pathname}`);
	/** The page's markdown mirror, written after the build by scripts/agent-files.ts. */
	const markdownUrl = $derived(`${SITE_ORIGIN}${page.url.pathname === "/" ? "/index" : page.url.pathname}.md`);
</script>

<svelte:head>
	<title>{fullTitle}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	{#if markdown}<link rel="alternate" type="text/markdown" href={markdownUrl} />{/if}
	{#if noindex}<meta name="robots" content="noindex" />{/if}
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:title" content={fullTitle} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={`${SITE_ORIGIN}${OG_IMAGE}`} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="Trifold: books that show their work." />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={fullTitle} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={`${SITE_ORIGIN}${OG_IMAGE}`} />
</svelte:head>
