"use client";

import SwapProviders from "./SwapProviders";
import SwapWidget from "./SwapWidget";

// Single client-only entry point so the wallet-adapter stack is dynamically
// imported (ssr:false) and never runs during server rendering.
export default function SwapPanel() {
  return (
    <SwapProviders>
      <SwapWidget />
    </SwapProviders>
  );
}
