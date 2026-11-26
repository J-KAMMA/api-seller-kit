// A payment made for one gate is refused by every other gate, also by one that keeps its own store.
//
// The gate publishes its id in the 402 quote (extra.gateBinding = { v: 1, gateId }). A buyer that knows the rule picks a random 32-byte r
// and uses as the EIP-3009 nonce
//   keccak256( DOMAIN ‖ uint256(chainId) ‖ address(asset) ‖ address(payTo) ‖ gateId ‖ r )          (six 32-byte words, as abi.encode)
// with DOMAIN = keccak256("hub-gate-v1"), and sends r as paymentPayload.binding = { v: 1, r }. The buyer signs the nonce, so nobody can
// move the payment to another gate: that gate's id gives another nonce.

const DOMAIN_TEXT = "hub-gate-v1";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

// ---- keccak256 (the Ethereum one, not SHA3-256), so that the gate needs no library for it
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
    s[0] ^= RC[round];
  }
}

/** keccak256 of bytes, as 0x hex. */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(bytes.length / rate) * rate + rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "0x";
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out += Number((s[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}

const utf8 = (text) => new TextEncoder().encode(text);
const word = (hex) => hex.slice(2).toLowerCase().padStart(64, "0");
const fromHex = (hex) => Uint8Array.from(hex.slice(2).match(/../g), (b) => parseInt(b, 16));

export const BINDING_DOMAIN = keccak256(utf8(DOMAIN_TEXT));

/** The gate's id as published: a 0x 32-byte value. A text id is hashed; a missing one comes from resource and payTo. */
export function gateIdOf({ gateId, resource, payTo }) {
  if (typeof gateId === "string" && HEX32.test(gateId)) return gateId.toLowerCase();
  if (typeof gateId === "string" && gateId.length > 0) return keccak256(utf8(`gate:${gateId}`));
  return keccak256(utf8(`gate:${resource ?? ""}|${String(payTo).toLowerCase()}`));
}

/** The nonce a buyer must sign for this gate and this r. */
export function boundNonce({ chainId, asset, payTo, gateId, r }) {
  const words = [BINDING_DOMAIN, `0x${BigInt(chainId).toString(16)}`, asset, payTo, gateId, r].map(word).join("");
  return keccak256(fromHex(`0x${words}`));
}

/** "bound" (made for this gate), "foreign" (made for another one, or malformed), or "unbound" (no binding sent). */
export function bindingOf(payload, gate) {
  const b = payload?.binding;
  if (b === undefined) return "unbound";
  const nonce = payload?.payload?.authorization?.nonce;
  if (!b || typeof b !== "object" || b.v !== 1 || typeof b.r !== "string" || !HEX32.test(b.r) || typeof nonce !== "string" || !HEX32.test(nonce)) return "foreign";
  return boundNonce({ ...gate, r: b.r }) === nonce.toLowerCase() ? "bound" : "foreign";
}
