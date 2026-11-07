/**
 * The footer's Compare column: one link per entry in COMPETITORS (./competitors.ts). vite.config.ts builds the list and
 * inlines it as __COMPARE_LINKS__, so only these names reach the browser. Restart `bun run dev` after editing the array.
 */
import type { NavItem } from "#lib/config";

declare const __COMPARE_LINKS__: NavItem[];

export const COMPARE_LINKS: NavItem[] = __COMPARE_LINKS__;
