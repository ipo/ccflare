import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	Navigate,
	Route,
	Routes,
	useLocation,
	useParams,
} from "react-router-dom";
import { Navigation } from "./components/navigation";
import { RequestsTab } from "./components/RequestsTab";
import { QUERY_CONFIG, REFRESH_INTERVALS } from "./constants";
import { ThemeProvider } from "./contexts/theme-context";
import "./index.css";
import { matchDashboardRoute } from "./lib/route-match";
import { dashboardRoutes } from "./routes";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchInterval: REFRESH_INTERVALS.default, // Refetch every 30 seconds
			staleTime: QUERY_CONFIG.staleTime, // Consider data stale after 10 seconds
		},
	},
});

function RequestsTabRoute() {
	const { sessionId } = useParams<{ sessionId: string }>();
	return <RequestsTab sessionId={sessionId} />;
}

export function App() {
	const location = useLocation();
	const currentRoute = matchDashboardRoute(location.pathname, dashboardRoutes);

	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<div className="min-h-screen bg-background">
					<Navigation />

					{/* Main Content */}
					<main className="lg:pl-64">
						{/* Mobile spacer */}
						<div className="h-16 lg:hidden" />

						{/* Page Content */}
						<div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto">
							{/* Page Header */}
							<div className="mb-8">
								<h1 className="text-3xl font-bold gradient-text">
									{currentRoute.title}
								</h1>
								<p className="text-muted-foreground mt-2">
									{currentRoute.subtitle}
								</p>
							</div>

							{/* Tab Content */}
							<div className="animate-in fade-in-0 duration-200">
								<Routes>
									{dashboardRoutes.map((route) => (
										<Route
											key={route.path}
											path={route.path}
											element={route.element}
										/>
									))}
									<Route
										path="/requests/:sessionId"
										element={<RequestsTabRoute />}
									/>
									<Route path="*" element={<Navigate to="/" replace />} />
								</Routes>
							</div>
						</div>
					</main>
				</div>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
