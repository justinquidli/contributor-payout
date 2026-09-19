// Any ERC-20 on Base. Nothing about USDC or BNKR is hardcoded: decimals and
// symbol always come from the token contract itself.
import { createPublicClient, http, fallback, erc20Abi, isAddress, getAddress } from 'viem';
import { base } from 'viem/chains';
import { usdToToken } from './price.js';

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEFAULT_TOKEN_LIST = 'https://tokens.coingecko.com/base/all.json';

// Public Base RPCs rate-limit hard. Retry, then fall through to the next one.
// BASE_RPC_URL (Alchemy/Infura/QuickNode…) is tried first when set.
const PUBLIC_RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base',
];

export function publicClient(env = process.env) {
  const urls = [env.BASE_RPC_URL, ...PUBLIC_RPCS].filter(Boolean);
  const transport = fallback(
    urls.map((url) => http(url, { retryCount: 4, retryDelay: 800, timeout: 20_000 })),
    { rank: false },
  );
  return createPublicClient({ chain: base, transport });
}

/** Read symbol + decimals from the contract. Authoritative; never guessed. */
export async function tokenAt(address, client) {
  const a = getAddress(address);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { address: a, symbol, decimals: Number(decimals) };
}

export async function balanceOf(token, owner, client) {
  return client.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(owner)] });
}

/**
 * Resolve "0x…" | "USDC" | "BNKR" to a token.
 * Symbols are looked up in: TOKEN_<SYMBOL> in .env → tokens the wallets already
 * hold (candidates) → a Base token list. Several matches = error, never a guess:
 * two different contracts can both call themselves "OpenAI".
 */
export async function resolveToken(spec, { client, env = process.env, candidates = [] } = {}) {
  const raw = String(spec ?? '').trim();
  if (!raw) throw new Error('no token given');
  if (isAddress(raw)) return tokenAt(raw, client);

  const symbol = raw.toUpperCase();
  const override = env[`TOKEN_${symbol}`];
  if (override) return tokenAt(override, client);

  const hits = new Map();
  for (const c of candidates) {
    if (c?.symbol?.toUpperCase() === symbol && c.address) hits.set(c.address.toLowerCase(), c.address);
  }
  if (hits.size === 0) {
    for (const t of await fetchTokenList(env)) {
      if (t.symbol?.toUpperCase() === symbol) hits.set(t.address.toLowerCase(), t.address);
    }
  }

  const found = [...hits.values()];
  if (found.length === 0) {
    throw new Error(`unknown token "${raw}". Pass the contract address, or set TOKEN_${symbol}=0x… in .env`);
  }
  if (found.length > 1) {
    throw new Error(
      `"${raw}" matches ${found.length} contracts on Base — pass the address you mean, or set TOKEN_${symbol}:\n  ${found.join('\n  ')}`,
    );
  }
  return tokenAt(found[0], client);
}

async function fetchTokenList(env) {
  const url = env.TOKEN_LIST_URL || DEFAULT_TOKEN_LIST;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const body = await res.json();
    return (body.tokens ?? []).filter((t) => !t.chainId || t.chainId === base.id);
  } catch {
    return [];
  }
}

/** "1.5" → units, using this token's decimals. Truncates extra precision. */
export function toUnits(value, decimals) {
  const s = typeof value === 'number' ? value.toFixed(decimals) : String(value).trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`invalid amount: ${JSON.stringify(value)}`);
  const frac = (m[2] ?? '').padEnd(decimals, '0').slice(0, decimals);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

export function fromUnits(units, decimals) {
  const n = BigInt(units);
  const base10 = 10n ** BigInt(decimals);
  const whole = n / base10;
  const frac = (n % base10).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Caps, in this token's own units.
 *
 * Preferred: one set of USD limits in .env (MAX_BUDGET_USD, …), converted at
 * run time using the token's price — so "never spend more than $100" holds for
 * USDC and for a token worth $0.0002 alike.
 * A per-token override (MAX_BUDGET_<SYM>, …) wins when present, for a token
 * you'd rather cap by count.
 * Neither available, or no price → throws. Nothing runs uncapped.
 */
export function capsFor(token, env = process.env, price = null) {
  const sym = token.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const perToken = {
    maxBudget: env[`MAX_BUDGET_${sym}`],
    maxPerRecipient: env[`MAX_PER_RECIPIENT_${sym}`],
    minPerRecipient: env[`MIN_PER_RECIPIENT_${sym}`],
  };
  if (perToken.maxBudget && perToken.maxPerRecipient && perToken.minPerRecipient) {
    return { ...perToken, basis: `${token.symbol} amounts set in .env` };
  }

  const usd = {
    maxBudget: env.MAX_BUDGET_USD,
    maxPerRecipient: env.MAX_PER_RECIPIENT_USD,
    minPerRecipient: env.MIN_PER_RECIPIENT_USD,
  };
  if (!usd.maxBudget || !usd.maxPerRecipient || !usd.minPerRecipient) {
    throw new Error(
      `no caps configured. Set USD limits in .env (they apply to every token):\n` +
        `  MAX_BUDGET_USD=…\n  MAX_PER_RECIPIENT_USD=…\n  MIN_PER_RECIPIENT_USD=…\n` +
        `or per-token amounts: MAX_BUDGET_${sym}=…, MAX_PER_RECIPIENT_${sym}=…, MIN_PER_RECIPIENT_${sym}=…`,
    );
  }
  if (!price?.usd) {
    throw new Error(
      `no USD price for ${token.symbol} (${token.address}), so the USD caps can't be applied. ` +
        `Set per-token caps instead: MAX_BUDGET_${sym}=…, MAX_PER_RECIPIENT_${sym}=…, MIN_PER_RECIPIENT_${sym}=…`,
    );
  }
  const conv = (v) => usdToToken(v, price.usd, token.decimals);
  return {
    maxBudget: conv(usd.maxBudget),
    maxPerRecipient: conv(usd.maxPerRecipient),
    minPerRecipient: conv(usd.minPerRecipient),
    basis:
      `$${usd.maxBudget}/$${usd.maxPerRecipient}/$${usd.minPerRecipient} at ` +
      `$${price.usd} per ${token.symbol} (${price.source})`,
  };
}
