// What is one unit of this token worth in USD?
// Bankr's quote knows (it prices both legs); DexScreener is the fallback so a
// run without a Bankr key still gets caps. No price → the caller refuses to pay.

export async function usdPrice(token, { bankr, fundingToken } = {}) {
  const fromBankr = await bankrPrice(token, bankr, fundingToken);
  if (fromBankr) return { usd: fromBankr, source: 'bankr' };
  const fromDex = await dexScreenerPrice(token);
  if (fromDex) return { usd: fromDex, source: 'dexscreener' };
  return null;
}

async function bankrPrice(token, bankr, fundingToken) {
  if (!bankr || !fundingToken || fundingToken.address.toLowerCase() === token.address.toLowerCase()) return null;
  try {
    const q = await bankr.quote({ fromToken: fundingToken.address, toToken: token.address, amount: '1' });
    const p = Number(q.buyTokenPriceUsd);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function dexScreenerPrice(token) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const { pairs = [] } = await res.json();
    // Deepest Base pool wins: a thin pool is easy to misprice.
    const best = pairs
      .filter((p) => p.chainId === 'base' && p.priceUsd)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const p = Number(best?.priceUsd);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** "100" USD → "420168.067226" of a token worth $0.000238, as a decimal string. */
export function usdToToken(usd, unitPriceUsd, decimals) {
  const amount = Number(usd) / unitPriceUsd;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`cannot convert $${usd} at price ${unitPriceUsd}`);
  const places = Math.min(decimals, 8);
  return amount.toFixed(places).replace(/\.?0+$/, '') || '0';
}
