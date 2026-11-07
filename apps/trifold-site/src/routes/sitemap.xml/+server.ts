import { COMPETITORS, compareHref } from "#lib/compare/competitors";
import { PAGES, SITE_ORIGIN } from "#lib/config";

export const prerender = true;

export const GET = () => {
	const paths = [
		...PAGES.filter((path) => path !== "/legal"),
		...COMPETITORS.map((competitor) => compareHref(competitor.slug)),
	];
	const urls = paths
		.map(
			(path) =>
				`\t<url><loc>${SITE_ORIGIN}${path === "/" ? "/" : path}</loc></url>`,
		)
		.join("\n");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
		{ headers: { "content-type": "application/xml; charset=utf-8" } },
	);
};
