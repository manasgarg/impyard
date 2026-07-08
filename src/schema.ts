// The narrow waist: the vocabulary every governed action speaks.
//
// A request leaving the box is described in standard HTTP terms (plus MCP's
// own terms when it carries a JSON-RPC tool call). Rules match on those
// terms; the only invented token is a rule's `name`, which is where a
// deployment attaches its own meaning (budgets/trust/gates bind to names,
// not to a fixed action list). See docs/judge-spec.md.

export type Verdict = "allow" | "deny" | "tunnel";

/** What the gateway saw, phrased as the judge's question. */
export interface GovernedRequest {
  /** Which worker made the call. Null until worker identity is wired in. */
  worker: string | null;
  protocol: "http" | "https";
  method: string;
  host: string;
  port: number;
  path: string;
  query: string;
  /** Lowercased header names → values (as the gateway saw them). */
  headers: Record<string, string>;
  bodySize: number;
  /** Lifted from a JSON-RPC body, when the request carries one. */
  mcp: { method: string; tool?: string } | null;
}

/** A rule's match clause. Every field optional; omitted = matches anything;
 * all present fields must hold (AND). */
export interface Match {
  protocol?: string | string[];
  /** exact, `*.suffix.com`, or `*` */
  host?: string | string[];
  port?: number | number[];
  method?: string | string[];
  pathPrefix?: string;
  /** header name → required substring ("" = presence only) */
  headerContains?: Record<string, string>;
  /** rule matches only if bodySize ≤ this */
  maxBodySize?: number;
  mcp?: {
    method?: string | string[];
    /** glob(s), e.g. "get_*" */
    tool?: string | string[];
  };
}

export interface Rule {
  name: string;
  match: Match;
  verdict: Verdict;
}

export interface Policy {
  rules: Rule[];
}

/** One permanent line in runs/decisions.jsonl. */
export interface Decision {
  decision_id: string;
  ts: string;
  verdict: Verdict;
  /** The rule that decided, or null when nothing matched (default deny). */
  rule: string | null;
  request: GovernedRequest;
}
