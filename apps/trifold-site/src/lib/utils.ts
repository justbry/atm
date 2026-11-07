import { type ClassValue, clsx } from "clsx";

/**
 * Joins class names. No tailwind-merge (it is ~7 KB gzip on every page): the ui components carry the brand styling as
 * their defaults, so call sites only add classes that don't conflict (spacing, width), never override them.
 */
export const cn = (...inputs: ClassValue[]): string => clsx(inputs);

// biome-ignore lint/suspicious/noExplicitAny: shadcn-svelte helper types
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// biome-ignore lint/suspicious/noExplicitAny: shadcn-svelte helper types
export type WithoutChildren<T> = T extends { children?: any }
	? Omit<T, "children">
	: T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
	ref?: U | null;
};
