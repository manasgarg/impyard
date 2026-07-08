import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, hostMatches, globMatches } from "../src/judge.ts";
import type { GovernedRequest, Policy } from "../src/schema.ts";

function req(over: Partial<GovernedRequest> = {}): GovernedRequest {
  return {
    worker: null,
    protocol: "https",
    method: "POST",
    host: "chatgpt.com",
    port: 443,
    path: "/backend-api/codex/responses",
    query: "",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    bodySize: 100,
    mcp: null,
    ...over,
  };
}

test("default-deny: empty policy denies everything", () => {
  const d = judge(req(), { rules: [] });
  assert.equal(d.verdict, "deny");
  assert.equal(d.rule, null);
});

test("first match wins", () => {
  const policy: Policy = {
    rules: [
      { name: "deny-all", match: {}, verdict: "deny" },
      { name: "allow-all", match: {}, verdict: "allow" },
    ],
  };
  const d = judge(req(), policy);
  assert.equal(d.verdict, "deny");
  assert.equal(d.rule, "deny-all");
});

test("host + port match (the seed model-api rule)", () => {
  const policy: Policy = {
    rules: [{ name: "model-api", match: { host: ["chatgpt.com", "api.anthropic.com"], port: 443 }, verdict: "allow" }],
  };
  assert.equal(judge(req({ host: "chatgpt.com" }), policy).verdict, "allow");
  assert.equal(judge(req({ host: "api.anthropic.com" }), policy).verdict, "allow");
  assert.equal(judge(req({ host: "evil.com" }), policy).verdict, "deny");
  assert.equal(judge(req({ host: "chatgpt.com", port: 8080 }), policy).verdict, "deny");
});

test("method match is case-insensitive and denies the method that loses", () => {
  const policy: Policy = { rules: [{ name: "posts-only", match: { host: "chatgpt.com", method: "post" }, verdict: "allow" }] };
  assert.equal(judge(req({ method: "POST" }), policy).verdict, "allow");
  assert.equal(judge(req({ method: "GET" }), policy).verdict, "deny");
});

test("pathPrefix match", () => {
  const policy: Policy = { rules: [{ name: "api", match: { pathPrefix: "/backend-api/" }, verdict: "allow" }] };
  assert.equal(judge(req({ path: "/backend-api/codex/responses" }), policy).verdict, "allow");
  assert.equal(judge(req({ path: "/admin/keys" }), policy).verdict, "deny");
});

test("maxBodySize: rule matches only at or under the cap (default-deny above)", () => {
  const policy: Policy = { rules: [{ name: "small", match: { host: "chatgpt.com", maxBodySize: 1000 }, verdict: "allow" }] };
  assert.equal(judge(req({ bodySize: 500 }), policy).verdict, "allow");
  assert.equal(judge(req({ bodySize: 5000 }), policy).verdict, "deny");
});

test("headerContains: presence and substring", () => {
  const presence: Policy = { rules: [{ name: "has-auth", match: { headerContains: { authorization: "" } }, verdict: "allow" }] };
  assert.equal(judge(req(), presence).verdict, "allow");
  assert.equal(judge(req({ headers: {} }), presence).verdict, "deny");
  const substr: Policy = { rules: [{ name: "json", match: { headerContains: { "content-type": "json" } }, verdict: "allow" }] };
  assert.equal(judge(req(), substr).verdict, "allow");
  assert.equal(judge(req({ headers: { "content-type": "text/plain" } }), substr).verdict, "deny");
});

test("mcp method + tool glob match; non-mcp request never matches an mcp rule", () => {
  const policy: Policy = {
    rules: [
      { name: "mcp-readonly", match: { mcp: { method: "tools/call", tool: ["get_*", "list_*"] } }, verdict: "allow" },
    ],
  };
  assert.equal(judge(req({ mcp: { method: "tools/call", tool: "get_issue" } }), policy).verdict, "allow");
  assert.equal(judge(req({ mcp: { method: "tools/call", tool: "list_repos" } }), policy).verdict, "allow");
  assert.equal(judge(req({ mcp: { method: "tools/call", tool: "create_pull_request" } }), policy).verdict, "deny");
  assert.equal(judge(req({ mcp: { method: "resources/read" } }), policy).verdict, "deny");
  assert.equal(judge(req({ mcp: null }), policy).verdict, "deny");
});

test("tunnel verdict passes through the judge like any other", () => {
  const policy: Policy = { rules: [{ name: "pinned", match: { host: "pinned.example.com" }, verdict: "tunnel" }] };
  assert.equal(judge(req({ host: "pinned.example.com" }), policy).verdict, "tunnel");
});

test("hostMatches: exact, wildcard-any, suffix", () => {
  assert.ok(hostMatches("chatgpt.com", "chatgpt.com"));
  assert.ok(!hostMatches("chatgpt.com", "evil.chatgpt.com"));
  assert.ok(hostMatches("*", "anything.com"));
  assert.ok(hostMatches("*.githubcopilot.com", "api.githubcopilot.com"));
  assert.ok(hostMatches("*.githubcopilot.com", "githubcopilot.com"));
  assert.ok(!hostMatches("*.githubcopilot.com", "githubcopilot.com.evil.com"));
});

test("globMatches: anchored, * only", () => {
  assert.ok(globMatches("get_*", "get_issue"));
  assert.ok(globMatches("*", "anything"));
  assert.ok(!globMatches("get_*", "set_issue"));
  assert.ok(!globMatches("get_*", "xget_issue"));
});
