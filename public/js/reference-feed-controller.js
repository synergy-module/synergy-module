export function initializeReferenceFeed(root, { request, windowRef = root.ownerDocument.defaultView } = {}) {
  const container = root.querySelector('[data-reference-feed]'); if (!container) return { load() {}, dispose() {} };
  const q = name => container.querySelector(`[data-reference-${name}]`), credentials = q('credentials'), recorder = q('recorder'), listeners = [];
  let disposed = false, loaded = false, loading = false, busy = false, state, timer, snapshot;
  const on = (node, name, handler) => { node?.addEventListener(name, handler); listeners.push(() => node?.removeEventListener(name, handler)); };
  const say = text => { if (!disposed) q('feedback').textContent = text; };
  const active = value => ['connecting','authenticating','subscribing','recording','reconnecting'].includes(value?.status);
  function render(value) {
    if (disposed) return; state = value; loaded = true;
    const feed = value.polybolt, recording = active(feed.recorder);
    q('status').textContent = feed.needsReplacement ? 'Replace credentials' : feed.configured ? recording ? `Feed ${feed.recorder.status}` : 'Credentials saved' : 'Not connected';
    if (credentials) { credentials.querySelector('[type="submit"]').disabled = busy || !feed.credentialStorageAvailable; q('disconnect').disabled = busy || !feed.configured; }
    if (recorder) { recorder.querySelector('[type="submit"]').disabled = busy || !feed.configured || recording; q('stop').disabled = busy || !recording; }
    if (!feed.credentialStorageAvailable) say('Your administrator needs to enable encrypted credential storage before this optional feed can be connected.');
    else if (feed.recorder.lastError) say(feed.recorder.lastError);
    else if (recording) say(`Recording current reference evidence. ${feed.recorder.bufferedSamples} samples buffered. Recording ends ${new Date(feed.recorder.expiresAt).toLocaleTimeString()}.`);
    windowRef.clearTimeout?.(timer); if (recording) timer = windowRef.setTimeout?.(() => void load(true), 10000);
  }
  async function load(force = false) {
    if (disposed || busy || loading || loaded && !force) return;
    loading = true;
    try { render(await request('/api/practice/feeds')); }
    catch (error) { say(error.message); }
    finally { loading = false; }
  }
  async function act(work, success) {
    if (disposed || busy) return; busy = true; if (state) render(state); say('Updating reference feed…');
    try { const value = await work(); if (!disposed) { render(value); say(success); } } catch (error) { say(error.message); }
    finally { busy = false; if (!disposed && state) render(state); }
  }
  on(credentials, 'submit', event => {
    event.preventDefault(); if (!credentials.reportValidity()) return;
    const body = Object.fromEntries(['apiKey','secret','passphrase'].map(key => [key, credentials.elements.namedItem(key).value.trim()]));
    void act(async () => { const value = await request('/api/practice/feeds/polybolt', body, 'PUT'); if (!disposed) for (const key of Object.keys(body)) if (credentials.elements.namedItem(key).value.trim() === body[key]) credentials.elements.namedItem(key).value = ''; return value; }, 'Encrypted data credentials saved. Start a recording in Practice to verify access.');
  });
  on(q('disconnect'), 'click', () => void act(() => request('/api/practice/feeds/polybolt', {}, 'DELETE'), 'Data feed disconnected and recording stopped.'));
  on(recorder, 'submit', event => { event.preventDefault(); if (!recorder.reportValidity()) return; void act(() => request('/api/practice/feeds/polybolt/start', { symbols: [recorder.elements.symbol.value], channels: ['price.crypto','price.crypto.twap'], durationSeconds: Number(recorder.elements.durationSeconds.value) }), 'Reference recording requested. Watch the status for confirmation.'); });
  on(q('stop'), 'click', () => void act(() => request('/api/practice/feeds/polybolt/stop', {}), 'Recording stopped. Retained evidence remains available.'));
  on(q('snapshot'), 'click', async () => {
    const control = q('snapshot'); if (control.disabled) return; control.disabled = true;
    try { const value = await request(`/api/practice/feeds/polybolt/snapshot?symbol=${encodeURIComponent(recorder.elements.symbol.value)}&limit=500`); if (!disposed) { snapshot = value; q('evidence').hidden = false; q('summary').textContent = `${value.samples.length} recorded reference samples. Retained limit: ${value.retainedSampleLimit ?? 500}. These are observed reference prices, not executable order quotes.`; q('json').textContent = JSON.stringify(value, null, 2); } }
    catch (error) { say(error.message); } finally { if (!disposed) control.disabled = false; }
  });
  on(q('export'), 'click', () => { if (!snapshot || !windowRef.URL?.createObjectURL) return; const url = windowRef.URL.createObjectURL(new windowRef.Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })); const link = root.ownerDocument.createElement('a'); link.href = url; link.download = 'recorded-reference-evidence.json'; root.ownerDocument.body.append(link); link.click(); link.remove(); windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 1000); });
  return { load, dispose() { disposed = true; windowRef.clearTimeout?.(timer); listeners.forEach(remove => remove()); if (credentials) for (const key of ['apiKey','secret','passphrase']) credentials.elements.namedItem(key).value = ''; } };
}
