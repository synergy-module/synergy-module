import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createBrainToolManager } from "../../public/js/brain/brain-tool-manager.js";
import { BRAIN_TOOL_CATALOG, BRAIN_SECTIONS, defaultBrainToolPolicy } from "../../src/agent-brain/brain-tool-policy.js";
const tick = () => new Promise(resolve=>setImmediate(resolve));
const snapshot = () => ({policy:defaultBrainToolPolicy(),sections:BRAIN_SECTIONS,catalog:BRAIN_TOOL_CATALOG.map(tool=>({...tool,configured:true})),synergyResearch:{connected:true,counts:{artifact:4500}}});
function fixture(t, request) {
  const dom = new JSDOM('<main></main>', {url:'http://localhost/brain'}), root = dom.window.document.querySelector('main');
  const manager = createBrainToolManager(root,{request}); t.after(()=>{manager.dispose();dom.window.close();});
  return {dom,root,manager,button:text=>[...root.querySelectorAll('button')].find(item=>item.textContent===text)};
}
test('admin editor shows module blocking, saves the selected section and preserves edits after a conflict', async t=>{
  const calls=[]; let conflict=true;
  const app=fixture(t,async(url,body,method)=>{calls.push({url,body,method});if(method==='PUT'){if(conflict)throw new Error('Tool access changed. Reload assignments before saving.'); const value=defaultBrainToolPolicy();value.version=1;value.assignments['agent:researcher']=body.tools;return {policy:value};}return snapshot();});
  await app.manager.open('agent:researcher');
  const checkbox=app.root.querySelector('input[value="synergy-mcp"]');assert.equal(checkbox.checked,false);assert.match(checkbox.closest('label').textContent,/Blocked by Retrieval/);
  checkbox.checked=true;checkbox.dispatchEvent(new app.dom.window.Event('change',{bubbles:true}));
  app.button('Save access').click();await tick();assert.match(app.root.textContent,/Reload assignments/);assert.equal(checkbox.checked,true);
  conflict=false;app.button('Save access').click();await tick();
  assert.deepEqual(calls.at(-1).body,{version:0,tools:['synergy-mcp','context','calendar','knowledge','journal','memory','robinhood']});
  assert.equal(calls.at(-1).url,'/api/brain/tools/agent%3Aresearcher');assert.match(app.root.textContent,/Access saved/);
  app.root.querySelector('select').value='module:memory';app.root.querySelector('select').dispatchEvent(new app.dom.window.Event('change'));
  assert.deepEqual([...app.root.querySelectorAll('input[type=checkbox]')].map(item=>item.value),['memory']);
});
test('admin source inspector renders untrusted text safely and follows continuation offsets',async t=>{
  const calls=[], source={kind:'artifact',id:'fixture',title:'<img src=x onerror=alert(1)>'};
  const app=fixture(t,async url=>{calls.push(url);if(url==='/api/brain/tools')return snapshot();if(url.includes('/search?'))return {matches:[source]};return {source,excerpt:'<script>untrusted source</script>',citations:[{id:'fixture-citation'}],nextOffset:url.includes('offset=0')?8192:null};});
  await app.manager.open();const query=app.root.querySelector('input[name=query]');query.value='NQ overview';app.button('Search sources').click();await tick();
  app.button(source.title).click();await tick();assert.equal(app.root.querySelector('script,img'),null);assert.match(app.root.querySelector('pre').textContent,/untrusted source/);
  app.button('Read next excerpt').click();await tick();assert.ok(calls.at(-1).includes('offset=8192'));assert.equal(app.button('Read next excerpt').hidden,true);
});
test('closing the editor aborts pending requests and ignores late responses',async t=>{
  let finish,signal;const app=fixture(t,(url,body,method,options)=>{signal=options.signal;return new Promise(resolve=>{finish=resolve;});});
  const opening=app.manager.open();app.button('Close').click();assert.equal(signal.aborted,true);finish(snapshot());await opening;assert.equal(app.root.querySelector('dialog'),null);
});
