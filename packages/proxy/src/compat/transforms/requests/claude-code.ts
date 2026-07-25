import * as nodeCrypto from "node:crypto";
import { isRecord } from "@ccflare/types";
import type { JsonRecord } from "../../types";
import { buildAnthropicTextBlock } from "../content-parts";
import { textContentFromUnknown } from "../shared";

const CLAUDE_CODE_VERSION = "2.1.63";
const CLAUDE_CODE_FINGERPRINT_SALT = "59cf53e54c78";
const CLAUDE_CODE_PROMPT = [
	"You are Claude Code, Anthropic's official CLI for Claude.",
	"You help with code changes, debugging, and repo-aware development tasks.",
	"Be concise, direct, and action-oriented.",
].join("\n\n");

function computeClaudeCodeFingerprint(messageText: string, version: string) {
	const chars = [4, 7, 20].map((index) => messageText[index] ?? "0").join("");
	return nodeCrypto
		.createHash("sha256")
		.update(`${CLAUDE_CODE_FINGERPRINT_SALT}${chars}${version}`)
		.digest("hex")
		.slice(0, 3);
}

function buildClaudeCodeBillingHeader(payload: string, systemText: string) {
	const fingerprint = computeClaudeCodeFingerprint(
		systemText,
		CLAUDE_CODE_VERSION,
	);
	const cch = nodeCrypto
		.createHash("sha256")
		.update(payload)
		.digest("hex")
		.slice(0, 5);
	return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=cli; cch=${cch};`;
}

export function applyClaudeCodeShaping(request: JsonRecord): JsonRecord {
	const systemText = textContentFromUnknown(request.system);
	const payload = JSON.stringify(request);
	const billingHeader = buildClaudeCodeBillingHeader(payload, systemText);

	const shaped: JsonRecord = {
		...request,
		system: [
			buildAnthropicTextBlock(billingHeader),
			buildAnthropicTextBlock(
				"You are Claude Code, Anthropic's official CLI for Claude.",
			),
			buildAnthropicTextBlock(CLAUDE_CODE_PROMPT),
		],
	};

	if (systemText) {
		const messages = Array.isArray(request.messages)
			? (request.messages as JsonRecord[])
			: [];
		const firstUserIdx = messages.findIndex(
			(message) => isRecord(message) && message.role === "user",
		);
		const prefix = systemText.trim();
		if (prefix && firstUserIdx >= 0) {
			const firstUser = messages[firstUserIdx];
			const currentContent =
				typeof firstUser.content === "string"
					? [buildAnthropicTextBlock(firstUser.content)]
					: Array.isArray(firstUser.content)
						? (firstUser.content as JsonRecord[])
						: [];
			const newMessages = messages.slice();
			newMessages[firstUserIdx] = {
				...firstUser,
				content: [buildAnthropicTextBlock(prefix), ...currentContent],
			};
			shaped.messages = newMessages;
		}
	}

	return shaped;
}
