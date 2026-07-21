import { getMultipleAccountOwners } from "./helius";

/**
 * AMM programs whose accounts can own a token vault. If a holder's "owner"
 * address is itself an account owned by one of these, it's a liquidity pool
 * rather than a wallet.
 */
const POOL_PROGRAMS: Record<string, string> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora",
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi": "Meteora",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c": "Lifinity",
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "Phoenix",
};

/**
 * Some vaults are owned by a fixed authority PDA that holds no account data,
 * so program lookup can't classify them. These are well-known constants.
 */
const KNOWN_AUTHORITIES: Record<string, string> = {
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium",
  "1nc1nerator11111111111111111111111111111111": "Burn address",
};

/**
 * Classify holder addresses as pools. One `getMultipleAccounts` call per 100
 * addresses, so this is cheap even at scan depth.
 */
export async function classifyPools(
  owners: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  const needLookup: string[] = [];
  for (const o of owners) {
    const known = KNOWN_AUTHORITIES[o];
    if (known) out.set(o, known);
    else needLookup.push(o);
  }

  if (!needLookup.length) return out;

  try {
    const programOwners = await getMultipleAccountOwners(needLookup);
    for (const [addr, programId] of programOwners) {
      if (!programId) continue;
      const label = POOL_PROGRAMS[programId];
      if (label) out.set(addr, label);
    }
  } catch {
    // Classification is best-effort; without it everything reads as a wallet.
  }

  return out;
}
