import type { WebSocketTranscriptEntry } from "@ccflare/types";
import { presentWebSocketTranscriptEntry } from "@ccflare/ui";
import { ArrowDown, ArrowLeft, ArrowRight, Radio } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useWebSocketTranscript } from "../hooks/useWebSocketTranscript";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

function directionLabel(entry: WebSocketTranscriptEntry): string {
	switch (entry.direction) {
		case "client_to_upstream":
			return "Client → Upstream";
		case "upstream_to_client":
			return "Upstream → Client";
		default:
			return "Connection";
	}
}

const TranscriptEntryCard = memo(function TranscriptEntryCard({
	entry,
}: {
	entry: WebSocketTranscriptEntry;
}) {
	const presentation = useMemo(
		() => presentWebSocketTranscriptEntry(entry),
		[entry],
	);
	const outbound = entry.direction === "client_to_upstream";
	const inbound = entry.direction === "upstream_to_client";
	return (
		<div
			className={`rounded-md border p-3 ${
				outbound
					? "ml-8 border-blue-500/30 bg-blue-500/5"
					: inbound
						? "mr-8 border-orange-500/30 bg-orange-500/5"
						: "mx-4 bg-muted/40"
			}`}
		>
			<div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				{outbound ? (
					<ArrowRight className="h-3 w-3" />
				) : inbound ? (
					<ArrowLeft className="h-3 w-3" />
				) : null}
				<span className="font-medium text-foreground">
					{directionLabel(entry)}
				</span>
				<span>#{entry.sequence}</span>
				<span>{new Date(entry.observedAt).toLocaleTimeString()}</span>
				<Badge
					variant={presentation.known ? "secondary" : "outline"}
					className="text-[10px]"
				>
					{presentation.known
						? presentation.label
						: `Unknown · ${presentation.label}`}
				</Badge>
			</div>
			{presentation.content && (
				<pre className="whitespace-pre-wrap break-words text-sm font-mono">
					{presentation.content}
				</pre>
			)}
			{!presentation.known && presentation.content !== presentation.raw && (
				<details className="mt-2 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						Raw frame
					</summary>
					<pre className="mt-2 whitespace-pre-wrap break-all rounded bg-muted p-2">
						{presentation.raw}
					</pre>
				</details>
			)}
		</div>
	);
});

export function WebSocketTranscriptView({ requestId }: { requestId: string }) {
	const { entries, loading, error, active } = useWebSocketTranscript(
		requestId,
		true,
	);
	const viewportRef = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);
	const [unseen, setUnseen] = useState(0);
	const [visibleCount, setVisibleCount] = useState(500);
	const previousCount = useRef(0);
	const visibleEntries = entries.slice(
		Math.max(0, entries.length - visibleCount),
	);

	useEffect(() => {
		const added = entries.length - previousCount.current;
		previousCount.current = entries.length;
		if (following) {
			viewportRef.current?.scrollTo({
				top: viewportRef.current.scrollHeight,
				behavior: added > 1 ? "auto" : "smooth",
			});
			setUnseen(0);
		} else if (added > 0) {
			setUnseen((count) => count + added);
			setVisibleCount((count) => count + added);
		}
	}, [entries.length, following]);

	if (loading) {
		return (
			<div className="p-8 text-center text-muted-foreground">
				Loading WebSocket transcript…
			</div>
		);
	}
	if (error) {
		return (
			<div className="p-8 text-center text-destructive">{error.message}</div>
		);
	}

	return (
		<div className="relative h-full min-h-0 overflow-hidden rounded-lg border">
			<div className="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
				<div className="flex items-center gap-2 text-sm">
					<Radio
						className={`h-4 w-4 ${active ? "text-green-500 animate-pulse" : "text-muted-foreground"}`}
					/>
					<span>{active ? "Live WebSocket" : "WebSocket closed"}</span>
				</div>
				<span className="text-xs text-muted-foreground">
					{entries.length} events
				</span>
			</div>
			<div
				ref={viewportRef}
				className="h-[calc(100%-41px)] overflow-y-auto p-3 space-y-2"
				onScroll={(event) => {
					const element = event.currentTarget;
					const atBottom =
						element.scrollHeight - element.scrollTop - element.clientHeight <
						32;
					setFollowing(atBottom);
					if (atBottom) setUnseen(0);
				}}
			>
				{visibleEntries.length < entries.length && (
					<div className="flex justify-center pb-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setVisibleCount((count) => count + 500)}
						>
							Show earlier events
						</Button>
					</div>
				)}
				{entries.length === 0 ? (
					<p className="p-8 text-center text-muted-foreground">
						No WebSocket data recorded yet.
					</p>
				) : (
					visibleEntries.map((entry) => (
						<TranscriptEntryCard key={entry.sequence} entry={entry} />
					))
				)}
			</div>
			{!following && unseen > 0 && (
				<Button
					className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg"
					size="sm"
					onClick={() => {
						setVisibleCount(500);
						setFollowing(true);
						setUnseen(0);
					}}
				>
					<ArrowDown className="mr-2 h-4 w-4" />
					{unseen} new events
				</Button>
			)}
		</div>
	);
}
