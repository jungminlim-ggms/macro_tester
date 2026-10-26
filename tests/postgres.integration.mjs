import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {createRun,command,tick,audit} from '../web/engine.mjs';
const url=process.env.TEST_DATABASE_URL;
test('PostgreSQL: two independent pools, competing holds, worker limits, durable restart and rollback',{skip:!url,timeout:180000},async()=>{
 const a=new Store(url),b=new Store(url);await a.init();await b.init();
 try {
  await a.transaction(()=>({newRun:createRun(randomUUID(),Date.now(),{accounts:1000,capacity:1000,admitPerSecond:1000,sessionSeconds:3600,holdSeconds:900})}));
  await a.transaction((s,now)=>{for(let i=1;i<=1000;i++)command(s,'queue',{show:'aurora'},'user'+String(i).padStart(5,'0'),now,randomUUID());});
  const results=await Promise.all(Array.from({length:1000},(_,i)=>(i%2?a:b).transaction((s,now)=>{tick(s,now);try{command(s,'hold',{show:'aurora',seats:['A01']},'user'+String(i+1).padStart(5,'0'),now,randomUUID());return 'OK';}catch(e){return e.code;}})));
  assert.equal(results.filter(x=>x==='OK').length,1);assert.equal(results.filter(x=>x==='SEAT_TAKEN').length,999);
  const before=await a.transaction(s=>structuredClone(s));assert.deepEqual(audit(before),[]);
  await assert.rejects(a.transaction(s=>{s.running=false;throw new Error('rollback');}));assert.equal((await b.transaction(s=>s.running)),true);
  const winner=before.holds[0];
  const orders=await Promise.all(Array.from({length:100},(_,i)=>(i%2?a:b).transaction((s,now)=>command(s,'pay',{holdId:winner.id,scenario:'duplicate',key:'same-payment-key'},winner.user,now,randomUUID()))));
  assert.equal(new Set(orders.map(o=>o.id)).size,1);
  await a.close();const reopened=new Store(url);await reopened.init();try{await reopened.transaction((s,now)=>tick(s,now+1000));const recovered=await reopened.transaction(s=>structuredClone(s));assert.equal(recovered.orders.length,1);assert.equal(recovered.orders[0].status,'confirmed');assert.deepEqual(audit(recovered),[]);}finally{await reopened.close();}
 }finally{await a.close().catch(()=>{});await b.close();}
});
