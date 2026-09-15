import type {
	CfDnsRecord,
	CfEmailRoutingRule,
	CfResponse,
	CfSendingSubdomain,
} from "@/lib/cloudflare-api.types";
import {
	CloudflareApiError,
	formatCloudflareError,
	getCloudflareAuth,
	getCloudflareAuthHeaders,
	getCloudflareAuthHint,
	getCloudflareTokenDiagnostic,
	getEmailWorkerName,
} from "@/lib/cloudflare-api-utils";
import { getZoneLookupCandidates } from "@/lib/domains/utils";
export type { CfDnsRecord } from "@/lib/cloudflare-api.types";

export async function cfRequest<T>(
	env: CloudflareEnv,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const auth = getCloudflareAuth(env);
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			...getCloudflareAuthHeaders(auth),
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	let json: CfResponse<T> | undefined;
	try {
		json = (await res.json()) as CfResponse<T>;
	} finally {
		console.info("Cloudflare API request", {
			...getCloudflareTokenDiagnostic(env),
			endpoint: path.split("?")[0],
			method: init?.method ?? "GET",
			status: res.status,
			errorCodes: (json?.errors ?? []).map((error) => error.code).filter((code) => typeof code === "number"),
		});
	}

	if (!json.success) {
		throw new CloudflareApiError(
			`${formatCloudflareError(path, res.status, res.statusText, json.errors ?? [])}${getCloudflareAuthHint(json.errors ?? [])}`,
			res.status,
			(json.errors ?? []).map((error) => error.code).filter((code): code is number => typeof code === "number"),
		);
	}
	return json.result;
}

export async function findZoneByHostname(
	env: CloudflareEnv,
	hostname: string,
): Promise<{ id: string; name: string } | null> {
	for (const candidate of getZoneLookupCandidates(hostname)) {
		const zones = await cfRequest<{ id: string; name: string }[]>(
			env,
			`/zones?name=${encodeURIComponent(candidate)}&status=active`,
		);
		const zone = zones.find((z) => z.name === candidate);
		if (zone) return zone;
	}

	return null;
}

export async function getEmailRoutingDns(
	env: CloudflareEnv,
	zoneId: string,
): Promise<{ records: CfDnsRecord[]; missing: CfDnsRecord[] }> {
	const result = await cfRequest<{
		record?: CfDnsRecord[];
		errors?: { missing?: CfDnsRecord }[];
	}>(env, `/zones/${zoneId}/email/routing/dns`);
	return {
		records: result.record ?? [],
		missing: (result.errors ?? [])
			.map((e) => e.missing)
			.filter(Boolean) as CfDnsRecord[],
	};
}

export async function enableEmailRouting(
	env: CloudflareEnv,
	zoneId: string,
	hostname?: string,
) {
	return cfRequest<{ status?: string; enabled?: boolean }>(
		env,
		`/zones/${zoneId}/email/routing/dns`,
		{
			method: "POST",
			...(hostname ? { body: JSON.stringify({ name: hostname }) } : {}),
		},
	);
}

export async function disableEmailRouting(env: CloudflareEnv, zoneId: string) {
	return cfRequest<unknown>(env, `/zones/${zoneId}/email/routing/dns`, {
		method: "DELETE",
	});
}

export async function listSendingSubdomains(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<CfSendingSubdomain[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
	);
}

export async function createSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
) {
	return cfRequest<{ tag: string; name: string; enabled: boolean }>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
		{
			method: "POST",
			body: JSON.stringify({ name: hostname }),
		},
	);
}

export async function deleteSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}`,
		{ method: "DELETE" },
	);
}

export async function getSendingSubdomainDns(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
): Promise<CfDnsRecord[]> {
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}/dns`,
	);
}

export async function getEmailRoutingSettings(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<{ enabled?: boolean; status?: string; name?: string }>(
		env,
		`/zones/${zoneId}/email/routing`,
	);
}

