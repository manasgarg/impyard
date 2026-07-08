// The judge: a pure function from (request, policy) to a verdict.
//
// First matching rule wins; no matching rule denies. This is the whole of
// governance's decision logic — deliberately small, deliberately readable,
// and pure so it can be unit-tested exhaustively. Everything stateful
// (ledgers, trust, gates) will layer on top by consulting rule names, never
// by changing this. See docs/judge-spec.md.

import type { GovernedRequest, Match, Policy, Verdict } from "./schema.ts";

export interface JudgeResult {
  verdict: Verdict;
  /** Name of the deciding rule, or null on default-deny. */
  rule: string | null;
}

export function judge(req: GovernedRequest, policy: Policy): JudgeResult {
  for (const rule of policy.rules) {
    if (matches(rule.match, req)) return { verdict: rule.verdict, rule: rule.name };
  }
  return { verdict: "deny", rule: null };
}

function matches(m: Match, req: GovernedRequest): boolean {
  if (m.protocol !== undefined && !arr(m.protocol).includes(req.protocol)) return false;
  if (m.host !== undefined && !arr(m.host).some((p) => hostMatches(p, req.host))) return false;
  if (m.port !== undefined && !arr(m.port).includes(req.port)) return false;
  if (m.method !== undefined && !arr(m.method).map(up).includes(up(req.method))) return false;
  if (m.pathPrefix !== undefined && !req.path.startsWith(m.pathPrefix)) return false;
  if (m.maxBodySize !== undefined && req.bodySize > m.maxBodySize) return false;
  if (m.headerContains !== undefined) {
    for (const [name, sub] of Object.entries(m.headerContains)) {
      const val = req.headers[name.toLowerCase()];
      if (val === undefined) return false;
      if (sub !== "" && !val.includes(sub)) return false;
    }
  }
  if (m.mcp !== undefined) {
    if (req.mcp === null) return false;
    if (m.mcp.method !== undefined && !arr(m.mcp.method).includes(req.mcp.method)) return false;
    if (m.mcp.tool !== undefined) {
      if (req.mcp.tool === undefined) return false;
      if (!arr(m.mcp.tool).some((p) => globMatches(p, req.mcp!.tool!))) return false;
    }
  }
  return true;
}

function arr<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function up(s: string): string {
  return s.toUpperCase();
}

/** exact | `*` (any) | `*.suffix` (any label under suffix, and suffix itself). */
export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".suffix.com"
    return host === pattern.slice(2) || host.endsWith(suffix);
  }
  return pattern === host;
}

/** Shell-style glob over `*` only (no `?`, no char classes). Anchored. */
export function globMatches(pattern: string, s: string): boolean {
  const rx = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
  return rx.test(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
