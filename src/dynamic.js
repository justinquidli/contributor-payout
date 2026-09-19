// Dynamic server wallet helpers (Node SDK, TWO_OF_TWO MPC, backed up to Dynamic).
import { readFileSync, existsSync } from 'node:fs';

export const WALLET_FILE = 'dynamic-wallet.json'; // walletMetadata: not secret, but required to sign
export const SHARES_FILE = 'dynamic-shares.json'; // your MPC key share: SECRET

export async function dynamicClient(env = process.env) {
  if (!env.DYNAMIC_ENVIRONMENT_ID || !env.DYNAMIC_AUTH_TOKEN) {
    throw new Error('DYNAMIC_ENVIRONMENT_ID and DYNAMIC_AUTH_TOKEN must be set');
  }
  const { DynamicEvmWalletClient } = await import('@dynamic-labs-wallet/node-evm');
  const client = new DynamicEvmWalletClient({
    environmentId: env.DYNAMIC_ENVIRONMENT_ID,
    enableMPCAccelerator: false, // true only on AWS Nitro Enclave hosts; crashes on a laptop
  });
  await client.authenticateApiToken(env.DYNAMIC_AUTH_TOKEN);
  return client;
}

export function loadWalletMetadata(path = WALLET_FILE) {
  if (!existsSync(path)) throw new Error(`${path} not found — run: npm run dynamic:setup`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
