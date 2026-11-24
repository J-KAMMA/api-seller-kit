// Cloudflare Workers store. Import only in a Worker (needs "cloudflare:workers").
// One Durable Object per key: it handles one request at a time, so compareAndSet is one step for every Worker instance.
import { DurableObject } from "cloudflare:workers";
import { sameJson } from "./store.mjs";

export class SellerKitStore extends DurableObject {
  async get() {
    return (await this.ctx.storage.get("value")) ?? null;
  }

  async set(value) {
    await this.ctx.storage.put("value", value);
  }

  async compareAndSet(expected, next) {
    return this.ctx.storage.transaction(async (txn) => {
      if (!sameJson((await txn.get("value")) ?? null, expected)) return false;
      await txn.put("value", next);
      return true;
    });
  }
}

/** @param {DurableObjectNamespace} namespace the binding of SellerKitStore */
export function createDurableObjectStore(namespace) {
  if (typeof namespace?.idFromName !== "function") throw new Error("durable object store: namespace binding required");
  const stub = (key) => namespace.get(namespace.idFromName(key));
  return {
    get: async (key) => (await stub(key).get()) ?? null,
    set: async (key, value) => {
      await stub(key).set(value);
    },
    compareAndSet: async (key, expected, next) => (await stub(key).compareAndSet(expected, next)) === true,
  };
}
