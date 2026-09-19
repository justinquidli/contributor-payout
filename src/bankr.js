// Bankr Wallet API (deterministic endpoints, not the natural-language agent).
// Used as the treasury: it holds the funding token and swaps it for whatever
// the payout is denominated in.
const BASE_URL = 'https://api.bankr.bot';

export class Bankr {
  constructor({ apiKey, baseUrl = BASE_URL } = {}) {
    if (!apiKey) throw new Error('BANKR_API_KEY is not set');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Bankr ${method} ${path} → ${res.status}: ${data.message ?? data.error ?? 'error'}`);
    return data;
  }

  /** The Bankr wallet's own address — where funding must be sent before a swap. */
  async address() {
    const p = await this.request('GET', '/wallet/portfolio?chains=base');
    if (!p.evmAddress) throw new Error('Bankr portfolio returned no evmAddress');
    return p.evmAddress;
  }

  quote({ fromToken, toToken, amount, slippageBps = 500, chain = 'base' }) {
    return this.request('POST', '/wallet/swap-quote', {
      fromChain: chain, toChain: chain, fromToken, toToken, amount, slippageBps,
    });
  }

  /** Returns { success, hash, amountReceived, amountReceivedRaw }. success:false = mined but reverted. */
  swap({ fromToken, toToken, amount, minBuyAmount, quoteId, idempotencyKey, slippageBps = 500, chain = 'base' }) {
    return this.request('POST', '/wallet/swap', {
      fromChain: chain, toChain: chain, fromToken, toToken, amount, minBuyAmount, quoteId, idempotencyKey, slippageBps,
    });
  }

  transfer({ tokenAddress, recipientAddress, amount, chain = 'base' }) {
    return this.request('POST', '/wallet/transfer', {
      tokenAddress, recipientAddress, amount, isNativeToken: false, chain,
    });
  }
}
