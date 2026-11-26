// Closes prepaid channels on a timer (testnet only). The seller key is a secret of this Worker: use a key that only receives earnings.
import { runCloser } from "./closer.mjs";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCloser(env).then(
        (r) => console.log(JSON.stringify({ closed: r.closed.length, failed: r.failed, postponed: r.postponed.length, subrequests: r.subrequests })),
        (e) => console.log(`worker-closer: ${e.message}`), // the messages name settings, never their values
      ),
    );
  },
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
