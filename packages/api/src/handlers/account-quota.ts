import { errorResponse, jsonResponse } from "@ccflare/http";
import type { AccountQuotaRefresher } from "../types";

export { quotaIndicatesAvailability } from "../account-quota-service";

/** Fetch quota for one selected account without involving load balancing. */
export function createAccountQuotaHandler(service: AccountQuotaRefresher) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			return jsonResponse(await service.refreshAccountQuota(accountId));
		} catch (error) {
			return errorResponse(error);
		}
	};
}
