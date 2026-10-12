export function renderBrokerSetupHelp(root, state) {
  const details = root.querySelector('[data-broker-setup-help]'), content = root.querySelector('[data-broker-setup-content]');
  if (!details || !content) return;
  const setup = state.setup;
  details.hidden = !setup || !Array.isArray(setup.checks); content.replaceChildren();
  if (details.hidden) return;
  const doc = root.ownerDocument;
  const text = (tag, value) => { const node = doc.createElement(tag); node.textContent = value; return node; };
  const list = doc.createElement('ul');
  for (const check of setup.checks) { const item = doc.createElement('li'); item.append(text('strong', `${check.ready ? 'Ready' : 'Needs setup'} · ${check.label}`), text('p', check.message || '')); list.append(item); }
  content.append(list);
  if (setup.supportUrl) {
    try { const url = new URL(setup.supportUrl); if (url.protocol === 'https:' && ['robinhood.com', 'www.robinhood.com'].includes(url.hostname)) { const link = text('a', 'Official Robinhood connection guidance ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; content.append(link); } } catch { /* Ignore invalid destinations. */ }
  }
  if (setup.redirectUri || setup.encryptionKeySource || setup.redirectSource) { const technical = doc.createElement('details'); technical.append(text('summary', 'Technical connection details')); if (setup.redirectUri) technical.append(text('p', `Callback address: ${setup.redirectUri}`)); if (setup.redirectSource) technical.append(text('p', `Callback source: ${setup.redirectSource}`)); if (setup.encryptionKeySource) technical.append(text('p', `Encryption configuration: ${setup.encryptionKeySource}`)); content.append(technical); }
}
