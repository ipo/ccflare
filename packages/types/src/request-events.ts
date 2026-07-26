import { isFiniteNumber, isRecord } from "./guards";
import {
	type HttpMethod,
	isHttpMethod,
	isRequestPayload,
	isRequestSummary,
	type RequestPayload,
	type RequestSummary,
} from "./request";

export interface RequestIngressEvent {
	type: "ingress";
	id: string;
	timestamp: number;
	method: HttpMethod;
	path: string;
	clientSessionId?: string | null;
}

export interface RequestStartEvent {
	type: "start";
	id: string;
	timestamp: number;
	method: HttpMethod;
	path: string;
	accountId: string | null;
	accountName?: string | null;
	statusCode: number;
	clientSessionId?: string | null;
}

export interface RequestSummaryEvent {
	type: "summary";
	payload: RequestSummary;
}

export interface RequestPayloadEvent {
	type: "payload";
	payload: RequestPayload;
}

export type RequestStreamEvent =
	| RequestIngressEvent
	| RequestStartEvent
	| RequestSummaryEvent
	| RequestPayloadEvent;

function isOptionalNullableString(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "string";
}

export function isRequestStreamEvent(
	value: unknown,
): value is RequestStreamEvent {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	switch (value.type) {
		case "ingress":
			return (
				typeof value.id === "string" &&
				isFiniteNumber(value.timestamp) &&
				typeof value.method === "string" &&
				isHttpMethod(value.method) &&
				typeof value.path === "string" &&
				isOptionalNullableString(value.clientSessionId)
			);
		case "start":
			return (
				typeof value.id === "string" &&
				isFiniteNumber(value.timestamp) &&
				typeof value.method === "string" &&
				isHttpMethod(value.method) &&
				typeof value.path === "string" &&
				(value.accountId === null || typeof value.accountId === "string") &&
				isOptionalNullableString(value.accountName) &&
				isFiniteNumber(value.statusCode) &&
				isOptionalNullableString(value.clientSessionId)
			);
		case "summary":
			return isRequestSummary(value.payload);
		case "payload":
			return isRequestPayload(value.payload);
		default:
			return false;
	}
}

export function parseRequestStreamEvent(
	value: unknown,
): RequestStreamEvent | null {
	return isRequestStreamEvent(value) ? value : null;
}
