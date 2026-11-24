// Processes killed at any moment while they write: nothing acknowledged is lost, the file stays readable, the others go on.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileStore } from "../src/store.mjs";

const src = new URL("../src/store.mjs", import.meta.url).href;
const path = () => join(mkdtempSync(join(tmpdir(), "seller-kit-kill-")), "s.json");

test("abrupt kills", async () => {
  const file = path();
  const code = `
    import { writeSync } from "node:fs";
    import { casUpdate, createFileStore } from ${JSON.stringify(src)};
    const store = createFileStore(${JSON.stringify(file)}, { staleMs: 300, lockTimeoutMs: 20000 });
    for (;;) { await casUpdate(store, "n", (cur) => ({ next: (cur ?? 0) + 1 })); writeSync(1, "."); }`;
  let acked = 0;
  let kills = 0;
  const alive = new Set();
  const start = () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (d) => (acked += d.length));
    child.closed = new Promise((r) => child.on("close", r));
    alive.add(child);
    return child;
  };
  for (let i = 0; i < 3; i++) start();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 200));
    const [victim] = alive;
    alive.delete(victim);
    victim.kill("SIGKILL");
    kills++;
    start();
  }
  for (const child of alive) child.kill("SIGKILL");
  kills += alive.size;
  await Promise.all([...alive].map((c) => c.closed));
  const store = createFileStore(file, { staleMs: 300, lockTimeoutMs: 20_000 });
  await store.set("end", true); // a lock left behind does not block
  const n = await store.get("n");
  assert.ok(acked > 0 && n >= acked && n <= acked + kills, `n ${n}, acknowledged ${acked}, kills ${kills}`);
  assert.equal(existsSync(`${file}.lock`), false);
  JSON.parse(readFileSync(file, "utf8"));
});

// Two "containers" one after the other: same host name, same pid 1, one shared file.
const unshare = ["-r", "--pid", "--fork", "--mount-proc"];
const skip = (process.platform !== "linux" || spawnSync("unshare", [...unshare, "true"]).status !== 0) && "needs Linux with unprivileged pid namespaces";
test("a restarted container gets past the lock its former pid 1 left", { skip }, async () => {
  const file = path();
  const inContainer = (code) => spawnSync("unshare", [...unshare, process.execPath, "--input-type=module", "-e", `import { createFileStore } from ${JSON.stringify(src)};\n${code}`], { encoding: "utf8" });
  // dies while it holds the lock
  const first = inContainer(`await createFileStore(${JSON.stringify(file)}).set("a", { toJSON() { process.reallyExit(process.pid === 1 ? 9 : 8); } });`);
  assert.equal(first.status, 9, first.stderr);
  assert.equal(JSON.parse(readFileSync(`${file}.lock`, "utf8")).pid, 1);
  await new Promise((r) => setTimeout(r, 1_500));
  const second = inContainer(`await createFileStore(${JSON.stringify(file)}, { staleMs: 1000, lockTimeoutMs: 5000 }).set("b", process.pid);`);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { b: 1 });
  assert.equal(existsSync(`${file}.lock`), false);
});
