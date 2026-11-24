// One seller process of concurrency.test.mjs: says "ready", waits for a line on stdin, fires its calls, reports.
import { createFileStore } from "../../src/store.mjs";
import { channelGate, monthlyGate, useToken, useVoucher } from "./gates.mjs";

const c = JSON.parse(process.argv[2]);
const store = createFileStore(c.path, { lockTimeoutMs: 30_000 });
const gate = c.mode === "voucher" ? channelGate(store) : c.mode === "quota" ? monthlyGate(store, c.quota) : null;

console.log("ready");
await new Promise((r) => process.stdin.once("data", r));

const repeat = (fn) => Promise.all(Array.from({ length: c.calls }, (_, i) => fn(i)));
let replies = [];
if (c.mode === "voucher") {
  replies = await repeat(() => useVoucher(gate, c.vouchers[0]));
  for (const v of c.own) await useVoucher(gate, v); // each channel is taken by whichever process comes first
} else if (c.mode === "quota") replies = await repeat(() => useToken(gate, c.token));
else await repeat((i) => store.set(`${process.pid}-${i}`, i));

console.log(JSON.stringify({ served: replies.filter((r) => r.status === 200).length, errors: replies.map((r) => r.status).filter((s) => s !== 200 && s !== 402) }));
process.stdin.destroy();
