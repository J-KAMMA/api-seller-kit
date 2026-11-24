// Who may be served for a payment whose first /settle answer was not a plain success.
// The danger is another gate that takes payments for the same payTo without our store: it may have settled and served this one.
//
// First answer                                                    | class      | later: paid on chain | ran out unused | /settle succeeds, not replayed
// ----------------------------------------------------------------|------------|----------------------|----------------|-------------------------------
// none, 3xx, 5xx, unreadable, "pending", "failed", an unknown      | ambiguous  | serve                | not taken      | serve
// reason, anything with a transaction hash                         |            |                      |                |
// Also ambiguous: 408, 409, 425, 499 (a proxy can answer them after passing the request on).
// other 4xx, or a refusal before sending ("invalid_...")                 | refused    | elsewhere            | not taken      | serve
// replayed, duplicate, nonce already used                          | contested  | elsewhere            | not taken      | (not asked)
//
// In every class: not paid and not run out, or unreadable -> unclear. A replayed success is never a success: only the chain counts then.
// A later /settle answer changes the class of a refused payment only: contested makes it contested; ambiguous makes it ambiguous, but only
// when the chain showed the authorization unused right before (otherwise somebody else's payment could pass for ours).

/** May come from a proxy after it passed the request on. */
const MAYBE_FORWARDED = new Set([408, 409, 425, 499]);

/** { ok, status, data } of a /settle call -> "ok" | "ambiguous" | "refused" | "contested" */
export function classify({ ok, status, data }) {
  const d = data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
  const reason = typeof d.errorReason === "string" ? d.errorReason : "";
  if (d.extensions?.["hub-settlement"]?.replayed === true) return "contested";
  if (ok && d.success === true) return "ok";
  if (/^duplicate_settlement$|nonce_already_used$/.test(reason)) return "contested";
  if (typeof d.transaction === "string" && d.transaction !== "") return "ambiguous";
  if (MAYBE_FORWARDED.has(status)) return "ambiguous";
  if (status >= 400 && status < 500) return "refused";
  if (ok && d.success === false && /^invalid_/.test(reason) && !/transaction_failed|pending|unknown/.test(reason)) return "refused";
  return "ambiguous";
}

/** chain: "paid" | "void" | "unused" | "unclear" -> "serve" | "elsewhere" | "not_taken" | "unclear" */
export function decide(first, chain) {
  if (chain === "void") return "not_taken";
  if (chain === "paid") return first === "ambiguous" || first === "ok" ? "serve" : "elsewhere";
  return "unclear";
}

/** The class after another /settle answer. chainBefore: what the chain showed right before asking. */
export function reclassify(first, again, chainBefore) {
  if (first !== "refused") return first;
  if (again === "contested") return "contested";
  return again === "ambiguous" && chainBefore === "unused" ? "ambiguous" : "refused";
}
