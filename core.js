(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WarpCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
  const ZERO = '0x' + '0'.repeat(40);
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const ensure = (ok, message) => { if (!ok) throw new Error(message); };
  // RPC nodes can briefly disagree while Base seals a preconfirmed block.
  // Keep verification strict, but distinguish a retry from an invalid action.
  const retryable = (ok, message) => { if (!ok) throw Object.assign(new Error(message), {code: 'RPC_UNSETTLED'}); };
  const isRetryable = error => error?.code === 'RPC_UNSETTLED' || error?.code === 'RPC_UNAVAILABLE';
  const quantity = value => { ensure(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), 'Invalid RPC quantity'); return BigInt(value); };
  const toHex = value => '0x' + BigInt(value).toString(16);
  const word = value => BigInt(value).toString(16).padStart(64, '0');
  const addressWord = value => { ensure(ADDRESS.test(value), 'Invalid address'); return value.slice(2).toLowerCase().padStart(64, '0'); };
  function splitWords(hex, count) {
    ensure(typeof hex === 'string' && new RegExp('^0x[0-9a-f]{' + (count * 64) + '}$', 'i').test(hex), 'Malformed contract response');
    return Array.from({length: count}, (_, i) => hex.slice(2 + i * 64, 66 + i * 64));
  }
  function decodeState(hex) {
    const w = splitWords(hex, 13), n = w.map(x => BigInt('0x' + x));
    ensure(n[0] > 0n && n[3] > 0n && n[7] <= 1n && /^0{24}/.test(w[5]), 'Invalid game state');
    return {round: n[0], pot: n[1], seed: n[2], ticket: n[3], endTime: n[4], player: '0x' + w[5].slice(24), presses: n[6], expired: n[7] === 1n, remaining: n[8]};
  }
  function formatEth(wei) {
    const n = BigInt(wei); ensure(n >= 0n, 'Negative balance');
    const decimals = (n % 1000000000000000000n).toString().padStart(18, '0').replace(/0+$/, '');
    return (n / 1000000000000000000n).toString() + (decimals ? '.' + decimals : '');
  }
  function assertEnabled(config) {
    ensure(config.enabled === true && config.release === 'V2' && ADDRESS.test(config.contract) && !same(config.contract, ZERO), 'Preview only — transactions are not enabled.');
    ensure(config.chainId === '0x2105' && /^[0-9a-f]{64}$/i.test(config.runtimeSha256 || ''), 'Verified V2 deployment is not configured.');
  }
  function assertFreshBlock(block, now = Date.now(), maxAge = 90000) {
    retryable(block && HASH.test(block.hash), 'Missing canonical block');
    const age = now - Number(quantity(block.timestamp)) * 1000;
    retryable(age >= -30000 && age <= maxAge, 'RPC data is stale. Play is paused until fresh data returns.');
    quantity(block.number);
  }
  async function ensureBase(provider) {
    ensure(provider && typeof provider.request === 'function', 'No wallet is available. Open in Farcaster or connect a browser wallet.');
    let chain = await provider.request({method: 'eth_chainId'});
    if (quantity(chain) !== 8453n) {
      // Any rejected or unsupported switch aborts. Never send on the old chain.
      await provider.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x2105'}]});
      chain = await provider.request({method: 'eth_chainId'});
    }
    ensure(quantity(chain) === 8453n, 'Wallet did not switch to Base. No transaction was sent.');
  }
  async function loadSnapshot(rpc, config, digest, now = Date.now()) {
    assertEnabled(config);
    ensure(quantity(await rpc('eth_chainId', [])) === 8453n, 'RPC is not Base');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    assertFreshBlock(block, now, config.maxAgeMs);
    const [code, data] = await Promise.all([
      rpc('eth_getCode', [config.contract, block.number]),
      rpc('eth_call', [{to: config.contract, data: config.abi.state}, block.number]),
    ]);
    ensure(typeof code === 'string' && /^0x[0-9a-f]+$/i.test(code) && code.length > 2 && code.length % 2 === 0, 'Game contract is missing');
    ensure(await digest(code) === config.runtimeSha256, 'Game contract does not match the verified V2 release');
    const state = decodeState(data);
    const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
    retryable(canonical && same(canonical.hash, block.hash), 'Block changed during read. Waiting for canonical state.');
    return {...state, block, loadedAt: now};
  }
  function validateReceiptIdentity(receipt, pending, config) {
    ensure(pending.version === 2 && typeof pending.nonce === 'string' && typeof pending.observedBlock === 'string' && HASH.test(pending.observedBlockHash || ''), 'Saved request lacks nonce and block binding. Keep it pending and inspect wallet history.');
    quantity(pending.nonce);
    ensure(receipt && HASH.test(receipt.transactionHash) && same(receipt.transactionHash, pending.hash), 'Receipt is for a different transaction');
    ensure(same(receipt.to, config.contract) && same(receipt.from, pending.account), 'Receipt account or game does not match');
    if (receipt.blockNumber != null) ensure(quantity(receipt.blockNumber) > quantity(pending.observedBlock), 'Receipt predates this wallet request. An earlier game action cannot clear it.');
  }
  function validateTransactionIdentity(tx, pending, config) {
    retryable(tx, 'Transaction details are not available yet.');
    ensure(same(tx.hash, pending.hash) && same(tx.from, pending.account) && same(tx.to, config.contract), 'Transaction is not bound to this receipt');
    ensure(same(tx.input, pending.data) && quantity(tx.value) === BigInt(pending.value), 'Transaction call does not match the requested action');
    ensure(quantity(tx.nonce) === quantity(pending.nonce), 'Transaction nonce does not match this wallet request');
    if (tx.chainId != null) ensure(quantity(tx.chainId) === 8453n, 'Transaction is not on Base');
  }
  function validateReceipt(receipt, tx, block, pending, config) {
    validateReceiptIdentity(receipt, pending, config);
    validateTransactionIdentity(tx, pending, config);
    retryable(block && same(block.hash, receipt.blockHash) && quantity(block.number) === quantity(receipt.blockNumber), 'Receipt block is no longer canonical');
    retryable(same(tx.blockHash, receipt.blockHash) && tx.blockNumber != null && quantity(tx.blockNumber) === quantity(receipt.blockNumber), 'Transaction block is not yet bound to this receipt');
    const status = quantity(receipt.status);
    ensure(status === 0n || status === 1n, 'Invalid receipt status');
    if (status === 0n) return {state: 'reverted'};
    const matches = (receipt.logs || []).filter(log => {
      if (log.removed || !same(log.address, config.contract) || !same(log.transactionHash, pending.hash) || !same(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber) return false;
      if (!Array.isArray(log.topics) || !same(log.topics[0], config.abi.events[pending.action])) return false;
      if (pending.action === 'press') {
        if (log.topics.length !== 3 || !same(log.topics[2], '0x' + addressWord(pending.account)) || !HASH.test(log.topics[1])) return false;
        try { const w = splitWords(log.data, 3); return quantity(log.topics[1]) >= BigInt(pending.round) && BigInt('0x' + w[2]) > 0n; } catch { return false; }
      }
      if (pending.action === 'settle') {
        try { splitWords(log.data, 2); return log.topics.length === 3 && quantity(log.topics[1]) >= BigInt(pending.round); } catch { return false; }
      }
      // Claim events are fully bound below using their release ABI layout.
      if (pending.action === 'claim' || pending.action === 'refund') {
        try { const w = splitWords(log.data, 1); return log.topics.length === 3 && same(log.topics[1], '0x' + addressWord(pending.account)) && same(log.topics[2], '0x' + addressWord(pending.account)) && BigInt('0x' + w[0]) > 0n; } catch { return false; }
      }
      return false;
    });
    ensure(matches.length === 1, 'Successful receipt is missing the expected game event. Verification is incomplete.');
    return {state: 'included', event: matches[0]};
  }
  async function verifyPending(rpc, pending, config, now = Date.now()) {
    assertEnabled(config);
    ensure(pending && same(pending.contract, config.contract) && pending.chainId === config.chainId && ADDRESS.test(pending.account) && HASH.test(pending.hash), 'Pending transaction does not belong to this game');
    ensure(pending.version === 2 && typeof pending.nonce === 'string' && typeof pending.observedBlock === 'string' && HASH.test(pending.observedBlockHash || ''), 'Saved request lacks nonce and block binding. Keep it pending and inspect wallet history.');
    quantity(pending.nonce); quantity(pending.observedBlock);
    ensure(quantity(await rpc('eth_chainId', [])) === 8453n, 'Receipt RPC is not Base');
    const receipt = await rpc('eth_getTransactionReceipt', [pending.hash]);
    if (!receipt) return {state: 'pending'};
    validateReceiptIdentity(receipt, pending, config);
    retryable(receipt.blockNumber != null, 'Receipt is waiting for its Base block.');
    const [tx, block, latest] = await Promise.all([
      rpc('eth_getTransactionByHash', [pending.hash]), rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getBlockByNumber', ['latest', false]),
    ]);
    validateTransactionIdentity(tx, pending, config);
    assertFreshBlock(latest, now, config.maxAgeMs);
    retryable(quantity(receipt.blockNumber) <= quantity(latest.number), 'Receipt is ahead of the latest verified block. Confirmation is incomplete.');
    const result = validateReceipt(receipt, tx, block, pending, config);
    const safe = await rpc('eth_getBlockByNumber', ['safe', false]);
    retryable(safe && HASH.test(safe.hash), 'Safe finality is unavailable; the transaction is still being verified.');
    retryable(quantity(safe.number) <= quantity(latest.number), 'Safe block is ahead of the latest verified block. Confirmation is incomplete.');
    if (quantity(safe.number) < quantity(receipt.blockNumber)) return {...result, state: 'confirming', outcome: result.state};
    const [again, safeAgain] = await Promise.all([
      rpc('eth_getBlockByNumber', [receipt.blockNumber, false]), rpc('eth_getBlockByNumber', [safe.number, false]),
    ]);
    retryable(again && same(again.hash, receipt.blockHash) && safeAgain && same(safeAgain.hash, safe.hash), 'Chain changed while checking finality. Waiting for a canonical receipt.');
    return {...result, state: result.state === 'reverted' ? 'reverted' : 'confirmed', receipt, finality: 'safe'};
  }
  class PendingStore {
    constructor(storage, key) { this.storage = storage; this.key = key; }
    read() {
      const raw = this.storage.getItem(this.key);
      if (!raw) return null;
      try { const record = JSON.parse(raw); ensure(record && typeof record === 'object' && (record.version === 1 || record.version === 2), 'Invalid record'); return record; }
      catch { throw new Error('Saved transaction record is damaged. Check your wallet history before continuing.'); }
    }
    write(record) {
      const text = JSON.stringify(record);
      this.storage.setItem(this.key, text);
      ensure(this.storage.getItem(this.key) === text, 'This browser cannot save pending transactions. No safe recovery is available.');
    }
    finish(record, result) {
      const current = this.read();
      ensure(current && current.hash === record.hash && current.createdAt === record.createdAt, 'Pending transaction changed in another tab; refresh its status.');
      this.storage.setItem(this.key + ':last', JSON.stringify({...record, outcome: result.state, finality: result.finality, completedAt: Date.now()}));
      this.storage.removeItem(this.key);
    }
  }
  async function submit({provider, rpc, config, snapshot, account, action = 'press', store, now = Date.now()}) {
    assertEnabled(config);
    ensure(!store.read(), 'A previous transaction still needs verification.');
    ensure(snapshot && now >= snapshot.loadedAt && now - snapshot.loadedAt <= config.maxAgeMs, 'Refresh the game before sending.');
    ensure(ADDRESS.test(account), 'Connect a wallet first.');
    await ensureBase(provider);
    const accounts = await provider.request({method: 'eth_accounts'});
    ensure(Array.isArray(accounts) && same(accounts[0], account), 'Wallet account changed. Reconnect before sending.');
    ensure(snapshot.block && HASH.test(snapshot.block.hash || ''), 'Verified submission block is missing. Refresh before sending.');
    quantity(snapshot.block.number);
    let rawNonce = null;
    if (typeof rpc === 'function') {
      try { rawNonce = await rpc('eth_getTransactionCount', [account, 'pending']); } catch {}
    }
    if (rawNonce == null && provider && typeof provider.request === 'function') {
      try {
        rawNonce = await provider.request({method: 'eth_getTransactionCount', params: [account, 'pending']});
      } catch (err) {
        if (!rpc) throw err;
      }
    }
    const nonce = toHex(quantity(rawNonce));
    let data, value = '0';
    if (action === 'press') { data = config.abi.press; value = snapshot.ticket.toString(); }
    else if (action === 'settle') { ensure(snapshot.expired, 'The round is still active.'); data = config.abi.settle; }
    else if (action === 'claim' || action === 'refund') { data = config.abi[action] + addressWord(account); }
    else throw new Error('Unknown game action');
    ensure(!store.read(), 'Another wallet request was saved while connecting.');
    ensure(Date.now() >= snapshot.loadedAt && Date.now() - snapshot.loadedAt <= config.maxAgeMs, 'Game data expired while connecting. Refresh before sending.');
    const record = {version: 2, chainId: config.chainId, contract: config.contract, account, action, round: snapshot.round.toString(), nonce, observedBlock: snapshot.block.number, observedBlockHash: snapshot.block.hash, value, data, createdAt: now, state: 'awaiting_wallet'};
    // Persist before wallet submission. A lost response is not permission to retry.
    store.write(record);
    try {
      const hash = await provider.request({method: 'eth_sendTransaction', params: [{from: account, to: config.contract, chainId: config.chainId, nonce, value: toHex(value), data}]});
      ensure(HASH.test(hash), 'Wallet returned no transaction hash. Check its history before retrying.');
      const submitted = {...record, hash, state: 'pending'};
      store.write(submitted);
      return submitted;
    } catch (error) {
      if (Number(error.code) === 4001) store.storage.removeItem(store.key);
      // Other errors can occur after broadcasting. Keep the intent until recovered.
      throw error;
    }
  }
  return {ADDRESS, HASH, ZERO, same, ensure, retryable, isRetryable, quantity, toHex, word, addressWord, splitWords, decodeState, formatEth, assertEnabled, assertFreshBlock, ensureBase, loadSnapshot, validateReceipt, verifyPending, PendingStore, submit};
});
