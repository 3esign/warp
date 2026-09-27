(function () {
  'use strict';
  // Keep the game as the primary action. A quiet, keyboard-accessible strip
  // explains where saving works; it never treats catalogue indexing as saving.
  const $ = id => document.getElementById(id);
  let sdk = null, inMiniApp = false, added = false, adding = false;
  let publicUrl = '', launchUrl = '', mounted = false, generation = 0;
  let contextRead = false, addedRevision = 0;
  let message = '', messageKind = '', subscriptions = [];
  function render() {
    if (!$('hostPanel')) return;
    $('hostPanel').hidden = false;
    $('hostPanel').className = 'status-card host-panel' + (messageKind ? ' ' + messageKind : '');
    $('hostTitle').textContent = added ? 'Warp is in Your Apps' : inMiniApp ? 'Keep Warp in Your Apps' : 'Save Warp in Farcaster';
    $('hostMessage').textContent = message || (added ? 'Open it again from Your Apps in this Farcaster client.' : inMiniApp ? 'Save it once so you can return from Your Apps.' : launchUrl ? 'Open the mini app, then tap Save Warp to keep it in Your Apps.' : 'Open the Open Warp card in a Farcaster cast, then tap Save Warp. A website link alone does not save the app.');
    $('btnSaveWarp').hidden = !inMiniApp;
    $('btnSaveWarp').disabled = added || adding || typeof sdk?.actions?.addMiniApp !== 'function';
    $('btnSaveWarp').textContent = adding ? 'Saving...' : added ? 'Saved' : 'Save Warp';
    $('hostLaunchLink').hidden = inMiniApp || !launchUrl;
    if (launchUrl) $('hostLaunchLink').href = launchUrl;
    $('btnCopyWarpLink').hidden = inMiniApp;
  }
  function markAdded(value) {
    added = value; addedRevision++; message = ''; messageKind = ''; render();
  }
  function setSdk(next) {
    if (sdk === next) return;
    for (const [event, handler] of subscriptions) sdk?.removeListener?.(event, handler);
    subscriptions = [];
    sdk = next; added = false; contextRead = false; addedRevision = 0;
    if (!sdk?.on) return;
    // 0.3.0 uses miniAppAdded; later client docs use miniappAdded.
    for (const event of ['miniAppAdded', 'miniappAdded']) {
      const handler = () => markAdded(true);
      sdk.on(event, handler); subscriptions.push([event, handler]);
    }
    for (const event of ['miniAppRemoved', 'miniappRemoved']) {
      const handler = () => markAdded(false);
      sdk.on(event, handler); subscriptions.push([event, handler]);
    }
  }
  async function save() {
    if (!inMiniApp || added || adding || !sdk?.actions?.addMiniApp) return;
    adding = true; message = ''; messageKind = ''; render();
    try {
      const result = await sdk.actions.addMiniApp();
      if (result?.error) throw result.error;
      markAdded(true);
    } catch (error) {
      const detail = String(error?.name || '') + ' ' + String(error?.message || '') + ' ' + String(error?.type || '');
      if (/reject|cancel|declin/i.test(detail) || Number(error?.code) === 4001) {
        message = 'Warp was not saved. You can add it whenever you like.';
        messageKind = '';
      } else {
        message = /manifest|domain/i.test(detail) ? 'Farcaster could not validate Warp for saving. Please try again after its app information refreshes.' : 'Farcaster did not confirm saving Warp. Please try again.';
        messageKind = 'error';
      }
    } finally { adding = false; render(); }
  }
  async function copyLink() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(launchUrl || publicUrl);
      message = launchUrl ? 'Mini app link copied. Open it in Farcaster, then tap Save Warp.' : 'App link copied. Paste it in a Farcaster cast, then open its Open Warp card.';
      messageKind = '';
    } catch {
      message = 'Copy this app link: ' + (launchUrl || publicUrl);
      messageKind = '';
    }
    render();
  }
  async function init(options) {
    if (!$('hostPanel')) return;
    const current = ++generation;
    setSdk(options.sdk || null);
    inMiniApp = options.inMiniApp === true;
    publicUrl = options.publicUrl;
    // Only a retrieved canonical Universal Link is accepted. App ids are never
    // derived from a domain or invented when the publisher link is unavailable.
    launchUrl = /^https:\/\/farcaster\.xyz\/miniapps\/[\w-]+\/[\w-]+(?:[/?#]|$)/.test(options.launchUrl || '') ? options.launchUrl : '';
    if (!mounted) {
      $('btnSaveWarp').addEventListener('click', save);
      $('btnCopyWarpLink').addEventListener('click', copyLink);
      mounted = true;
    }
    message = ''; messageKind = ''; render();
    if (!inMiniApp || !sdk || contextRead) return;
    const revision = addedRevision;
    let timer;
    try {
      const context = await Promise.race([sdk.context, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
      if (generation === current && typeof context?.client?.added === 'boolean') {
        contextRead = true;
        if (addedRevision === revision) markAdded(context.client.added);
      }
    } catch { /* Saving can still be offered when optional context is unavailable. */ }
    finally { clearTimeout(timer); }
  }
  window.WarpHost = Object.freeze({init});
})();
