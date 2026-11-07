/**
 * The homepage gallery's cards, built from VERTICALS (./verticals.ts, galleryCards) by vite.config.ts and inlined as
 * __GALLERY__, so only what the cards show reaches the browser. Restart `bun run dev` after editing the verticals.
 */
import type { GalleryCard } from "#lib/verticals";

declare const __GALLERY__: GalleryCard[];

export const GALLERY: GalleryCard[] = __GALLERY__;
