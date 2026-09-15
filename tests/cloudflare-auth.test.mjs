import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

// Execute the actual TS modules with isolated fetch/log sinks; no live zone changes.
function loadModules(fetch, logs = []) {
	const cache = new Map();
	function load(name) {
		const filename = resolve(root, name.replace(/^@\//, "src/") + ".ts");
		if (cache.has(filename)) return cache.get(filename).exports;
		const loadedModule = { exports: {} };
		cache.set(filename, loadedModule);
		const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		});
		new Function("require", "module", "exports", "fetch", "console", outputText)(
			load, loadedModule, loadedModule.exports, fetch, { info: (...args) => logs.push(args) },
		);
		return loadedModule.exports;
	}
	return load;
}

const token = "cfut_synthetic_user_token_for_regression_only";
const legacy = { CF_API_KEY: "synthetic-global-key", CF_EMAIL: "admin@example.test" };

test("token-only production configuration preserves the entire cfut_ token", () => {
	const { getCloudflareAuth, getCloudflareAuthHeaders } = loadModules()("@/lib/cloudflare-api-utils");
	const env = Object.freeze({ CF_TOKEN: ` \n${token}\t` });
	assert.deepEqual(getCloudflareAuthHeaders(getCloudflareAuth(env)), { Authorization: `Bearer ${token}` });
	assert.equal(env.CF_TOKEN, ` \n${token}\t`);
	assert.deepEqual(getCloudflareAuthHeaders(getCloudflareAuth(legacy)), {
		"X-Auth-Email": legacy.CF_EMAIL, "X-Auth-Key": legacy.CF_API_KEY,
	});
	assert.throws(() => getCloudflareAuth({ CF_API_KEY: legacy.CF_API_KEY }), /CF_EMAIL/);
	assert.throws(() => getCloudflareAuth({}), /not configured/);
	assert.deepEqual(getCloudflareAuthHeaders(getCloudflareAuth({ CF_TOKEN: token })), { Authorization: `Bearer ${token}` });
	assert.deepEqual(getCloudflareAuth({ CF_TOKEN: "  ", ...legacy }), { kind: "global-key", email: legacy.CF_EMAIL, key: legacy.CF_API_KEY });
});

test("registration provisioning sends cfut_ Bearer auth through routing and sending calls", async () => {
	const calls = [];
	const logs = [];
	const load = loadModules(async (url, init) => {
		const path = new URL(url).pathname.replace("/client/v4", "");
		const method = init.method ?? "GET";
		calls.push(`${method} ${path}`);
		const headers = new Headers(init.headers);
		const authorized = headers.get("Authorization") === `Bearer ${token}`;
		assert.equal(authorized, true);
		assert.equal(headers.has("X-Auth-Key"), false);
		let result = { enabled: true };
		if (path === "/zones") result = [{ id: "zone", name: "example.test" }];
		if (path.endsWith("/subdomains")) result = method === "GET" ? [] : { tag: "sub", name: "example.test", enabled: true };
		return Response.json({ success: true, result });
	}, logs);
	const { provisionDomainOnCloudflare } = load("@/lib/domains/provision");
	const result = await provisionDomainOnCloudflare(Object.freeze({ CF_TOKEN: token }), "example.test");
	assert.equal(result.sendingEnabled, true);
	assert.deepEqual(calls, [
		"GET /zones", "GET /zones/zone/email/routing",
		"GET /zones/zone/email/routing/rules/catch_all", "POST /zones/zone/email/routing/dns",
		"PUT /zones/zone/email/routing/rules/catch_all", "GET /zones/zone/email/sending/subdomains",
		"POST /zones/zone/email/sending/subdomains",
	]);
	assert.equal(logs.length, calls.length);
	assert.equal(JSON.stringify(logs).includes(token), false);
	assert.equal(JSON.stringify(logs).includes(legacy.CF_API_KEY), false);
});

test("401/2036 is preserved and diagnostic contains only approved metadata", async () => {
	const logs = [];
	const load = loadModules(async () => Response.json({ success: false, errors: [{ code: 2036, message: "Unauthorized", source: { pointer: "synthetic-private-error-context" } }] }, { status: 401 }), logs);
	const { listSendingSubdomains } = load("@/lib/cloudflare-api");
	await assert.rejects(listSendingSubdomains({ CF_TOKEN: ` ${token}\n` }, "zone"), (error) => {
		assert.match(error.message, /401.*2036: Unauthorized/);
		assert.deepEqual(Object.keys(error).sort(), ["errorCodes", "status"]);
		assert.equal(JSON.stringify(error).includes("synthetic-private-error-context"), false);
		return true;
	});
	assert.deepEqual(logs, [["Cloudflare API request", {
		tokenExists: true, tokenType: "cfut_", tokenLength: token.length + 2,
		tokenHasWhitespace: true, endpoint: "/zones/zone/email/sending/subdomains",
		method: "GET", status: 401, errorCodes: [2036],
	}]]);
});

