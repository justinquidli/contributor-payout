# contributor-payout

An agent that autonomously pays your project's repo contributors. It reads a repo's merged PRs, decides how to split a budget denominated in **any ERC-20 on Base**, acquires that token through [Bankr](https://bankr.bot) if its wallet is short, resolves each author's **GitHub username** to a wallet with [Quidli Connect](https://connect.quid.li) (creating one if they don't have it), and pays from a [Dynamic](https://dynamic.xyz) server wallet.

Built for Runtime NYC, Dynamic track

**[Watch the demo](https://www.youtube.com/watch?v=5hWjSsyLz6Y)** — proposal, injection test, real BNKR payout, Basescan proof, wallet-policy refusal, all in one take.

## Flow

```
GitHub merged PRs ──► agent proposes split ──► rails (code) ──► Connect lookup ──► short of the token? ──► pay ──► PR comment
                        (LLM; PR text is         accept or        github → 0x…        Bankr: fund, swap,     (Dynamic
                         untrusted data)         reject whole                          return, then verify    or Connect
                                                 plan                                  the balance landed     wallet)
```

The reward token is named on the command line and never chosen by the model:

```bash
npm run payout -- --repo owner/name --token BNKR --budget 1000 --payer dynamic
npm run payout -- --repo owner/name --token 0xb9a1…ba3 --budget 500 --fund-with USDC
```

## Setup

```bash
npm install              # Dynamic SDK + viem (only used by --payer dynamic)
cp .env.example .env     # fill GITHUB_TOKEN (gh auth token), CONNECT_API_KEY, LLM_*; BANKR_API_KEY to buy the reward token when short
npm test
```

Node ≥ 20.6.

## Use

```bash
# Dry run (default): shows PRs, agent's split, rail check, resolved wallets, payer balance
npm run payout -- --repo Quidli/connect-mcp --since 7d --budget 3 --exclude justinquidli

# Send (asks you to type "send"), then comment the tx on each PR
npm run payout -- --repo Quidli/connect-mcp --since 7d --budget 3 --exclude justinquidli --execute --comment

# Skip the LLM and use a hand-written plan (testing / demo rehearsal)
npm run payout -- --repo ... --budget 3 --plan-file plan.json
```

## Treasury (Bankr)

When the agent's wallet holds less of the reward token than the approved plan needs, it acquires the difference itself: it sends the funding token to the Bankr wallet, swaps there (quote → execute, with an idempotency key), sends the proceeds back, and then **waits for its own balance to actually rise** before paying anyone. A swap that reports success but never lands is treated as a failure, and no one is paid.

`npm run treasury:acquire -- BNKR 1000` runs that leg on its own.

## Rails (enforced in code, not by the prompt)

The model only proposes. A plan is rejected **as a whole** if any of these fail:

- recipient must be the author of an unpaid merged PR in the window (injected names can't be paid)
- caps are set once in USD (`MAX_BUDGET_USD`, `MAX_PER_RECIPIENT_USD`, `MIN_PER_RECIPIENT_USD`) and converted to token units at the token's run-time price, so "never spend more than $100" holds whether you pay in USDC or in a token worth $0.0002. A per-token override (`MAX_BUDGET_<SYM>`, …) wins when set
- no caps, or no price for the token → the run stops; nothing runs uncapped
- total ≤ `--budget` ≤ the budget cap
- the reward token comes from `--token`, so no PR text can switch the payout to another token
- a symbol matching several contracts on Base errors with the candidates instead of guessing
- no duplicates, no `--exclude`d users, bots skipped
- payer must hold ETH for gas and enough of the reward token; if it is short and `BANKR_API_KEY` is set, it buys the difference through Bankr first (see Treasury), otherwise the run stops

`ledger.json` records every run: PRs are never paid twice, and a send that fails or times out stays **pending** and blocks further runs until you check Basescan and pass `--clear-pending`. Amounts are handled as integer units (no floats).

## Payers

Connect always resolves usernames. Who holds and signs the money is `--payer`:

- `connect` (default): Connect Smart Send wallet (Privy), one batched `/drop` with an idempotency key.
- `dynamic`: the agent's own Dynamic server wallet (TWO_OF_TWO MPC). One ERC-20 `transfer` per recipient, each tx hash written to the ledger as soon as it's broadcast, so a crash mid-batch never re-pays anyone.

### Dynamic setup (once)

1. In `.env`: `DYNAMIC_ENVIRONMENT_ID`, `DYNAMIC_AUTH_TOKEN` (server API token), `WALLET_PASSWORD` (16+ chars).
2. `npm run dynamic:setup` creates the wallet and writes:
   - `dynamic-wallet.json`: wallet metadata. **Back it up**; Dynamic can't restore the part needed to sign.
   - `dynamic-shares.json`: your secret key share (chmod 600).
3. Fund the printed address on Base with USDC plus a little ETH for gas.
4. `npm run payout -- --payer dynamic --repo … --budget …`

### Wallet policy (Dynamic)

The caps above are also pushed to the Dynamic wallet, so the wallet itself refuses an over-cap payment before signing, even if the code had a bug.

```bash
npm run policy:sync -- USDC BNKR   # per-transaction limit = MAX_PER_RECIPIENT_<SYM>, else MAX_PER_RECIPIENT_USD at today's price
npm run policy:list                # show the rules Dynamic enforces

# Prove the wallet signs and sends (default 0.05 USDC)
npm run dynamic:selftest -- 0xRecipient [amount] [TOKEN]
# Show the policy refusing an over-cap send: --force skips our own checks so the wallet decides
npm run dynamic:selftest -- 0xRecipient 2000 BNKR --force
```

## Rounds

Every run writes `rounds/<label>.json` (`--round <label>`, otherwise repo + date): each
contributor, their PRs, the agent's reason, the amount, and **their share of the round in
basis points**. A dry run records it as `proposed`, an executed run as `paid` with tx hashes.

The share column is the point. A round is a distribution — today it splits a reward budget,
and the same table is what a token allocation needs.

## Where this goes

The hard part of paying contributors isn't the payment, it's deciding who earned what and
knowing they're real people. That's the scoring plus the identity layer; the payout is one
step past it, and ownership is another.

A project that launches its own token can reuse the same rounds: work points from merged PRs
scored as they are here, capital points for people who back the project without writing code,
and the split between those buckets set by whoever starts the project — along with whether
rewards vest. Connect's reputation scores and identity links are what keep that from being
farmed by sockpuppets: dedupe by resolved wallet rather than GitHub login, weight new accounts
down, and publish each round before it pays so it can be challenged.

Not built. The rounds recorded today are the input it would need.

## How recipients access what they're paid

A payout goes to the recipient's own wallet the moment it's resolved by Connect — nothing sits in an
intermediate custodial balance the agent holds on their behalf. A contributor who doesn't yet have a
wallet gets one provisioned automatically on lookup, tied to their GitHub identity.

To see and manage those funds, a recipient signs in to **[dapp.quid.li](https://dapp.quid.li)** by
authenticating with the same GitHub account their PRs were merged under. That login is what proves
"this wallet is mine" — no separate signup, no address to copy out of a Discord message, no private
key to receive. Whoever merged the PR is whoever can log in and see the payout.

## Known limits

- The PR list is capped at 50 per run.
- `--comment` needs a token with write access to the repo.
- The tx hash is pulled from Connect's `/drop` response by pattern; check the first live run's output.
- Rounds are per-run snapshots; there's no challenge window or amendment flow yet.
- Swap sizing prices with a probe quote and adds `SWAP_BUFFER`; leftovers stay in the agent wallet for the next run.
