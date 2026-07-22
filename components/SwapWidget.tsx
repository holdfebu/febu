"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";

type InputKey = "SOL" | "USDC";
const DECIMALS: Record<InputKey, number> = { SOL: 9, USDC: 6 };
const FEBU_DECIMALS = 6;
const FEE_PCT = 0.4;
// Leave a little SOL behind for rent + network fees when the user hits Max.
const SOL_RESERVE = 0.02;

interface Quote {
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  inputMint: string;
  outputMint: string;
  platformFee?: { amount: string; feeBps: number };
}

type TxState =
  | { s: "idle" }
  | { s: "building" }
  | { s: "signing" }
  | { s: "sending" }
  | { s: "confirming"; sig: string }
  | { s: "success"; sig: string }
  | { s: "error"; msg: string; sig?: string };

// Human decimal string -> raw integer string, no floating point.
function toRaw(human: string, decimals: number): string {
  if (!human || isNaN(Number(human))) return "0";
  const [int, frac = ""] = human.split(".");
  const fracPad = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = (int + fracPad).replace(/^0+/, "");
  return raw || "0";
}
const fromRaw = (raw: string, decimals: number) => Number(raw) / 10 ** decimals;

const fmt = (n: number, max = 4) =>
  n.toLocaleString("en-US", { maximumFractionDigits: max });

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function bytesToB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

