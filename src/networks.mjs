/** Blocks below the head that count as settled. Avalanche blocks are final; Base Sepolia's may still be replaced. */
export function settledDepth(network) {
  return network === "eip155:84532" ? 30n : 0n;
}

/** Public RPCs of the testnets, for reading the outcome of a payment that has to be provable (monthly). */
export const PUBLIC_RPC = { "eip155:43113": "https://api.avax-test.network/ext/bc/C/rpc", "eip155:84532": "https://sepolia.base.org" };
