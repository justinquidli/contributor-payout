// Payer backed by a Dynamic server wallet. Connect still resolves usernames;
// this wallet holds the agent's budget and signs each USDC transfer.
import { erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { existsSync, readFileSync } from 'node:fs';
import { dynamicClient, loadWalletMetadata, SHARES_FILE } from '../dynamic.js';
import { balanceOf, fromUnits, publicClient as basePublicClient } from '../token.js';

// A wallet-level policy rejection can hang the signing call instead of erroring,
// so every signature gets a deadline and is reported as a refusal.
const SIGN_TIMEOUT_MS = Number(process.env.SIGN_TIMEOUT_MS ?? 45_000);

// Dynamic doesn't return a policy error: a blocked signature comes back as a
// dropped MPC socket, or never returns at all. Both mean the same thing —
// the wallet would not sign, and nothing was broadcast.
const REFUSAL_PATTERNS = [/websocket/i, /connection reset/i, /closing handshake/i, /unknown error occurred while executing/i];

function asRefusal(error, what) {
  const text = `${error?.shortMessage ?? ''} ${error?.message ?? ''} ${error?.details ?? ''}`;
  if (!REFUSAL_PATTERNS.some((p) => p.test(text))) return error;
  return new Error(
    `${what}: the wallet would not sign it. This is what a Dynamic policy rejection looks like ` +
      `(check the value limit for this token). Nothing was broadcast.`,
  );
}

async function signedWithin(promise, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what}: no signature after ${SIGN_TIMEOUT_MS / 1000}s — the wallet refused it (policy limit?) or Dynamic is unreachable. Nothing was broadcast.`)),
          SIGN_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (e) {
    throw asRefusal(e, what);
  } finally {
    clearTimeout(timer);
  }
}

export async function dynamicPayer(token, env = process.env) {
  const walletMetadata = loadWalletMetadata();
  const backedUp = env.DYNAMIC_BACKUP !== 'false';
  const password = backedUp ? env.WALLET_PASSWORD : undefined;
  if (backedUp && !password) throw new Error('WALLET_PASSWORD must be set');
  // Local share if we have it; otherwise the SDK recovers it from Dynamic's backup with the password.
  const externalServerKeyShares = existsSync(SHARES_FILE) ? JSON.parse(readFileSync(SHARES_FILE, 'utf8')) : undefined;
  if (!backedUp && !externalServerKeyShares) throw new Error(`${SHARES_FILE} missing and wallet has no Dynamic backup`);
  const rpcUrl = env.BASE_RPC_URL || 'https://mainnet.base.org';

  const client = await dynamicClient(env);
  // Reads go through the resilient fallback client; the SDK's own client is
  // only used where it must be (signing/sending).
  const publicClient = basePublicClient(env);
  const address = walletMetadata.accountAddress;

  return {
    name: 'dynamic',
    token,
    address,
    describeAmount: (units) => `${fromUnits(units, token.decimals)} ${token.symbol}`,
    async describe() {
      const [held, eth] = await Promise.all([
        balanceOf(token, address, publicClient),
        publicClient.getBalance({ address }),
      ]);
      return { wallet: address, tokenUnits: held, ethWei: eth };
    },

    /** Send any ERC-20 from the agent wallet (used to fund the treasury swap). */
    async sendToken(tok, to, units) {
      const wallet = await client.getWalletClient({ walletMetadata, password, externalServerKeyShares, chain: base, rpcUrl });
      const hash = await signedWithin(
        wallet.writeContract({ address: tok.address, abi: erc20Abi, functionName: 'transfer', args: [to, units] }),
        `funding transfer of ${fromUnits(units, tok.decimals)} ${tok.symbol}`,
      );
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return hash;
    },

    /**
     * One ERC-20 transfer per recipient, sequentially, each waited to a receipt.
     * onSent(index, txHash) lets the caller record progress so a crash
     * mid-batch never re-pays someone.
     */
    async pay(payments, _idempotencyKey, { onSent } = {}) {
      const wallet = await client.getWalletClient({ walletMetadata, password, externalServerKeyShares, chain: base, rpcUrl });
      const txHashes = [];
      for (const [i, p] of payments.entries()) {
        const hash = await signedWithin(
          wallet.writeContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [p.address, p.units],
          }),
          `payment of ${fromUnits(p.units, token.decimals)} ${token.symbol} to ${p.address}`,
        );
        await onSent?.(i, hash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') throw new Error(`transfer to ${p.address} reverted (${hash})`);
        txHashes.push(hash);
      }
      return { txHashes };
    },
  };
}
