const RPC_URL = "https://api.mainnet-beta.solana.com";
const MINT_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const validAddress = value => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const failure = (message, status = 422) => Object.assign(new Error(message), { code: "PRACTICE_SOLANA_EVIDENCE", status });
const integerAmount = value => typeof value === "string" && /^\d{1,30}$/.test(value) ? BigInt(value) : null;

/** Read-only, fixed-method public Solana RPC. No keys or signing are accepted. */
export function createSolanaEvidenceClient({ fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 10000 } = {}) {
  async function rpc(method, params) {
    try {
      const response = await fetchImpl(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "synergy-practice-read", method, params }), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw failure("Public Solana evidence is unavailable. Wait before retrying.", 503);
      const reader = response.body?.getReader(); if (!reader) throw failure("Public Solana evidence has no response body.", 502);
      let size = 0; const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1000000) { await reader.cancel(); throw failure("Public Solana evidence exceeded the response limit.", 502); } chunks.push(Buffer.from(value)); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data.error || !data.result) throw failure("The public Solana node could not provide the requested evidence.", 503);
      return data.result;
    } catch (error) { if (error.code === "PRACTICE_SOLANA_EVIDENCE") throw error; throw failure("The public Solana node could not be reached.", 503); }
  }
  return {
    async inspect({ address } = {}) {
      if (!validAddress(address)) throw failure("Enter a valid Solana token mint address.");
      const mint = await rpc("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "finalized" }]);
      const parsed = mint.value?.data?.parsed, info = parsed?.info;
      if (!MINT_PROGRAMS.has(mint.value?.owner) || parsed?.type !== "mint" || !info || !Object.hasOwn(info, "mintAuthority") || !Object.hasOwn(info, "freezeAuthority") || !Number.isInteger(info.decimals)) throw failure("The account is not a supported parsed Solana token mint.", 422);
      const supply = integerAmount(info.supply); if (supply === null || supply <= 0n) throw failure("The token supply could not be verified.", 502);
      const largest = await rpc("getTokenLargestAccounts", [address, { commitment: "finalized" }]);
      if (!Array.isArray(largest.value) || largest.value.length > 20) throw failure("The token holder response could not be verified.", 502);
      const accounts = largest.value.filter(row => validAddress(row.address) && integerAmount(row.amount) !== null);
      const holders = accounts.length ? await rpc("getMultipleAccounts", [accounts.map(row => row.address), { encoding: "jsonParsed", commitment: "finalized" }]) : { value: [] };
      if (!Array.isArray(holders.value) || holders.value.length !== accounts.length) throw failure("Holder account ownership could not be verified.", 502);
      const byOwner = new Map(); let sampled = 0n;
      for (let index = 0; index < accounts.length; index++) {
        const accountInfo = holders.value[index]?.data?.parsed?.info, amount = integerAmount(accounts[index].amount);
        if (!accountInfo || accountInfo.mint !== address || !validAddress(accountInfo.owner)) continue;
        byOwner.set(accountInfo.owner, (byOwner.get(accountInfo.owner) ?? 0n) + amount); sampled += amount;
      }
      const pct = amount => Number(amount * 1000000n / supply) / 10000;
      const top = [...byOwner.entries()].sort((a, b) => a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0);
      const checkedAt = now().toISOString();
      return { address, checkedAt, source: RPC_URL, security: {
        mintAuthorityRevoked: info.mintAuthority === null, freezeAuthorityRevoked: info.freezeAuthority === null,
        topHolderPercent: top.length ? pct(top[0][1]) : null, holderCoveragePercent: pct(sampled), concentrationIsLowerBound: sampled < supply,
        serialDeployer: null, checkedAt, tokenExtensionsPresent: Array.isArray(info.extensions) && info.extensions.length > 0,
      }, holders: top.map(([owner, amount]) => ({ owner, percent: pct(amount) })),
      slots: { mint: mint.context?.slot ?? null, holders: largest.context?.slot ?? null },
      caveats: ["Holder concentration groups the 20 largest token accounts by owner and may miss split wallets or pool ownership.",
        "Creator history, serial deployment, launch bundling and Token-2022 extension behavior are not inferred from authority checks. Missing required checks continue to block the scalp strategy."] };
    },
  };
}
