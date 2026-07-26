import type { DashboardRoute } from "../routes";

/**
 * Matches the current pathname against the dashboard routes: exact match
 * first, then prefix match for nested paths (e.g. /requests/:sessionId),
 * falling back to the first route (Overview).
 */
export function matchDashboardRoute(
	pathname: string,
	routes: DashboardRoute[],
): DashboardRoute {
	return (
		routes.find((route) => route.path === pathname) ||
		routes.find(
			(route) => route.path !== "/" && pathname.startsWith(`${route.path}/`),
		) ||
		routes[0]
	);
}
