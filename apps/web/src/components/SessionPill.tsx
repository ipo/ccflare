import { useNavigate } from "react-router-dom";
import { sessionColor } from "../lib/session-color";

interface SessionPillProps {
	sessionId: string;
}

/**
 * Light-colored pill showing the tail of a client session id. Clicking
 * navigates to the session-filtered requests view. Rendered inside the
 * request row toggle, so it stops propagation to avoid expanding the row.
 */
export function SessionPill({ sessionId }: SessionPillProps) {
	const navigate = useNavigate();
	const { backgroundColor, color } = sessionColor(sessionId);

	return (
		<button
			type="button"
			className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-mono font-medium shadow-sm hover:opacity-80 transition-opacity"
			style={{ backgroundColor, color }}
			title={`Session ${sessionId} — click to filter by session`}
			onClick={(e) => {
				e.stopPropagation();
				navigate(`/requests/${encodeURIComponent(sessionId)}`);
			}}
		>
			…{sessionId.slice(-4)}
		</button>
	);
}
