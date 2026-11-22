// Pluggable store: { get(key), set(key, value) } (both may be async). Values are JSON.
// Default for Node: one JSON file, atomic write (temp file + rename). Workers pass their own store (KV / DO).

export function createMemoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
  };
}

/** @param {string} path */
export function createFileStore(path) {
  if (typeof path !== "string" || !path) throw new Error("file store: path required");
  let chain = Promise.resolve();

  async function load(fs) {
    let text;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return {};
      throw e;
    }
    const data = JSON.parse(text); // a corrupt file throws: never overwrite what we cannot read
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("file store: not an object");
    return data;
  }

  return {
    async get(key) {
      const fs = await import("node:fs/promises");
      const data = await load(fs);
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    set(key, value) {
      const run = chain.then(async () => {
        const fs = await import("node:fs/promises");
        const nodePath = await import("node:path");
        await fs.mkdir(nodePath.dirname(nodePath.resolve(path)), { recursive: true });
        const data = await load(fs);
        data[key] = value;
        const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
        await fs.rename(tmp, path);
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}
