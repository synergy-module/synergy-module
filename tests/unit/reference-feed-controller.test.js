import test from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import { JSDOM } from 'jsdom';
import { initializeReferenceFeed } from '../../public/js/reference-feed-controller.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const status=(configured=false,recording=false)=>({polybolt:{configured,credentialStorageAvailable:true,recorder:{status:recording?'recording':'idle',bufferedSamples:0,expiresAt:new Date(Date.now()+300000).toISOString()}}});
async function fixture(t,mode,request){const dom=new JSDOM(await ejs.renderFile('views/partials/reference-feed.ejs',{referenceMode:mode}));const instance=initializeReferenceFeed(dom.window.document.body,{request});t.after(()=>{instance.dispose();dom.window.close();});return{dom,instance,q:name=>dom.window.document.querySelector(`[data-reference-${name}]`)};}
test('optional reference feed saves encrypted credential request only on submit and clears successful secrets',async t=>{
 const calls=[];const app=await fixture(t,'settings',async(url,body,method)=>{calls.push({url,body,method});return status(method==='PUT');});await app.instance.load();const form=app.q('credentials');for(const name of ['apiKey','secret','passphrase'])form.elements[name].value=`test-${name}`;assert.equal(calls.length,1);form.dispatchEvent(new app.dom.window.Event('submit',{cancelable:true,bubbles:true}));await tick();assert.deepEqual(calls[1],{url:'/api/practice/feeds/polybolt',body:{apiKey:'test-apiKey',secret:'test-secret',passphrase:'test-passphrase'},method:'PUT'});assert.equal(form.elements.secret.value,'');assert.match(app.q('status').textContent,/saved/i);app.q('disconnect').click();await tick();assert.equal(calls.at(-1).method,'DELETE');
});
test('reference recorder requires explicit start, stops and displays samples safely',async t=>{
 const calls=[];const app=await fixture(t,'practice',async(url,body,method)=>{calls.push({url,body,method});return url.includes('/snapshot')?{samples:[{price:123,label:'<img src=x onerror=alert(1)>'}]}:status(true,url.endsWith('/start'));});await app.instance.load();assert.equal(calls.length,1);app.q('recorder').dispatchEvent(new app.dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(calls[1].url,'/api/practice/feeds/polybolt/start');assert.deepEqual(calls[1].body,{symbols:['btcusd'],channels:['price.crypto','price.crypto.twap'],durationSeconds:900});assert.equal(app.q('stop').disabled,false);app.q('snapshot').click();await tick();assert.equal(app.dom.window.document.querySelector('img'),null);assert.match(app.q('summary').textContent,/1 recorded/);app.q('stop').click();await tick();assert.equal(calls.at(-1).url,'/api/practice/feeds/polybolt/stop');
});
