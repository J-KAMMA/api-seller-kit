// Pluggable store: { get(key), set(key, value), compareAndSet?(key, expected, next) } (all may be async). Values are JSON.
// compareAndSet writes `next` only when the stored value equals `expected` (null = the key is absent) as one indivisible step, and
// resolves to true when it wrote, false when it did not. It carries plain data only, so any backend (SQL, Redis script, Durable Object)
// can implement it across a network; a callback style update(key, fn) could not.
// Default for Node: one JSON file, atomic write (temp file + rename) under an exclusive lock file. Workers: see durable-object.mjs.

const CAS_DEADLINE_MS = 10_000;
const CAS_MAX_ATTEMPTS = 500;
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]); // Windows: the file is being replaced or removed by another process
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (max) => 1 + Math.floor(Math.random() * max);

export function stableJson(value) {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

/** Equality of JSON values, whatever the key order. null and undefined both mean "absent". */
export function sameJson(a, b) {
  return stableJson(a) === stableJson(b);
}

export function isAtomicStore(store) {
  return typeof store?.compareAndSet === "function";
}

const singleLocks = new WeakMap(); // store object -> Map(key -> tail promise)

/** Adds a compareAndSet that is correct inside ONE process only. Used with `singleInstance: true`, and where no limit depends on it. */
export function singleInstanceStore(store) {
  if (isAtomicStore(store)) return store;
  if (!singleLocks.has(store)) singleLocks.set(store, new Map());
  const locks = singleLocks.get(store);
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    compareAndSet(key, expected, next) {
      const attempt = async () => {
        if (!sameJson(await store.get(key), expected)) return false;
        await store.set(key, next);
        return true;
      };
      const run = (locks.get(key) ?? Promise.resolve()).then(attempt, attempt);
      const tail = run.catch(() => {});
      locks.set(key, tail);
      tail.then(() => locks.get(key) === tail && locks.delete(key));
      return run;
    },
  };
}

/**
 * Read, decide, write; repeated until no other writer came in between. `decide(current)` is pure and returns
 * { next, result } to write, or { result } to leave the value alone. Throws when the store stays contended.
 */
export async function casUpdate(store, key, decide) {
  const deadline = Date.now() + CAS_DEADLINE_MS;
  for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS && Date.now() <= deadline; attempt++) {
    const current = (await store.get(key)) ?? null;
    const { next, result } = decide(current);
    if (next === undefined) return result;
    if ((await store.compareAndSet(key, current, next)) === true) return result;
    await sleep(jitter(Math.min(50, 5 * attempt)));
  }
  throw new Error("store_contended");
}

/** Payment records carry `expiresAt` (unix seconds): a store may drop them afterwards. Nothing else is ever dropped. */
export function isExpired(key, value, now = Date.now() / 1000) {
  return key.startsWith("payment:") && typeof value?.expiresAt === "number" && value.expiresAt < now;
}

const processLocal = new WeakSet();
/** Does this store live in one process (or Worker isolate) only? */
export function isProcessLocal(store) {
  return processLocal.has(store);
}

export function createMemoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  let writes = 0;
  const sweep = () => {
    if (++writes % 256 === 0) for (const [k, v] of map) if (isExpired(k, v)) map.delete(k);
  };
  const store = {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value) {
      sweep();
      map.set(key, structuredClone(value));
    },
    async compareAndSet(key, expected, next) {
      if (!sameJson(map.has(key) ? map.get(key) : null, expected)) return false; // no await up to the write
      sweep();
      map.set(key, structuredClone(next));
      return true;
    },
  };
  processLocal.add(store);
  return store;
}

/**
 * Safe for several processes on ONE machine sharing a local disk. Writes hold `<path>.lock`. A lock left by a process of this machine
 * that no longer runs is removed after `staleMs`; any other lock is respected, and a write that cannot get it in `lockTimeoutMs` throws.
 * @param {string} path
 * @param {{ lockTimeoutMs?: number, staleMs?: number }} [options]
 */