export async function listEmailRoutingRules(env: CloudflareEnv, zoneId: string) {
	const rules: CfEmailRoutingRule[] = [];
	const perPage = 50;
	for (let page = 1; ; page++) {
		const batch = await cfRequest<CfEmailRoutingRule[]>(
			env,
			`/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${perPage}`,
		);
		rules.push(...batch);
		if (batch.length < perPage) return rules;
	}
}

export async function deleteEmailRoutingRule(
	env: CloudflareEnv,
	zoneId: string,
	ruleId: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/routing/rules/${ruleId}`,
		{ method: "DELETE" },
	);
}

export async function createEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
) {
	const workerName = getEmailWorkerName();
	return cfRequest<CfEmailRoutingRule>(
		env,
		`/zones/${zoneId}/email/routing/rules`,
		{
			method: "POST",
			body: JSON.stringify({
				actions: [{ type: "worker", value: [workerName] }],
				enabled: true,
				matchers: [{ type: "literal", field: "to", value: address }],
				name: `Route ${address} to ${workerName}`,
			}),
		},
	);
}

function routesAddress(rule: CfEmailRoutingRule, normalizedAddress: string): boolean {
	return Boolean(rule.matchers?.some(
		(matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value?.trim().toLowerCase() === normalizedAddress,
	));
}

function isWorkerRouteForAddress(
	rule: CfEmailRoutingRule,
	normalizedAddress: string,
	workerName: string,
): boolean {
	const sendsToWorker = rule.actions?.length === 1 && rule.actions.every(
		(action) => action.type === "worker" && action.value?.length === 1 && action.value[0] === workerName,
	);
	return Boolean(routesAddress(rule, normalizedAddress) && sendsToWorker);
}

export async function ensureEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
	options?: {
		onCreated?: (rule: CfEmailRoutingRule) => void;
		onUpdated?: (previous: CfEmailRoutingRule) => void;
	},
) {
	const normalized = address.trim().toLowerCase();
	const workerName = getEmailWorkerName();
	async function reconcile(existing: CfEmailRoutingRule) {
		if (existing.enabled && isWorkerRouteForAddress(existing, normalized, workerName)) return existing;
		const ruleId = existing.id ?? existing.tag;
		if (!ruleId) throw new Error(`The existing Email Routing rule for ${normalized} has no identifier; it was preserved.`);
		const updated = await cfRequest<CfEmailRoutingRule>(
			env,
			`/zones/${zoneId}/email/routing/rules/${ruleId}`,
			{
				method: "PUT",
				body: JSON.stringify({
					actions: [{ type: "worker", value: [workerName] }],
					enabled: true,
					matchers: existing.matchers,
					name: existing.name ?? `Route ${normalized} to ${workerName}`,
					priority: existing.priority,
				}),
			},
		);
		options?.onUpdated?.(existing);
		return updated;
	}

	const rules = await listEmailRoutingRules(env, zoneId);
	const existing = rules.find((rule) => routesAddress(rule, normalized));
	if (existing) return reconcile(existing);

	let created: CfEmailRoutingRule;
	try {
		created = await createEmailRoutingRuleToWorker(env, zoneId, normalized);
	} catch (error) {
		// A concurrent ensure may have created the address since our GET.
		if (!(error instanceof CloudflareApiError) || error.status !== 409 || !error.errorCodes.includes(2014)) throw error;
		const current = (await listEmailRoutingRules(env, zoneId)).find((rule) => routesAddress(rule, normalized));
		if (current) return reconcile(current);
		throw error;
	}
	options?.onCreated?.(created);
	return created;
}

export async function deleteEmailRoutingRuleForAddress(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
): Promise<boolean> {
	const normalized = address.trim().toLowerCase();
	const workerName = getEmailWorkerName();
	const rules = await listEmailRoutingRules(env, zoneId);
	const existing = rules.find((rule) => isWorkerRouteForAddress(rule, normalized, workerName));
	const ruleId = existing?.id ?? existing?.tag;
	if (!ruleId) return false;
	await deleteEmailRoutingRule(env, zoneId, ruleId);
	return true;
}
