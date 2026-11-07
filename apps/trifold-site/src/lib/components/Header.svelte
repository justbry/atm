<script lang="ts">
	import type { Component } from "svelte";
	import { page } from "$app/state";
	import { Button } from "#lib/components/ui/button";
	import { NAV } from "#lib/config";
	import AudienceMenu from "./AudienceMenu.svelte";
	import ThemeToggle from "./ThemeToggle.svelte";
	import Wordmark from "./Wordmark.svelte";

	let scrolled = $state(false);
	let menuOpen = $state(false);
	// The Sheet (and bits-ui) loads only when someone opens the menu, so it costs no page anything up front.
	let MobileNav = $state<Component<{ open?: boolean }>>();

	const isCurrent = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);

	async function openMenu() {
		MobileNav ??= (await import("./MobileNav.svelte")).default as Component<{ open?: boolean }>;
		menuOpen = true;
	}

	$effect(() => {
		const onScroll = () => {
			scrolled = window.scrollY > 8;
		};
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	});
</script>

<a
	class="absolute -top-24 left-3 z-[100] rounded-md bg-primary px-3.5 py-2.5 font-semibold text-primary-foreground no-underline focus:top-3"
	href="#main">Skip to content</a
>

<header
	class="sticky top-0 z-50 h-16 border-b border-transparent transition-colors duration-500 ease-brand {scrolled
		? 'border-border bg-[var(--header-bg)] backdrop-blur-md backdrop-saturate-150'
		: ''}"
>
	<div class="container-page flex h-full items-center gap-6">
		<a class="inline-flex rounded-md no-underline" href="/" aria-label="Trifold home"><Wordmark /></a>

		<nav class="mx-auto hidden lg:block" aria-label="Main">
			<ul class="flex gap-[clamp(14px,2vw,30px)]">
				{#each NAV as item (item.href)}
					<li class="flex items-center">
						{#if item.menu}
							<AudienceMenu label={item.label} current={isCurrent(item.href)} />
						{:else}
							<a
								href={item.href}
								aria-current={isCurrent(item.href) ? "page" : undefined}
								class="label-mono py-1.5 no-underline transition-colors hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_1px_0_var(--seal)]"
								>{item.label}</a
							>
						{/if}
					</li>
				{/each}
			</ul>
		</nav>

		<div class="ml-auto flex items-center gap-2.5 lg:ml-0">
			<ThemeToggle />
			<span class="hidden lg:inline-flex"><Button href="/early-access" size="sm">Get early access</Button></span>
			<Button
				variant="subtle"
				size="icon"
				class="lg:hidden"
				aria-haspopup="dialog"
				aria-expanded={menuOpen}
				onclick={openMenu}
			>
				<span class="sr-only">Open menu</span>
				<svg viewBox="0 0 24 24" class="size-5" aria-hidden="true">
					<path d="M4 8h16M4 16h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
				</svg>
			</Button>
		</div>
	</div>
</header>

{#if MobileNav}
	<MobileNav bind:open={menuOpen} />
{/if}
