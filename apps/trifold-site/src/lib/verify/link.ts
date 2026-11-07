// SPDX-License-Identifier: Apache-2.0
/** `/verify?r=` links: the signed receipt as base64url (no padding) of its UTF-8 JSON. No crypto here, so pages can
 * build and read links without loading the verifier. */
export const decodeReceiptParam = (param: string): string | null => {
	try {
		const base64 = param.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
		const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
};

export const encodeReceiptParam = (json: string): string => {
	let binary = "";
	for (const byte of new TextEncoder().encode(json))
		binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};
