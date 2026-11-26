// Closes prepaid channels on a timer (testnet only). The seller key is a secret of this Worker: use a key that only receives earnings.
import { runCloser } from "./closer.mjs";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCloser(env).then(
        (r) => console.log(JSON.stringify({ closed: r.closed.length, failed: r.failed, postponed: r.postponed.length, subrequests: r.subrequests, warnings: r.warnings })),
        // Our own messages name a setting, never its value. Anything else (from the RPC library: it can contain the RPC address and the
        // request) is logged as a category only.
        (e) => console.log(String(e?.message).startsWith("worker-closer: ") ? e.message : `worker-closer: run failed (${e?.name ?? "Error"})`),
      ),
    );
  },
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
