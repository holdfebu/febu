// Swap configuration. Fee params live here and are enforced server-side so a
// client can't strip them by editing requests.

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export const FEBU_MINT = "4ko5tSr5o3H4v1sFtjTSd9MPUW7yx5AFCpkNPoL6pump";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Where the platform fee accrues. Public address; override via env if needed.
export const FEE_WALLET =
  process.env.NEXT_PUBLIC_FEE_WALLET ||
  "D4m8uCTpEmsg5LCQs3tQpZ3hajdkwdCaCwqbeJ3pLcMx";

// 0.4% platform fee on top of Jupiter's routing.
export const PLATFORM_FEE_BPS = 40;

export interface InputToken {
  key: "SOL" | "USDC";
  mint: string;
  symbol: string;
  decimals: number;
  /** Fee accrues in the input token, so the fee account is this mint's ATA. */
  feeAccount: string;
}

const feeWallet = new PublicKey(FEE_WALLET);
const feeAta = (mint: string) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), feeWallet).toBase58();

export const INPUT_TOKENS: Record<"SOL" | "USDC", InputToken> = {
  SOL: {
    key: "SOL",
    mint: WSOL_MINT,
    symbol: "SOL",
    decimals: 9,
    feeAccount: feeAta(WSOL_MINT),
  },
  USDC: {
    key: "USDC",
    mint: USDC_MINT,
    symbol: "USDC",
    decimals: 6,
    feeAccount: feeAta(USDC_MINT),
  },
};

export function inputTokenByMint(mint: string): InputToken | null {
  if (mint === WSOL_MINT) return INPUT_TOKENS.SOL;
  if (mint === USDC_MINT) return INPUT_TOKENS.USDC;
  return null;
}

// Jupiter free tier — no key required.
export const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
export const JUP_SWAP = "https://lite-api.jup.ag/swap/v1/swap";
