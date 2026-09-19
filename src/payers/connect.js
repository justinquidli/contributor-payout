// Payer backed by the Connect Smart Send wallet (Privy).
import { randomUUID } from 'node:crypto';
import { fromUnits } from '../token.js';

export function connectPayer(connect, token) {
  return {
    name: 'connect',
    token,
    async describe() {
      const b = await connect.balances(token);
      return { wallet: b.wallet, tokenUnits: b.tokenUnits, ethWei: b.ethWei };
    },
    /** payments: [{ address, units }] → { txHashes, raw } */
    async pay(payments, idempotencyKey) {
      const { data, txHashes } = await connect.drop(token, payments, idempotencyKey);
      return { txHashes, raw: data };
    },
    /** Send any ERC-20 from the Smart Send wallet (used to fund the treasury swap). */
    async sendToken(tok, to, units) {
      const { txHashes } = await connect.drop(tok, [{ address: to, units }], randomUUID());
      return txHashes[0];
    },
    describeAmount: (units) => `${fromUnits(units, token.decimals)} ${token.symbol}`,
  };
}