export default function SwapWidget() {
  const { publicKey, connected, signTransaction, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  const [input, setInput] = useState<InputKey>("SOL");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ SOL: number; USDC: number } | null>(null);
  const [tx, setTx] = useState<TxState>({ s: "idle" });

  const decimals = DECIMALS[input];
  const rawAmount = toRaw(amount, decimals);
  const hasAmount = rawAmount !== "0";

  // --- balances on connect / token change ---
  const refreshBalances = useCallback(async () => {
    if (!publicKey) return setBalances(null);
    try {
      const res = await fetch(`/api/swap/balance?owner=${publicKey.toBase58()}`);
      const j = await res.json();
      if (res.ok) setBalances({ SOL: j.SOL, USDC: j.USDC });
    } catch {
      /* non-fatal */
    }
  }, [publicKey]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  // --- debounced quote ---
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (quoteTimer.current) clearTimeout(quoteTimer.current);
    if (!hasAmount) {
      setQuote(null);
      setQuoteErr(null);
      return;
    }
    setQuoting(true);
    quoteTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/swap/quote?input=${input}&amount=${rawAmount}&slippageBps=${slippageBps}`
        );
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "no route");
        setQuote(j as Quote);
        setQuoteErr(null);
      } catch (e) {
        setQuote(null);
        setQuoteErr(e instanceof Error ? e.message : "quote failed");
      } finally {
        setQuoting(false);
      }
    }, 350);
    return () => {
      if (quoteTimer.current) clearTimeout(quoteTimer.current);
    };
  }, [input, rawAmount, slippageBps, hasAmount]);

  const setMax = () => {
    if (!balances) return;
    const bal = balances[input];
    const usable = input === "SOL" ? Math.max(0, bal - SOL_RESERVE) : bal;
    setAmount(String(usable));
  };

  const pollConfirm = async (sig: string): Promise<boolean> => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`/api/swap/status?sig=${sig}`);
        const j = await res.json();
        if (j.err) return false;
        if (j.confirmationStatus === "confirmed" || j.confirmationStatus === "finalized")
          return true;
      } catch {
        /* keep polling */
      }
    }
    return false;
  };

  const doSwap = async () => {
    if (!connected || !publicKey) return setVisible(true);
    if (!quote || !signTransaction) return;
    try {
      setTx({ s: "building" });
      const buildRes = await fetch("/api/swap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: publicKey.toBase58(),
        }),
      });
      const buildJson = await buildRes.json();
      if (!buildRes.ok) throw new Error(buildJson.error || "couldn't build swap");

      const vtx = VersionedTransaction.deserialize(
        b64ToBytes(buildJson.swapTransaction)
      );

      setTx({ s: "signing" });
      const signed = await signTransaction(vtx);

      setTx({ s: "sending" });
      const sendRes = await fetch("/api/swap/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedTransaction: bytesToB64(signed.serialize()) }),
      });
      const sendJson = await sendRes.json();
      if (!sendRes.ok) throw new Error(sendJson.error || "broadcast failed");

      const sig = sendJson.signature as string;
      setTx({ s: "confirming", sig });
      const ok = await pollConfirm(sig);
      setTx(ok ? { s: "success", sig } : { s: "error", msg: "not confirmed — check the explorer", sig });
      setAmount("");
      setQuote(null);
      refreshBalances();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "swap failed";
      // Wallet rejection surfaces as a thrown error; make it readable.
      setTx({ s: "error", msg: /reject|denied|cancel/i.test(msg) ? "cancelled in wallet" : msg });
    }
  };

  const out = quote ? fromRaw(quote.outAmount, FEBU_DECIMALS) : 0;
  const minOut = quote ? fromRaw(quote.otherAmountThreshold, FEBU_DECIMALS) : 0;
  const feeInInput = hasAmount ? Number(amount) * (FEE_PCT / 100) : 0;
  const impact = quote ? Number(quote.priceImpactPct) * 100 : 0;
  const busy = ["building", "signing", "sending", "confirming"].includes(tx.s);

  return (
    <div className="swap-card">
      <div className="swap-head">
        <span className="swap-title">Buy $FEBU</span>
        {connected && publicKey ? (
          <button className="swap-wallet" onClick={() => disconnect()}>
            ◉ {publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}
          </button>
        ) : (
          <button className="swap-wallet" onClick={() => setVisible(true)}>
            connect wallet
          </button>
        )}
      </div>

      <div className="swap-field">
        <div className="swap-field-top">
          <span>You pay</span>
          {balances && (
            <button className="swap-bal" onClick={setMax}>
              {fmt(balances[input], input === "SOL" ? 4 : 2)} {input} · max
            </button>
          )}
        </div>
        <div className="swap-field-row">
          <input
            className="swap-amount"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d*\.?\d*$/.test(v)) setAmount(v);
            }}
          />
          <div className="swap-toggle">
            {(["SOL", "USDC"] as InputKey[]).map((k) => (
              <button
                key={k}
                className={`swap-tok${input === k ? " on" : ""}`}
                onClick={() => setInput(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="swap-arrow">↓</div>

      <div className="swap-field">
        <div className="swap-field-top">
          <span>You receive (estimated)</span>
        </div>
        <div className="swap-field-row">
          <div className="swap-out">
            {quoting ? "…" : quote ? fmt(out, 2) : "0.0"}
          </div>
          <div className="swap-outtok">FEBU</div>
        </div>
      </div>

      {quoteErr && <div className="swap-note err">{quoteErr}</div>}

      {quote && !quoteErr && (
        <div className="swap-detail">
          <div>
            <span>Rate</span>
            <span>1 {input} ≈ {fmt(out / Number(amount || 1), 2)} FEBU</span>
          </div>
          <div>
            <span>Platform fee ({FEE_PCT}%)</span>
            <span>{fmt(feeInInput, input === "SOL" ? 5 : 3)} {input}</span>
          </div>
          <div>
            <span>Price impact</span>
            <span className={impact > 3 ? "warn" : ""}>{impact.toFixed(2)}%</span>
          </div>
          <div>
            <span>Min received ({slippageBps / 100}% slippage)</span>
            <span>{fmt(minOut, 2)} FEBU</span>
          </div>
        </div>
      )}

      <div className="swap-slip">
        <span>Slippage</span>
        {[50, 100, 300].map((b) => (
          <button
            key={b}
            className={`swap-slipbtn${slippageBps === b ? " on" : ""}`}
            onClick={() => setSlippageBps(b)}
          >
            {b / 100}%
          </button>
        ))}
      </div>

      <button
        className="swap-btn"
        disabled={busy || (connected && (!quote || !hasAmount))}
        onClick={doSwap}
      >
        {!connected
          ? "Connect wallet"
          : busy
            ? tx.s === "confirming"
              ? "Confirming…"
              : tx.s === "signing"
                ? "Sign in wallet…"
                : "Working…"
            : !hasAmount
              ? "Enter an amount"
              : !quote
                ? "No route"
                : `Buy FEBU with ${input}`}
      </button>

      {tx.s === "success" && (
        <div className="swap-note ok">
          ✓ Swap confirmed ·{" "}
          <a href={`https://solscan.io/tx/${tx.sig}`} target="_blank" rel="noreferrer">
            view
          </a>
        </div>
      )}
      {tx.s === "error" && (
        <div className="swap-note err">
          {tx.msg}
          {tx.sig && (
            <>
              {" · "}
              <a href={`https://solscan.io/tx/${tx.sig}`} target="_blank" rel="noreferrer">
                explorer
              </a>
            </>
          )}
        </div>
      )}

      <div className="swap-foot">
        Routed by Jupiter · you sign in your own wallet · non-custodial
      </div>
    </div>
  );
}
