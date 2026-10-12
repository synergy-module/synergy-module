import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { JSDOM } from 'jsdom';
import { initializeBrokerBindingEditor } from '../../public/js/broker-binding-editor.js';
import { initializeRobinhoodBrain } from '../../public/js/robinhood-brain-controller.js';
import { RH_BINDINGS, rhBrainHarness } from '../helpers/robinhood-brain-test-helpers.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function page(paper=false){return new JSDOM(`<meta name="csrf-token" content="test">${await ejs.renderFile('views/pages/robinhood-brain.ejs',{page:{route:{key:paper?'robinhood-paper':'robinhood-brain'}}})}`,{url:`https://synergy.test/${paper?'practice/equities':'robinhood-brain'}`});}
test('guided mappings preserve exact saved paths and structured tool inputs',async t=>{
 const dom=await page(),root=dom.window.document.querySelector('[data-robinhood-brain]'); const editor=initializeBrokerBindingEditor(root); t.after(()=>{editor.dispose();dom.window.close();});
 const bindings=structuredClone(RH_BINDINGS);bindings[2].arguments={symbols:'{symbols}',count:2,extended:false};bindings[2].fields.closes={path:'/history',column:'/close'};bindings[0].fields.cash='';editor.render(bindings);
 editor.setCatalog([{name:'get_equity_quotes',inputSchema:{properties:{symbols:{type:'array'},count:{type:'integer'},extended:{type:'boolean'}}}}]);assert.deepEqual(editor.read(),bindings);
 const cash=root.querySelector('[data-binding-field="cash"]');cash.value='/balance/cash';cash.dispatchEvent(new dom.window.Event('input',{bubbles:true}));assert.equal(editor.read()[0].fields.cash,'/balance/cash');assert.equal(JSON.parse(root.querySelector('[data-rh-bindings]').value)[0].fields.cash,'/balance/cash');
 root.querySelector('[data-rh-binding-add]').click();assert.equal(editor.read().length,6);
});
test('equity contexts choose separate APIs and expose only their execution modes',async t=>{
 const harness=rhBrainHarness();await harness.connect();t.after(()=>harness.service.close());
 for(const paper of [false,true]){const dom=await page(paper),root=dom.window.document.querySelector('[data-robinhood-brain]'),calls=[],state=await harness.service.state('alice');const instance=initializeRobinhoodBrain(root,{fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/catalog')?{tools:[]}:state);}});await instance.ready;await tick();
 assert.ok(calls.every(c=>c.url.startsWith(paper?'/api/practice/equities':'/api/robinhood-brain')));assert.equal(root.querySelector('[data-rh-action="demo"]'),null);assert.equal(root.querySelector('[data-rh-action="cycle"]').hidden,!paper);assert.deepEqual([...root.querySelectorAll('[name="rh-mode"]')].map(n=>n.value),paper?['paper']:['review','autonomous']);assert.equal(root.querySelector('[data-rh-stats]').hidden,!paper);
 const cash=root.querySelector('[data-binding-field="cash"]');cash.value='/availableCash';cash.dispatchEvent(new dom.window.Event('input',{bubbles:true}));root.querySelector('[data-rh-policy-form]').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();const save=calls.find(c=>c.url.endsWith('/policy'));assert.ok(save);assert.equal(JSON.parse(save.options.body).bindings[0].fields.cash,'/availableCash');assert.equal(save.options.headers['X-CSRF-Token'],'test');instance.dispose();dom.window.close();}
});
