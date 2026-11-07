/**
 * The prompt in the footer's "For agents" note (AgentNote.svelte). Kept apart from llms.ts, which pulls in the pricing
 * data, so the note adds only this string to every page's JavaScript.
 */
import { SITE_ORIGIN } from "#lib/config";

export const AGENT_PROMPT = `Read ${SITE_ORIGIN}/llms.txt and tell me whether Trifold fits my school, what it costs, and what isn't built yet.`;
