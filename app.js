(function () {
  'use strict';
  const C = window.WarpCore, config = window.WARP_CONFIG;
  const $ = id => document.getElementById(id);
  let snapshot = null, account = null, provider = null, sdk = null, inMiniApp = false;
  let hostConnection = null, hostReady = false;
  let busy = false, syncing = false, checking = false, lastError = null, credits = {winnings: 0n, refund: 0n}, lastTxHash = null;
  let store, claimStore, recoveryStore = null;
  try {
    const key = 'warp:v2:pending:' + config.chainId + ':' + (config.contract || 'preview');
    store = new C.PendingStore(window.localStorage, key);
    // A payout may be sent after a canonical press has already created a credit.
    // Keep its recovery record separate so one pending press cannot disable claim.
    claimStore = new C.PendingStore(window.localStorage, key + ':payout');
  } catch { store = null; claimStore = null; showMessage('Storage unavailable', 'This browser cannot safely recover pending transactions. Play is disabled.', 'error'); }
  const short = value => !value || C.same(value, C.ZERO) ? 'No player yet' : value.slice(0, 6) + '…' + value.slice(-4);
  const humanError = error => Number(error?.code) === 4001 ? 'You declined the wallet request. No new action was confirmed.' : String(error?.message || error).slice(0, 500);
  const pending = () => store ? store.read() : null;
  const claimPending = () => claimStore ? claimStore.read() : null;
  const storeForAction = action => action === 'claim' || action === 'refund' ? claimStore : store;
  function pendingEntry() {
    const payout = claimPending();
    if (payout) return {record: payout, store: claimStore};
    const base = pending();
    return base ? {record: base, store} : null;
  }
  async function withStoreLock(task) {
    C.ensure(navigator.locks?.request, 'This browser cannot coordinate wallet recovery. Use a browser with Web Locks support.');
    return navigator.locks.request('warp:v2:submit:' + config.contract, {ifAvailable: true}, async lock => {
      C.ensure(lock, 'Another Warp tab is updating a wallet request. Please wait.');
      return task();
    });
  }
  function showMessage(title, message, kind = '', hash = null) {
    $('transactionPanel').hidden = false;
    $('transactionPanel').className = 'status-card' + (kind ? ' ' + kind : '');
    $('transactionTitle').textContent = title; $('transactionMessage').textContent = message;
    const hasHash = C.HASH.test(hash || '');
    $('transactionLink').hidden = !hasHash;
    if (hasHash) {
      $('transactionLink').href = config.explorer + hash;
      lastTxHash = hash;
    }
    const btnShareTx = $('btnShareTx');
    if (btnShareTx) {
      btnShareTx.hidden = !hasHash;
      if (hasHash) btnShareTx.dataset.tx = hash;
    }
  }
  function showPending(record) {
    if (!record) { $('recoveryForm').hidden = true; return; }
    if (record.hash) lastTxHash = record.hash;
    if (record.version !== 2 || !record.nonce || !record.observedBlock || !record.observedBlockHash) {
      $('recoveryForm').hidden = true;
      $('noSubmission').hidden = true;
      showMessage('Earlier request needs wallet review', 'This saved request predates nonce-bound recovery. It cannot be verified or cleared automatically. Inspect your wallet history before any new action.', 'error', record.hash);
      return;
    }
    $('recoveryForm').hidden = false;
    $('noSubmission').hidden = Boolean(record.hash);
    if (record.hash) showMessage('Transaction submitted', 'Waiting for its receipt and Base safe confirmation. Keep this page open or return later; do not send it again.', '', record.hash);
    else showMessage('Wallet request needs recovery', 'A request was saved but its hash was not received. Check your wallet history and paste the hash if it was sent.');
  }
  async function digest(code) {
    const bytes = Uint8Array.from(code.slice(2).match(/../g).map(x => parseInt(x, 16)));
    const result = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(result), x => x.toString(16).padStart(2, '0')).join('');
  }
  function rpcAt(url) {
    let id = 0;
    return async (method, params) => {
      const requestId = ++id;
      let response, body;
      try {
        response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}), signal: AbortSignal.timeout(15000), credentials: 'omit', referrerPolicy: 'no-referrer'});
        if (!response.ok) throw new Error('Base RPC is unavailable (HTTP ' + response.status + ').');
        body = await response.json();
        if (body.error) throw new Error(body.error.message || 'Base RPC could not complete the request.');
      } catch (error) { throw Object.assign(new Error(humanError(error)), {code: 'RPC_UNAVAILABLE'}); }
      C.ensure(body.jsonrpc === '2.0' && body.id === requestId && !body.error && 'result' in body, body.error?.message || 'Invalid RPC response');
      return body.result;
    };
  }
  async function withRpc(task) {
    const errors = [];
    for (const url of config.rpcUrls) {
      try { return await task(rpcAt(url)); } catch (error) { errors.push(error); }
    }
    throw errors.find(error => !C.isRetryable(error)) || errors.at(-1) || new Error('No Base RPC configured.');
  }
  async function sync() {
    if (!config.enabled || syncing) return;
    syncing = true;
    try {
      const result = await withRpc(async rpc => {
        const next = await C.loadSnapshot(rpc, config, digest);
        let nextCredits = {winnings: 0n, refund: 0n};
        const creditAccount = account;
        if (creditAccount) {
          const data = C.addressWord(creditAccount);
          const [wins, refunds] = await Promise.all([
            rpc('eth_call', [{to: config.contract, data: config.abi.winnings + data}, next.block.number]),
            rpc('eth_call', [{to: config.contract, data: config.abi.refunds + data}, next.block.number]),
          ]);
          nextCredits = {winnings: BigInt('0x' + C.splitWords(wins, 1)[0]), refund: BigInt('0x' + C.splitWords(refunds, 1)[0])};
          const canonical = await rpc('eth_getBlockByNumber', [next.block.number, false]);
          C.retryable(canonical && C.same(canonical.hash, next.block.hash), 'Game block changed while checking your credits.');
        }
        return {next, nextCredits, creditAccount};
      });
      snapshot = result.next;
      credits = C.same(result.creditAccount, account) ? result.nextCredits : {winnings: 0n, refund: 0n};
      lastError = null;
      $('releaseStatus').hidden = true;
    } catch (error) {
      lastError = error;
      $('releaseStatus').hidden = false;
      $('releaseStatus').className = 'status-card error';
      $('releaseStatus').replaceChildren();
      const strong = document.createElement('strong'); strong.textContent = 'Live data unavailable · play paused';
      const description = document.createElement('p'); description.textContent = humanError(error);
      $('releaseStatus').append(strong, description);
    } finally { syncing = false; render(); }
  }
  function render() {
    let baseRecord = null, payoutRecord = null;
    try { baseRecord = pending(); payoutRecord = claimPending(); } catch (error) { lastError = error; showMessage('Recovery required', humanError(error), 'error'); }
    const fresh = snapshot && Date.now() - snapshot.loadedAt <= config.maxAgeMs && !lastError;
    const baseReady = config.enabled && fresh && store && !baseRecord && !busy;
    const payoutReady = config.enabled && fresh && claimStore && !payoutRecord && !busy;
    $('mainButton').disabled = !baseReady;
    $('btnSettle').disabled = !baseReady || !snapshot?.expired;
    $('btnClaim').disabled = !payoutReady || !account || credits.winnings <= 0n;
    $('btnRefund').disabled = !payoutReady || !account || credits.refund <= 0n;
    $('btnConnectWallet').disabled = busy;
    $('buttonText').textContent = !config.enabled ? 'PREVIEW' : busy ? 'WAIT…' : baseRecord ? 'PENDING' : !fresh ? 'PAUSED' : 'PRESS';
    $('badgeNetwork').textContent = config.enabled ? 'BASE' : 'V2 PREVIEW';
    $('badgeNetwork').classList.toggle('active', Boolean(config.enabled && fresh));
    $('walletBtnText').textContent = account ? short(account) : 'Connect Wallet';
    $('claimPanel').hidden = !config.enabled || !account;
    $('btnRefund').hidden = credits.refund <= 0n;
    $('winningsValue').textContent = fresh ? C.formatEth(credits.winnings) + ' ETH winnings' + (credits.refund ? ' · ' + C.formatEth(credits.refund) + ' ETH refund' : '') : 'Waiting for fresh credit balance';
    if (!snapshot) return;
    $('potValue').textContent = C.formatEth(snapshot.pot);
    $('roundNumber').textContent = snapshot.round.toString();
    $('kingAddress').textContent = short(snapshot.player);
    $('kingAddress').title = snapshot.player;
    $('clickCounter').textContent = snapshot.presses.toString();
    $('ticketValue').textContent = C.formatEth(snapshot.ticket) + ' ETH + gas';
    $('potNote').textContent = fresh ? 'Full prize pot is claimable by the winner' : 'Last verified value · refresh required';
    $('feedLiveStatus').textContent = fresh ? 'Verified block ' + C.quantity(snapshot.block.number).toString() : 'Stale · play paused';
    const remaining = fresh ? Math.max(0, Number(snapshot.endTime) - Number(C.quantity(snapshot.block.timestamp)) - Math.floor((Date.now() - snapshot.loadedAt) / 1000)) : null;
    $('timerDigits').textContent = remaining == null ? '--:--' : Math.floor(remaining / 60).toString().padStart(2, '0') + ':' + (remaining % 60).toString().padStart(2, '0');
    $('timerBox').classList.toggle('sudden-death', remaining != null && remaining > 0 && remaining < 60);
    $('timerStatus').textContent = !fresh ? 'WAITING FOR FRESH DATA' : snapshot.expired ? 'ROUND ENDED · SETTLEMENT AVAILABLE' : remaining === 0 ? 'CHECKING ROUND EXPIRY ON BASE' : remaining < 60 ? 'SUDDEN DEATH · EACH PRESS RESETS 60S' : 'COUNTDOWN ESTIMATE · BASE DECIDES';
    $('btnSettle').hidden = !config.enabled || !snapshot.expired;
  }
  async function detectProvider() {
    await ensureMiniApp();
    if (inMiniApp) {
      const miniProvider = await sdk.wallet.getEthereumProvider();
      C.ensure(miniProvider, 'This Farcaster host does not offer an Ethereum wallet.');
      return miniProvider;
    }
    C.ensure(window.ethereum?.request, 'No wallet found. Open Warp in Farcaster or use a browser wallet.');
    return window.ethereum;
  }
  function watchProvider(next) {
    if (provider === next) return;
    provider = next;
    provider.on?.('accountsChanged', accounts => {
      account = C.ADDRESS.test(accounts?.[0] || '') ? accounts[0] : null;
      credits = {winnings: 0n, refund: 0n};
      render(); sync();
    });
    provider.on?.('chainChanged', () => { render(); });
  }
  async function connect() {
    const next = await detectProvider();
    watchProvider(next);
    const accounts = await provider.request({method: 'eth_requestAccounts'});
    C.ensure(Array.isArray(accounts) && C.ADDRESS.test(accounts[0]), 'Wallet returned no account.');
    account = accounts[0]; render(); await sync();
    return provider;
  }
  async function act(action) {
    if (busy) return;
    busy = true; render();
    try {
      C.assertEnabled(config);
      const actionStore = storeForAction(action);
      C.ensure(actionStore, 'Persistent storage is required for safe transaction recovery.');
      C.ensure(navigator.locks?.request, 'This browser cannot coordinate pending wallet requests. Open Warp in a browser with Web Locks support.');
      await navigator.locks.request('warp:v2:submit:' + config.contract, {ifAvailable: true}, async lock => {
        C.ensure(lock, 'Another Warp tab is preparing a transaction.');
        C.ensure(!actionStore.read(), 'A previous transaction for this action is still being verified.');
        await connect();
        await sync();
        C.ensure(!lastError, humanError(lastError));
        showMessage('Review in your wallet', 'Your wallet will show the action, ticket (if any) and gas. Confirmation is checked on Base after submission.');
        const rpc = (method, params) => withRpc(r => r(method, params));
        const record = await C.submit({provider, rpc, config, snapshot, account, action, store: actionStore});
        if (record?.hash) lastTxHash = record.hash;
        showPending(record);
      });
    } catch (error) {
      showMessage('Action not confirmed', humanError(error), 'error');
      try { const record = pendingEntry()?.record; if (record?.version === 2) { $('recoveryForm').hidden = false; $('noSubmission').hidden = Boolean(record.hash); } } catch {}
    } finally { busy = false; render(); verify(); }
  }
  function addConfirmed(record) {
    if (record?.hash) lastTxHash = record.hash;
    const list = $('feedList');
    if (!list.dataset.hasActions) { list.replaceChildren(); list.dataset.hasActions = 'yes'; }
    const item = document.createElement('div'), note = document.createElement('span'), who = document.createElement('span');
    item.className = 'feed-item'; who.className = 'feed-player';
    note.textContent = ({press: 'Press confirmed', settle: 'Round settled', claim: 'Winnings claimed', refund: 'Refund claimed'})[record.action] || 'Action confirmed';
    who.textContent = short(record.account); item.append(note, who); list.prepend(item);
    while (list.children.length > 8) list.lastChild.remove();
  }
  async function verifyRecord(actionStore, record) {
    if (!record?.hash) return;
    lastTxHash = record.hash;
    const result = await withRpc(rpc => C.verifyPending(rpc, record, config));
    if (result.state === 'confirmed' || result.state === 'reverted') {
      await withStoreLock(() => actionStore.finish(record, result));
      $('recoveryForm').hidden = true;
      if (result.state === 'confirmed') {
        addConfirmed(record);
        showMessage('Confirmed on Base', ({press: 'Your press was included and verified.', settle: 'The round was settled. The winner can claim its credit.', claim: 'Your winnings were claimed.', refund: 'Your refund was claimed.'})[record.action] + ' The transaction has reached safe confirmation.', 'success', record.hash);
      } else showMessage('Transaction reverted', 'Base confirmed the transaction failed. The game action did not complete; network gas may still have been charged.', 'error', record.hash);
      await sync();
    } else if (result.state === 'confirming') {
      showMessage('Included · confirming on Base', 'The receipt is canonical. Waiting for safe confirmation before marking the action successful.', '', record.hash);
      await sync();
    } else {
      showMessage('Waiting for a receipt', 'This transaction may be pending, replaced or dropped. It will not be sent again automatically. Check your wallet; paste a replacement hash below if needed.', '', record.hash);
    }
  }
  async function verify() {
    if (!config.enabled || (!store && !claimStore) || checking || busy) return;
    checking = true;
    try {
      const entries = [];
      if (store) entries.push({store, record: store.read()});
      if (claimStore) entries.push({store: claimStore, record: claimStore.read()});
      for (const entry of entries) {
        if (!entry.record?.hash) continue;
        try { await verifyRecord(entry.store, entry.record); }
        catch (error) {
          if (C.isRetryable(error)) showMessage('Transaction submitted · checking Base', 'Base confirmation is still updating. We will check again automatically. Your transaction is saved; do not send it again.', '', entry.record.hash);
          else showMessage('Confirmation not available', humanError(error) + ' Your pending record is retained.', 'error', entry.record.hash);
        }
      }
    } catch (error) { showMessage('Recovery required', humanError(error), 'error'); }
    finally { checking = false; render(); }
  }
  $('mainButton').addEventListener('click', () => act('press'));
  $('btnSettle').addEventListener('click', () => act('settle'));
  $('btnClaim').addEventListener('click', () => act('claim'));
  $('btnRefund').addEventListener('click', () => act('refund'));
  $('btnConnectWallet').addEventListener('click', () => connect().catch(error => showMessage('Wallet unavailable', humanError(error), 'error')));
  $('btnRefresh').addEventListener('click', () => { sync(); verify(); });
  $('recoveryForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || checking) return;
    try {
      const entry = pendingEntry(), record = entry?.record, actionStore = entry?.store, hash = $('recoveryHash').value.trim();
      C.ensure(record && actionStore && C.HASH.test(hash), 'Enter a valid transaction hash from your wallet.');
      const candidate = {...record, hash, state: 'pending'};
      // Validate any available receipt before replacing the saved recovery hash.
      await withRpc(rpc => C.verifyPending(rpc, candidate, config));
      await withStoreLock(() => {
        const current = actionStore.read();
        C.ensure(current && current.createdAt === record.createdAt && current.hash === record.hash, 'Another tab updated the transaction. Refresh before recovery.');
        actionStore.write(candidate);
      });
      lastTxHash = candidate.hash;
      showPending(candidate); await verify();
    } catch (error) { showMessage('Recovery not verified', humanError(error), 'error'); }
  });
  $('noSubmission').addEventListener('click', async () => {
    if (busy || checking) return;
    try {
      await withStoreLock(() => {
        const entry = pendingEntry(), record = entry?.record, actionStore = entry?.store;
        C.ensure(actionStore && record?.version === 2 && record.nonce && record.observedBlock && record.observedBlockHash && !record.hash, 'A submitted or legacy transaction must be reviewed first.');
        actionStore.storage.setItem(actionStore.key + ':dismissed', JSON.stringify({...record, dismissedAt: Date.now(), reason: 'User checked wallet and states nothing was sent'}));
        actionStore.storage.removeItem(actionStore.key);
      });
      $('recoveryForm').hidden = true;
      showMessage('Unsubmitted request cleared', 'The saved request was cleared after your wallet-history check.'); render();
    } catch (error) { showMessage('Recovery required', humanError(error), 'error'); }
  });
  function getShareContent(customTx = null) {
    const roundNum = snapshot?.round ? snapshot.round.toString() : '2';
    const potEth = snapshot?.pot ? C.formatEth(snapshot.pot) : '0.0001';
    const activeTx = customTx || lastTxHash || pending()?.hash || claimPending()?.hash;
    let text;
    if (activeTx && C.HASH.test(activeTx)) {
      text = '🔴 I pressed The Warp Button in Round #' + roundNum + ' on Base! Pot: ' + potEth + ' ETH. Be the last press before the timer ends to win! ⏱️\n\nTx: ' + config.explorer + activeTx + '\n\n#warp #base $WARP @clanker';
    } else {
      text = '🔴 The Warp Button on Base! Round #' + roundNum + ' prize pot: ' + potEth + ' ETH. Be the last press before the round countdown ends! ⏱️\n\n#warp #base $WARP @clanker';
    }
    const shareUrl = config.publicUrl;
    return { text, shareUrl, activeTx };
  }
  async function shareCast(customTx = null) {
    const { text, shareUrl } = getShareContent(customTx);
    try {
      await ensureMiniApp();
      if (inMiniApp && sdk?.actions?.composeCast) {
        try {
          await sdk.actions.composeCast({ text, embeds: [shareUrl], channelKey: 'base' });
          return;
        } catch (composeErr) {
          if (composeErr?.name === 'AbortError' || composeErr?.message?.includes('rejected')) return;
        }
      }
      if (typeof navigator.share === 'function') {
        await navigator.share({title: 'The Warp Button', text, url: shareUrl});
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text + '\n\n' + shareUrl);
        showMessage('Ready to share', 'The cast text and Warp link were copied. Open Farcaster and paste them.', 'success');
        return;
      }
      showMessage('Share unavailable', 'Use your device share menu to send the Warp link to Farcaster.', 'error');
    } catch (error) {
      if (error?.name !== 'AbortError') showMessage('Share unavailable', humanError(error), 'error');
    }
  }
  $('btnShareCast').addEventListener('click', () => shareCast());
  const btnShareTx = $('btnShareTx');
  if (btnShareTx) {
    btnShareTx.addEventListener('click', () => shareCast(btnShareTx.dataset.tx || lastTxHash));
  }
  let priorFocus;
  const closeRules = () => { $('rulesModal').style.display = 'none'; priorFocus?.focus(); };
  $('btnRules').addEventListener('click', () => { priorFocus = document.activeElement; $('rulesModal').style.display = 'flex'; $('btnCloseRules').focus(); });
  $('btnCloseRules').addEventListener('click', closeRules);
  $('rulesModal').addEventListener('click', event => { if (event.target === $('rulesModal')) closeRules(); });
  $('rulesModal').addEventListener('keydown', event => { if (event.key === 'Escape') closeRules(); if (event.key === 'Tab') { event.preventDefault(); $('btnCloseRules').focus(); } });
  window.addEventListener('storage', event => { if (store && (event.key === store.key || claimStore && event.key === claimStore.key)) { try { showPending(pendingEntry()?.record); render(); verify(); } catch (error) { showMessage('Recovery required', humanError(error), 'error'); } } });
  async function ensureMiniApp() {
    if (inMiniApp && hostReady) return true;
    sdk = window.miniapp?.sdk;
    if (!sdk) return false;
    if (hostConnection) return hostConnection;
    hostConnection = (async () => {
      // The bridge may become available after initial page load.
      inMiniApp = await sdk.isInMiniApp(2000);
      if (inMiniApp && !hostReady) { await sdk.actions.ready(); hostReady = true; }
      await window.WarpHost?.init({sdk, inMiniApp, publicUrl: config.publicUrl, launchUrl: config.farcasterUrl});
      return inMiniApp;
    })();
    try { return await hostConnection; } finally { hostConnection = null; }
  }
  async function init() {
    render();
    try {
      const initial = pendingEntry()?.record;
      if (initial?.hash) lastTxHash = initial.hash;
      showPending(initial);
    } catch (error) { showMessage('Recovery required', humanError(error), 'error'); }
    sdk = window.miniapp?.sdk;
    if (sdk) {
      try {
        await ensureMiniApp();
      } catch (error) { showMessage('Farcaster connection pending', 'The app connection will be checked again when you connect or share.'); }
    } else if (window.parent !== window || window.ReactNativeWebView) showMessage('Farcaster SDK unavailable', 'Reload the mini app. Wallet actions will remain unavailable until the host connects.', 'error');
    await sync(); await verify();
    setInterval(() => { if (!document.hidden) { sync(); verify(); } }, 10000);
    setInterval(render, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); verify(); ensureMiniApp().catch(() => {}); } });
  }
  init().catch(error => showMessage('Initialization failed', humanError(error), 'error'));
})();
