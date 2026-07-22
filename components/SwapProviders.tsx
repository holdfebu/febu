"use client";

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

// Wallet-adapter needs a client-only provider tree. Phantom, Solflare and
// Backpack auto-register via the Wallet Standard, so no adapter list is needed.
// The connection endpoint is a formality — swaps are broadcast through our own
// server (/api/swap/send), so this RPC is never used for the hot path.
export default function SwapProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  const endpoint = useMemo(() => "https://api.mainnet-beta.solana.com", []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
