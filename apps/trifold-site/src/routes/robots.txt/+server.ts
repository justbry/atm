import { SITE_ORIGIN } from "#lib/config";

export const prerender = true;

export const GET = () =>
	new Response(
		`# Agents: start at ${SITE_ORIGIN}/llms.txt (every page as markdown, with what is shipped and what is not).\nUser-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
		{
			headers: { "content-type": "text/plain; charset=utf-8" },
		},
	);