export function createFileStore(path, { lockTimeoutMs = 10_000, staleMs = 10_000 } = {}) {
  if (typeof path !== "string" || !path) throw new Error("file store: path required");
  const lockPath = `${path}.lock`;
  const stealPath = `${path}.lock.steal`;
  let chain = Promise.resolve();

  /** Retries while Windows reports the file as busy. */
  async function whileBusy(fn, timeoutMs = lockTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (!BUSY.has(e?.code) || Date.now() > deadline) throw e;
        await sleep(jitter(10));
      }
    }
  }

  async function load(fs) {
    let text;
    try {
      text = await whileBusy(() => fs.readFile(path, "utf8"));
    } catch (e) {
      if (e && e.code === "ENOENT") return {};
      throw e;
    }
    const data = JSON.parse(text); // a corrupt file throws: never overwrite what we cannot read
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("file store: not an object");
    return data;
  }

  async function readLock(fs, file = lockPath) {
    try {
      return JSON.parse(await whileBusy(() => fs.readFile(file, "utf8")));
    } catch {
      return null; // gone, or still being written
    }
  }

  /** Only a lock whose owner certainly no longer runs. Anything doubtful counts as held. */
  function abandoned(lock, host) {
    if (!lock || lock.host !== host || !Number.isInteger(lock.pid) || typeof lock.at !== "number") return false;
    if (Date.now() - lock.at < staleMs) return false;
    // Same pid as ours but taken before we started: an earlier process had our pid (usual after a container restart).
    if (lock.pid === process.pid) return lock.at < Date.now() - process.uptime() * 1000 - 1000;
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (e) {
      return e?.code === "ESRCH";
    }
  }

  async function acquire(fs, host) {
    const token = globalThis.crypto?.randomUUID?.() ?? `${process.pid}-${Date.now()}-${Math.random()}`;
    const deadline = Date.now() + lockTimeoutMs;
    // Written first under a name of its own, then linked: a lock appears complete or not at all, also when this process is killed.
    const own = `${path}.lock.${token}`;
    await fs.writeFile(own, JSON.stringify({ pid: process.pid, host, at: Date.now(), token }), { mode: 0o600 });
    const create = async (file) => {
      try {
        await fs.link(own, file);
        return true;
      } catch (e) {
        if (e?.code === "EEXIST" || BUSY.has(e?.code)) return false;
        throw e;
      }
    };
    try {
      return await wait();
    } finally {
      await fs.rm(own, { force: true }).catch(() => {});
    }

    async function wait() {
      for (;;) {
        if (await create(lockPath)) return token;
        const stealer = await readLock(fs, stealPath);
        if (abandoned(stealer, host)) await fs.rm(stealPath, { force: true }).catch(() => {}); // died while removing a lock
        if (abandoned(await readLock(fs), host) && (await create(stealPath))) {
          // One remover at a time, and the lock is looked at again under the guard, so a lock taken meanwhile is never removed.
          try {
            if (abandoned(await readLock(fs), host)) await whileBusy(() => fs.rm(lockPath, { force: true }));
          } finally {
            await whileBusy(() => fs.rm(stealPath, { force: true }));
          }
        }
        if (Date.now() > deadline) throw new Error(`file store: ${lockPath} is held; nothing was written (if no process uses the store, delete it, and ${stealPath} if it exists)`);
        await sleep(jitter(15));
      }
    }
  }

  /** `change(data)` edits the object in place; returning false means: do not write. */
  function locked(change) {
    const run = chain.then(async () => {
      const fs = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const host = (await import("node:os")).hostname();
      await fs.mkdir(nodePath.dirname(nodePath.resolve(path)), { recursive: true });
      const token = await acquire(fs, host);
      let tmp = null;
      try {
        const data = await load(fs);
        if (change(data) === false) return false;
        for (const k of Object.keys(data)) if (isExpired(k, data[k])) delete data[k];
        tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        const handle = await fs.open(tmp, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(data));
          await handle.sync(); // on the disk before it gets the name
        } finally {
          await handle.close();
        }
        if ((await readLock(fs))?.token !== token) throw new Error("file store: lock lost; nothing was written");
        await whileBusy(() => fs.rename(tmp, path));
        tmp = null;
        if (process.platform !== "win32") {
          // the new name too; not every file system can do it
          const dir = await fs.open(nodePath.dirname(nodePath.resolve(path)), "r").catch(() => null);
          if (dir) await dir.sync().catch(() => {}).finally(() => dir.close());
        }
        return true;
      } finally {
        if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
        // Never remove a lock that is not ours. Failing to release only blocks later writes; it must not undo or hide this one.
        if ((await readLock(fs))?.token === token) await whileBusy(() => fs.rm(lockPath, { force: true })).catch(() => {});
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  const read = (data, key) => (Object.hasOwn(data, key) ? data[key] : null);

  return {
    async get(key) {
      const fs = await import("node:fs/promises");
      return read(await load(fs), key);
    },
    async set(key, value) {
      await locked((data) => {
        data[key] = value;
      });
    },
    compareAndSet(key, expected, next) {
      return locked((data) => {
        if (!sameJson(read(data, key), expected)) return false;
        data[key] = next;
      });
    },
  };
}
