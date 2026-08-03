export type CompatibilityRouteKind =
	| "anthropic-messages"
	| "openai-chat-completions"
	| "openai-responses";

export type JsonRecord = Record<string, unknown>;

export type AnthropicUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

export type OpenAIUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	reasoning_tokens?: number;
};

export type SseFrame = {
	event: string | null;
	data: string;
};

export type SseTransformState = {
	buffer: string;
	decoder: TextDecoder;
	encoder: TextEncoder;
};

export type ChatToAnthropicStreamState = {
	messageId: string;
	model: string;
	createdAt: number;
	started: boolean;
	textStarted: boolean;
	textIndex: number;
	toolIndexes: Map<number, number>;
	toolNames: Map<number, string>;
	toolIds: Map<number, string>;
	emittedToolStarts: Set<number>;
	usage: AnthropicUsage;
	stopReason: string | null;
};

export type AnthropicToChatStreamState = {
	id: string;
	model: string;
	created: number;
	usage: OpenAIUsage;
	finishReason: string | null;
	textIndex: number;
	toolIndexes: Map<number, string>;
	toolNames: Map<number, string>;
};

export type AnthropicToResponsesStreamState = {
	sequence: number;
	responseId: string;
	model: string;
	createdAt: number;
	noticeCount: number;
	messageItemId: string | null;
	usage: OpenAIUsage;
	messageItemIds: Map<number, string>;
	messageTexts: Map<number, string>;
	functionCallIds: Map<number, string>;
	functionNames: Map<number, string>;
	functionArguments: Map<number, string>;
	reasoningIds: Map<number, string>;
	reasoningTexts: Map<number, string>;
};

export type ResponsesToAnthropicStreamState = {
	messageId: string;
	model: string;
	usage: AnthropicUsage;
	started: boolean;
	hasContent: boolean;
	hasToolCalls: boolean;
	messageIndexes: Map<string, number>;
	functionIndexes: Map<string, number>;
	functionNames: Map<string, string>;
	reasoningIndexes: Map<string, number>;
	nextIndex: number;
};

export type ResponsesToChatStreamState = {
	id: string;
	model: string;
	created: number;
	usage: OpenAIUsage;
	hasContent: boolean;
	hasToolCalls: boolean;
	functionIndexes: Map<string, number>;
	functionNames: Map<string, string>;
	functionCallIds: Map<string, string>;
	finishReason: string | null;
	started: boolean;
};
