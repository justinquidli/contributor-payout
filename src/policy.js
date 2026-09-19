// Dynamic WaaS policies: the same caps, enforced by the wallet instead of by us.
// A rule is an allow rule on a token contract with a per-transaction value limit;
// anything over the limit is refused before signing, whatever the code asks for.
const API = 'https://app.dynamicauth.com/api/v0';

export class Policies {
  constructor({ environmentId, authToken, baseUrl = API } = {}) {
    if (!environmentId || !authToken) throw new Error('DYNAMIC_ENVIRONMENT_ID and DYNAMIC_AUTH_TOKEN must be set');
    this.environmentId = environmentId;
    this.authToken = authToken;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(method, body) {
    const url = `${this.baseUrl}/environments/${this.environmentId}/waas/policies`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.authToken}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = Array.isArray(data.message) ? data.message.join('; ') : data.message ?? data.error ?? 'error';
      throw new Error(`Dynamic policies ${method} → ${res.status}: ${msg}`);
    }
    return data;
  }

  list() {
    return this.request('GET');
  }

  add(rules) {
    return this.request('POST', { rulesToAdd: rules });
  }

  update(rules) {
    return this.request('PUT', { rulesToUpdate: rules });
  }

  remove(ids) {
    return this.request('DELETE', { ruleIdsToDelete: ids });
  }
}

/** One rule per token: allow that contract, up to `maxUnits` per transaction. */
export function ruleFor(token, maxUnits, chainId = 8453) {
  return {
    name: `contributor-payout: ${token.symbol} ≤ ${maxUnits} per transaction`,
    ruleType: 'allow',
    chain: 'EVM',
    chainIds: [chainId],
    addresses: [token.address],
    // asset MUST be the token address: a blank asset means the NATIVE token,
    // so an ERC-20 transfer (native value 0) would never trip the limit.
    valueLimit: { asset: token.address, maxPerCall: String(maxUnits) },
  };
}

export function findRule(existing, token) {
  const rules = existing?.rules ?? existing?.policies ?? existing ?? [];
  return (Array.isArray(rules) ? rules : []).find(
    (r) => (r.addresses ?? []).some((a) => a.toLowerCase() === token.address.toLowerCase()) && /contributor-payout/.test(r.name ?? ''),
  );
}