test("registration POST has no subdomain suffix and preserves a valid token when Cloudflare rejects creation", async () => {
	const calls = [];
	const logs = [];
	const load = loadModules(async (url, init) => {
		const path = new URL(url).pathname.replace("/client/v4", "");
		const method = init.method ?? "GET";
		calls.push({ path, method });
		assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${token}`);
		if (method === "POST" && path.includes("/sending/")) {
			assert.equal(path, "/zones/zone/email/sending/subdomains");
			assert.deepEqual(JSON.parse(init.body), { name: "yournextthing.org.uk" });
			return Response.json({ success: false, errors: [{ code: 2036, message: "Unauthorized" }] }, { status: 401 });
		}
		let result = { enabled: true };
		if (path === "/zones") result = [{ id: "zone", name: "yournextthing.org.uk" }];
		if (path.endsWith("/subdomains")) result = [];
		return Response.json({ success: true, result });
	}, logs);
	await assert.rejects(
		load("@/lib/domains/provision").provisionDomainOnCloudflare({ CF_TOKEN: token }, "yournextthing.org.uk"),
		/401 on \/zones\/zone\/email\/sending\/subdomains: code 2036/,
	);
	assert.deepEqual(calls.slice(-2), [
		{ method: "GET", path: "/zones/zone/email/sending/subdomains" },
		{ method: "POST", path: "/zones/zone/email/sending/subdomains" },
	]);
	assert.equal(logs.at(-1)[1].method, "POST");
	assert.equal(logs.at(-1)[1].status, 401);
	assert.deepEqual(logs.at(-1)[1].errorCodes, [2036]);
	assert.equal(JSON.stringify(logs).includes(token), false);
});

test("unknown token formats and malformed responses never enter diagnostics", async () => {
	const logs = [];
	const load = loadModules(async () => new Response("not JSON", { status: 502 }), logs);
	await assert.rejects(load("@/lib/cloudflare-api").cfRequest({ CF_TOKEN: "synthetic-unknown-secret" }, "/zones?name=example.test"));
	assert.equal(logs[0][1].tokenType, "other");
	assert.equal(logs[0][1].status, 502);
	assert.equal(logs[0][1].endpoint, "/zones");
	assert.equal(JSON.stringify(logs).includes("synthetic-unknown-secret"), false);
});

test("absent and empty token diagnostics reveal no credential values", () => {
	const { getCloudflareTokenDiagnostic } = loadModules()("@/lib/cloudflare-api-utils");
	assert.deepEqual(getCloudflareTokenDiagnostic(legacy), {
		tokenExists: false, tokenType: "empty", tokenLength: 0, tokenHasWhitespace: false,
	});
	assert.deepEqual(getCloudflareTokenDiagnostic({ CF_TOKEN: " " }), {
		tokenExists: true, tokenType: "empty", tokenLength: 1, tokenHasWhitespace: true,
	});
});

function routingFixture(initialRules, { raceRule, pageSize = 50 } = {}) {
	let rules = structuredClone(initialRules);
	const calls = [];
	const load = loadModules(async (url, init) => {
		const parsed = new URL(url);
		const method = init.method ?? "GET";
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: parsed.pathname, body });
		if (method === "GET") {
			const page = Number(parsed.searchParams.get("page") ?? 1);
			return Response.json({ success: true, result: rules.slice((page - 1) * pageSize, page * pageSize) });
		}
		if (method === "POST") {
			if (raceRule) rules.push(structuredClone(raceRule));
			const address = body.matchers[0].value.trim().toLowerCase();
			if (rules.some((rule) => rule.matchers?.some((m) => m.value?.trim().toLowerCase() === address))) {
				return Response.json({ success: false, errors: [{ code: 2014, message: "Duplicated Zone rule" }] }, { status: 409 });
			}
			const rule = { id: "new-rule", ...body };
			rules.push(rule);
			return Response.json({ success: true, result: rule });
		}
		if (method === "PUT") {
			const rule = rules.find((rule) => (rule.id ?? rule.tag) === parsed.pathname.split("/").at(-1));
			assert.ok(rule, "update must use an existing identifier");
			Object.assign(rule, body);
			return Response.json({ success: true, result: rule });
		}
		assert.fail(`Unexpected ${method}; existing rules must not be deleted`);
	});
	return { api: load("@/lib/cloudflare-api"), load, calls, rules };
}

const address = "tech@yournextthing.org.uk";
const workerRule = {
	id: "existing-rule", enabled: true, name: "Existing legitimate route", priority: 7,
	matchers: [{ type: "literal", field: "to", value: address }],
	actions: [{ type: "worker", value: ["mailflare"] }],
};
const routingEnv = { CF_TOKEN: token };

test("duplicate address with forwarding, another Worker, or unknown destination is retargeted without POST", async () => {
	for (const actions of [
		[{ type: "forward", value: ["owner@example.test"] }],
		[{ type: "worker", value: ["other-worker"] }],
		[{ type: "worker" }],
		[{ type: "drop" }],
	]) {
		const initial = { ...workerRule, actions };
		const { api, calls, rules } = routingFixture([initial]);
		const previous = [];
		await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address, { onUpdated: (rule) => previous.push(rule) });
		await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address);
		assert.deepEqual(calls.map((call) => call.method), ["GET", "PUT", "GET"]);
		assert.deepEqual(rules, [{ ...initial, actions: workerRule.actions }]);
		assert.deepEqual(previous, [initial]);
	}
});

test("existing Mailflare route is reused on repeated calls and is not tracked for rollback", async () => {
	const initial = { ...workerRule, matchers: [{ type: "literal", field: "to", value: ` ${address.toUpperCase()} ` }] };
	const { api, calls, load, rules } = routingFixture([initial]);
	const changes = { zoneId: "zone", createdAddressRules: [], updatedAddressRules: [], enabledEmailRouting: false, previousCatchAll: null, createdSendingSubdomainTag: null };
	for (let i = 0; i < 2; i++) {
		assert.equal((await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", ` ${address} `, {
			onCreated: () => changes.createdAddressRules.push(address),
		})).id, workerRule.id);
	}
	await load("@/lib/domains/rollback").rollbackDomainProvisioning(routingEnv, changes);
	assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
	assert.deepEqual(changes.createdAddressRules, []);
	assert.deepEqual(rules, [initial]);
});

test("disabled tag-only Mailflare rule is updated in place once, preserving its configuration", async () => {
	const { id, ...rest } = workerRule;
	const initial = { ...rest, tag: id, enabled: false };
	const { api, calls, rules } = routingFixture([initial]);
	let created = 0;
	await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address, { onCreated: () => created++ });
	await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address);
	assert.deepEqual(calls.map((call) => call.method), ["GET", "PUT", "GET"]);
	assert.equal(calls[1].path, `/client/v4/zones/zone/email/routing/rules/${id}`);
	assert.deepEqual(rules, [{ ...initial, enabled: true }]);
	assert.equal(created, 0);
});

test("existing rule beyond the first page is found without creating a duplicate", async () => {
	const otherRules = Array.from({ length: 50 }, (_, i) => ({ ...workerRule, id: `other-${i}`, matchers: [{ type: "literal", field: "to", value: `other-${i}@example.test` }] }));
	const { api, calls } = routingFixture([...otherRules, workerRule]);
	assert.equal((await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address)).id, workerRule.id);
	assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
});

test("missing route is created once and a retry reuses it", async () => {
	const { api, calls } = routingFixture([]);
	let created = 0;
	for (let i = 0; i < 2; i++) await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address, { onCreated: () => created++ });
	assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
	assert.equal(created, 1);
});

test("concurrent duplicate creation re-reads and reconciles the existing rule", async () => {
	const { api, calls } = routingFixture([], { raceRule: workerRule });
	let created = 0;
	assert.equal((await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address, { onCreated: () => created++ })).id, workerRule.id);
	assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
	assert.equal(created, 0);
	const conflict = routingFixture([], { raceRule: { ...workerRule, actions: [{ type: "forward", value: ["owner@example.test"] }] } });
	await conflict.api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address);
	assert.deepEqual(conflict.calls.map((call) => call.method), ["GET", "POST", "GET", "PUT"]);
	assert.deepEqual(conflict.rules[0].actions, workerRule.actions);
});

test("later registration failure restores the original forwarding rule without deleting it", async () => {
	for (const enabled of [true, false]) {
		const initial = { ...workerRule, enabled, actions: [{ type: "forward", value: ["owner@example.test"] }] };
		const { api, calls, load, rules } = routingFixture([initial]);
		const changes = { zoneId: "zone", createdAddressRules: [], updatedAddressRules: [], enabledEmailRouting: false, previousCatchAll: null, createdSendingSubdomainTag: null };
		await api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address, {
			onCreated: () => changes.createdAddressRules.push(address),
			onUpdated: (previous) => changes.updatedAddressRules.push(previous),
		});
		assert.deepEqual(changes.createdAddressRules, []);
		assert.deepEqual(rules[0].actions, workerRule.actions);
		await load("@/lib/domains/rollback").rollbackDomainProvisioning(routingEnv, changes);
		assert.deepEqual(rules, [initial]);
		assert.deepEqual(calls.map((call) => call.method), ["GET", "PUT", "PUT"]);
	}
});

test("an existing rule without an identifier never falls through to duplicate creation", async () => {
	const initial = { ...workerRule, id: undefined };
	const { api, calls } = routingFixture([{ ...initial, enabled: false }]);
	await assert.rejects(api.ensureEmailRoutingRuleToWorker(routingEnv, "zone", address), /no identifier/);
	assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});
