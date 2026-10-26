// Run only against the user's explicitly configured test server.
import {writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const base=process.env.TARGET_URL||'http://localhost:8080';
const users=Number(process.env.USERS||20),seconds=Number(process.env.SECONDS||30),rps=Number(process.env.RPS||10),ramp=Number(process.env.RAMP_SECONDS||0),pattern=process.env.PATTERN||'steady',seed=Number(process.env.SEED||2026);
if(!process.env.TEST_PASSWORD)throw new Error('Set TEST_PASSWORD for your test server.');
if(!Number.isInteger(users)||users<1||users>1000||seconds<1||seconds>3600||rps<1||rps>1000||ramp<0||!['steady','random','burst'].includes(pattern))throw new Error('USERS 1..1000, SECONDS 1..3600, RPS 1..1000, RAMP_SECONDS >=0, PATTERN steady/random/burst');
let rng=seed>>>0;const random=()=>{rng=(1664525*rng+1013904223)>>>0;return rng/4294967296;};
const records=[],tokens=[];
async function call(action,data={},token='',user=''){
 const at=performance.now();let code,status,result;
 try{const res=await fetch(base+'/api/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(data),signal:AbortSignal.timeout(60000)});result=await res.json();status=res.status;code=res.ok?'OK':result.code;}catch{code='NETWORK';status=0;}
 records.push({action,user,code,status,ms:Math.round((performance.now()-at)*100)/100});return result;
}
console.log(JSON.stringify({target:base,users,seconds,rps,ramp,pattern,seed,note:'Counts include login; load targets API only, never GitHub Pages.'}));
// Login rate is intentionally limited to 60/min/IP; sessions are established gradually.
for(let i=1;i<=users;i++){const user='user'+String(i).padStart(5,'0');const r=await call('login',{user,password:process.env.TEST_PASSWORD,bot:true},'',user);if(!r?.token)throw new Error(`Login failed for ${user}; inspect server limits and reset test run.`);tokens.push({user,token:r.token});if(i<users)await new Promise(r=>setTimeout(r,1100));}
const start=performance.now(),end=start+seconds*1000,pending=new Set();let count=0;
async function actor(item){await call('queue',{show:'aurora',answer:'TEST'},item.token,item.user);const s=await call('heartbeat',{show:'aurora'},item.token,item.user);const show=s?.shows?.find(x=>x.id==='aurora');if(show?.queue?.status!=='admitted')return;const seats=show.seats.filter(x=>x.status==='available');if(!seats.length)return;const id=process.env.SAME_SEAT||seats[Math.floor(random()*seats.length)].id;const h=await call('hold',{show:'aurora',seats:[id]},item.token,item.user);if(h?.id)await call('pay',{holdId:h.id,scenario:'success',key:randomUUID()},item.token,item.user);}
while(performance.now()<end){
 const item=tokens[count++%tokens.length];const work=actor(item).finally(()=>pending.delete(work));pending.add(work);
 // RPS is a scenario start rate. Each scenario makes 2–4 API requests, reported below.
 const elapsed=(performance.now()-start)/1000,rate=rps*(ramp?Math.min(1,Math.max(.05,elapsed/ramp)):1);
 const wait=pattern==='burst'?(count%users===0?1000:0):1000/rate*(pattern==='random'?.5+random():1);
 if(pending.size>=users)await Promise.race(pending);
 if(wait)await new Promise(r=>setTimeout(r,wait));
}
await Promise.all(pending);
const latency=records.map(x=>x.ms).sort((a,b)=>a-b),errors={};for(const r of records)if(r.code!=='OK')errors[r.code]=(errors[r.code]||0)+1;
const result={startedAt:new Date().toISOString(),target:base,users,seconds,scenarioStartsPerSecond:rps,ramp,pattern,seed,requests:records.length,errors,p95:latency[Math.ceil(latency.length*.95)-1],records};
await mkdir('test-results',{recursive:true});const name='test-results/load-'+Date.now();await writeFile(name+'.json',JSON.stringify(result,null,2));await writeFile(name+'.csv','action,user,code,status,ms\n'+records.map(r=>[r.action,r.user,r.code,r.status,r.ms].join(',')).join('\n'));
console.log(JSON.stringify({...result,records:undefined,files:name+'.{json,csv}'}));
