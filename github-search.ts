import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath } from "./utils.ts";

// GitHub web search via the public GitHub MCP server (the same backend
// Copilot CLI exposes as its built-in `web_search` tool). Streamable-HTTP
// MCP at https://api.githubcopilot.com/mcp, gated by the X-MCP-Toolsets
// header. Auth is any GitHub token with Copilot access (gh CLI login,
// GITHUB_TOKEN, or githubToken in web-search.json).
//
// Explicit-only provider: never chosen by `auto` or `all` because it
// depends on an ambient GitHub login rather than a configured key.

const execFileAsync = promisify(execFile);

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 90_000;

interface WebSearchConfig {
	githubToken?: unknown;
}

interface GithubItem {
	title?: unknown;
	url?: unknown;
	snippets?: unknown;
	semantic_document?: unknown;
}

interface GithubResponse {
	search_result_groups?: Array<{ items?: GithubItem[] }>;
	error_message?: unknown;
	no_results_message?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	cachedConfig = parsed as WebSearchConfig;
	return cachedConfig;
}

async function getGhCliToken(signal?: AbortSignal): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("gh", ["auth", "token"], {
			timeout: 5000,
			maxBuffer: 64 * 1024,
			signal,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function getGithubToken(signal?: AbortSignal): Promise<string | null> {
	const configured = loadConfig().githubToken;
	const fromConfig = await resolveCredential({
		provider: "GitHub",
		configuredValue: configured,
		signal,
	});
	if (fromConfig) return fromConfig;
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	return getGhCliToken(signal);
}

export async function isGithubSearchAvailable(signal?: AbortSignal): Promise<boolean> {
	try {
		return Boolean(await getGithubToken(signal));
	} catch {
		return false;
	}
}

async function requireGithubToken(signal?: AbortSignal): Promise<string> {
	const token = await getGithubToken(signal);
	if (!token) {
		throw new Error(
			"GitHub search unavailable. Either:\n" +
			`  1. Run \`gh auth login\` so the gh CLI provides a token\n` +
			`  2. Set GITHUB_TOKEN environment variable\n` +
			`  3. Add { "githubToken": "ghp_..." } to ${CONFIG_PATH}\n` +
			"The token needs a Copilot subscription or classic/fine-grained permission to use the GitHub MCP web_search toolset.",
		);
	}
	return token;
}

interface McpSession {
	sessionId: string;
	token: string;
}

async function mcpRequest(session: McpSession, body: unknown, signal?: AbortSignal): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	if (signal) {
		const onAbort = () => controller.abort();
		signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const res = await fetch(GITHUB_MCP_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${session.token}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
				"X-MCP-Host": "copilot-cli",
				"X-MCP-Toolsets": "web_search",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`GitHub MCP request failed (${res.status}): ${text.slice(0, 300)}`);
		}
		return text;
	} finally {
		clearTimeout(timer);
	}
}

function parseSseData(text: string, id: number | string): unknown {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const parsed = JSON.parse(payload) as { id?: number | string; result?: unknown; error?: { code?: number; message?: string } };
			if (parsed.id !== id) continue;
			if (parsed.error) {
				throw new Error(`GitHub MCP error ${parsed.error.code ?? ""}: ${parsed.error.message ?? "unknown"}`);
			}
			return parsed.result;
		} catch (err) {
			if (err instanceof SyntaxError) continue;
			throw err;
		}
	}
	throw new Error("GitHub MCP response did not contain the expected result");
}

function buildSearchQuery(query: string, options: SearchOptions): string {
	const constraints: string[] = [];
	if (options.domainFilter && options.domainFilter.length > 0) {
		const included = options.domainFilter.filter((d) => !d.startsWith("-"));
		const excluded = options.domainFilter.filter((d) => d.startsWith("-")).map((d) => normalizeDomain(d.slice(1)));
		if (included.length > 0) constraints.push(`restrict results to these domains: ${included.join(", ")}`);
		if (excluded.length > 0) constraints.push(`exclude these domains: ${excluded.join(", ")}`);
	}
	if (options.recencyFilter) {
		const window: Record<string, string> = { day: "the last day", week: "the last week", month: "the last month", year: "the last year" };
		constraints.push(`only consider information from ${window[options.recencyFilter]}`);
	}
	if (constraints.length === 0) return query;
	return `${query}. Constraints: ${constraints.join("; ")}.`;
}

export async function searchWithGithub(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const token = await requireGithubToken(options.signal);
	const session: McpSession = { sessionId: "", token };

	const initText = await mcpRequest(
		session,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pi-web-access", version: "1.0.0" },
			},
		},
		options.signal,
	);
	const match = initText.split("\r\n").find((line) => line.toLowerCase().startsWith("mcp-session-id:"));
	if (match) {
		session.sessionId = match.slice("mcp-session-id:".length).trim();
	}

	await mcpRequest(session, { jsonrpc: "2.0", method: "notifications/initialized" }, options.signal);

	const callText = await mcpRequest(
		session,
		{
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "web_search", arguments: { query: buildSearchQuery(query, options) } },
		},
		options.signal,
	);

	const result = parseSseData(callText, 2) as { content?: Array<{ type?: string; text?: string }> };
	const text = result?.content?.find((c) => c.type === "text")?.text;
	if (!text) throw new Error("GitHub MCP web_search returned no content");

	let payload: GithubResponse;
	try {
		payload = JSON.parse(text) as GithubResponse;
	} catch {
		throw new Error("GitHub MCP web_search returned unparseable content");
	}
	if (typeof payload.error_message === "string" && payload.error_message) {
		throw new Error(`GitHub web search error: ${payload.error_message}`);
	}

	const items: GithubItem[] = (payload.search_result_groups ?? []).flatMap((group) => group.items ?? []);
	const results: SearchResult[] = items.map((item) => ({
		title: typeof item.title === "string" ? item.title : "Untitled",
		url: typeof item.url === "string" ? item.url : "",
		snippet: typeof item.snippets === "string"
			? item.snippets
			: Array.isArray(item.snippets)
				? item.snippets.filter((s): s is string => typeof s === "string").join(" ")
				: typeof item.semantic_document === "string"
					? item.semantic_document.slice(0, 500)
					: "",
	})).filter((r) => r.url);

	const numResults = options.numResults && options.numResults > 0 ? options.numResults : undefined;
	if (numResults) results.length = Math.min(numResults, results.length);

	return { answer: "", results };
}
