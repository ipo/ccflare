/**
 * Deterministic session-id → light-spectrum color mapping.
 *
 * Channels are kept in [0x99, 0xdf]: light enough to satisfy the
 * "no darker than #808080, no whiter than #e0e0e0" requirement, while the
 * 0x99 floor keeps worst-case contrast against the dark foreground (#1f2937)
 * above WCAG's 4.5:1 normal-text ratio.
 */

const CHANNEL_FLOOR = 0x99; // 153
const CHANNEL_RANGE = 0xdf - 0x99 + 1; // 71 → values 153..223

const FOREGROUND = "#1f2937";

function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function channel(sessionId: string, salt: string): number {
	const byte = fnv1a(`${salt}${sessionId}`) & 0xff;
	return CHANNEL_FLOOR + (byte % CHANNEL_RANGE);
}

export function sessionColor(sessionId: string): {
	backgroundColor: string;
	color: string;
} {
	const r = channel(sessionId, "r:");
	const g = channel(sessionId, "g:");
	const b = channel(sessionId, "b:");
	const hex = (value: number) => value.toString(16).padStart(2, "0");
	return {
		backgroundColor: `#${hex(r)}${hex(g)}${hex(b)}`,
		color: FOREGROUND,
	};
}
