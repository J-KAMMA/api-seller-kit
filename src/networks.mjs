/** Blocks below the head that count as settled. Avalanche blocks are final; Base Sepolia's may still be replaced. */
export function settledDepth(network) {
  return network === "eip155:84532" ? 30n : 0n;
}
