export const BASE_CHAIN_ID = 8453;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Connect {
  constructor({ apiKey, baseUrl = 'https://api.connect.quid.li' }) {
    if (!apiKey) throw new Error('CONNECT_API_KEY is not set');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(method, path, { body, query } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'x-api-key': this.apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = Array.isArray(data.message) ? data.message.join('; ') : data.message ?? data.error ?? 'error';
      throw new Error(`Connect ${method} ${path} → ${res.status}: ${msg}`);
    }
    return { status: res.status, data };
  }

  /**
   * GitHub usernames → Base payout addresses. Creates wallets for people who
   * don't have one yet. Returns Map(lowercased username → address).
   */
  async resolveGithub(usernames, { attempts = 8, delayMs = 3000 } = {}) {
    const recipients = usernames.map((u) => ({ type: 'github', username: u }));
    for (let i = 0; i < attempts; i++) {
      const { data } = await this.request('POST', '/lookup', { body: { recipients } });
      if (data.status === 'completed') {
        const map = new Map();
        for (const r of data.results ?? []) {
          if (r.ethWalletAddress) map.set(String(r.value).toLowerCase(), r.ethWalletAddress);
        }
        return map;
      }
      await sleep(delayMs);
    }
    throw new Error('Connect lookup still processing after retries');
  }

  /** Balances for the Smart Send wallet. `token` is a resolved token from src/token.js. */
  async balances(token, chainId = BASE_CHAIN_ID) {
    const { data } = await this.request('GET', '/drop/balance', { query: { chainId } });
    const assets = data.assets ?? [];
    const held = assets.find((a) => a.tokenContract?.toLowerCase() === token.address.toLowerCase());
    const eth = assets.find((a) => a.type === 'native');
    return {
      wallet: data.walletAddress,
      tokenUnits: BigInt(held?.balanceInWei ?? 0),
      ethWei: BigInt(eth?.balanceInWei ?? 0),
      // every token this wallet holds, usable for symbol resolution
      assets: assets.map((a) => ({ address: a.tokenContract, symbol: a.symbol, decimals: a.decimals })).filter((a) => a.address),
    };
  }

  /** Smart Send an ERC-20 to resolved wallet addresses. `payments`: [{ address, units: bigint }] */
  async drop(token, payments, idempotencyKey, { attempts = 8, delayMs = 3000 } = {}) {
    const body = {
      idempotencyKey,
      chainId: BASE_CHAIN_ID,
      tokenContract: token.address,
      recipients: payments.map((p) => ({ type: 'wallet', id: p.address, amountInWei: p.units.toString() })),
    };
    for (let i = 0; i < attempts; i++) {
      const { status, data } = await this.request('POST', '/drop', { body });
      if (status !== 202) return { data, txHashes: extractTxHashes(data) };
      await sleep(delayMs); // recipients still processing — same key is safe to retry
    }
    throw new Error(`Drop still processing after retries (idempotencyKey ${idempotencyKey})`);
  }
}

export function extractTxHashes(obj) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/0x[0-9a-fA-F]{64}/g)) found.add(m[0]);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(obj);
  return [...found];
}
