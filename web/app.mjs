import {createRun,command,tick,snapshot,report,validateConfig} from './engine.mjs';
const $=id=>document.getElementById(id), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n).toLocaleString('ko-KR')+'원', uid=()=>crypto.randomUUID();
let mode=localStorage.getItem('tl-mode')||'demo',base=localStorage.getItem('tl-api')||'',token=sessionStorage.getItem('tl-token')||'',user=sessionStorage.getItem('tl-user')||'',activeShow=null,view='events',selected=[],state=null,scenario='success',busy=false,adminToken='',lastReport=null,offset=0,online=true;
const DEMO='ticket-lab-demo-v1';
function toast(message,error=false){$('toast').textContent=message;$('toast').className=error?'error':'';$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6000);}
function demoRead(){try{return JSON.parse(localStorage.getItem(DEMO))||createRun(uid(),Date.now());}catch{return createRun(uid(),Date.now());}}
async function demo(action,data={}) {
  if(!navigator.locks)throw new Error('데모 모드에는 Web Locks를 지원하는 최신 브라우저가 필요합니다.');
  return navigator.locks.request('ticket-lab-demo',()=>{
    const s=demoRead(),now=Date.now();tick(s,now);let result;
    if(action==='login'){if(!/^user\d{5}$/.test(data.user)||+data.user.slice(4)<1||+data.user.slice(4)>s.config.accounts)throw new Error('등록된 테스트 계정을 사용하세요.');result={user:data.user,token:'demo',runId:s.id};}
    else if(action==='public')result=snapshot(s,user,now);
    else if(action.startsWith('admin/report'))result=report(s);
    else if(action==='admin/runs')result=[{id:s.id,created_at:s.createdAt}];
    else if(action==='admin/config'){Object.assign(s.config,validateConfig(data));result={ok:true};}
    else if(action==='admin/start'||action==='admin/stop'){s.running=action==='admin/start';result={ok:true};}
    else if(action==='admin/reset'){if(s.running)throw new Error('테스트를 먼저 중지하세요.');const next=createRun(uid(),now,data.config);localStorage.setItem(DEMO,JSON.stringify(next));return {runId:next.id};}
    else {
      if(!user)throw new Error('테스트 계정으로 로그인해 주세요.');
      const backup=structuredClone(s);s.metrics.requests++;let error;
      try{result=command(s,action,data,user,now,uid());s.metrics.success++;}catch(e){error=e;Object.assign(s,backup);s.metrics.requests++;s.metrics.errors[e.code]=(s.metrics.errors[e.code]||0)+1;}
      s.events.push({at:now,action,user,code:error?.code||'OK',durationMs:0});s.events=s.events.slice(-5000);localStorage.setItem(DEMO,JSON.stringify(s));if(error)throw error;
    }
    localStorage.setItem(DEMO,JSON.stringify(s));return result;
  });
}
async function api(action,data={},method='POST') {
  if(mode==='demo')return demo(action,data);
  const admin=action.startsWith('admin/');
  let response;
  try{response=await fetch(base+'/api/'+action,{method,headers:{'Content-Type':'application/json',...(admin?{'X-Admin-Token':adminToken}:{Authorization:'Bearer '+token})},...(method==='POST'?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(20000)});}catch{online=false;throw new Error('서버 응답을 확인할 수 없습니다. 연결 주소를 확인하세요. 결제 요청은 예매 내역을 조회한 뒤 같은 키로 재시도하세요.');}
  const result=await response.json();if(!response.ok){if(response.status===401&&!admin){token='';sessionStorage.removeItem('tl-token');}throw new Error(result.message||result.code||'요청에 실패했습니다.');}online=true;return result;
}
async function run(fn){if(busy)return;busy=true;try{await fn();}catch(e){toast(e.message,true);}finally{busy=false;}}
function setView(next){view=next;for(const v of ['events','booking','orders','admin'])$(v+'-view').hidden=v!==next;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===next));}
function updateMode(){
  $('mode-label').textContent=mode==='demo'?'로컬 데모':'개인 PC 서버';
  $('mode-notice').textContent=mode==='demo'?'브라우저 데모 · 실제 서버 부하와 여러 기기 간 동시성은 검증하지 않습니다.':'서버 모드 · 대기 순서와 좌석 확보는 서버 처리 결과로 결정됩니다.';
  $('login-button').textContent=user&&token?`${user} · 로그아웃`:'테스트 계정 로그인 →';
  $('login-hint').textContent=`가상 계정 user00001 ~ user${String(state?.config.accounts||1000).padStart(5,'0')}을 사용하세요. ${mode==='demo'?'데모 암호는 비워 두세요.':'서버의 TEST_PASSWORD를 입력하세요.'}`;
}
function currentShow(){return state?.shows.find(s=>s.id===activeShow);}
function myHold(){return state?.holds.find(h=>h.show===activeShow&&h.status==='active');}
function renderEvents(){
  const shows=state?.shows||snapshot(createRun('catalog',Date.now()),'',Date.now()).shows;
  $('event-grid').innerHTML=shows.map((s,i)=>`<article class="event-card"><div class="poster ${s.id}" aria-label="${esc(s.title)} 가상 공연 포스터"><span class="genre">${['LIVE CONCERT / 01','JAZZ SESSION / 02','MUSIC FESTIVAL / 03'][i]}</span><strong>${s.title.split(' ').map(esc).join('<br>')}</strong><small>${esc(s.date)}</small></div><div class="card-body"><div class="card-status"><span>● ${state?.config.openAt>Date.now()+offset?'오픈 예정':'예매 가능'}</span><span class="muted">가상 공연 · ${s.total}석</span></div><h3>${esc(s.subtitle)}</h3><p>${esc(s.date)}</p><p>${esc(s.venue)} · 남은 좌석 ${s.available}석</p><div class="card-bottom"><strong>${money(s.price)} <small>부터</small></strong><button class="primary" data-show="${s.id}" data-testid="book-${s.id}">예매하기 ↗</button></div></div></article>`).join('');
}
function renderBooking(){
  const sh=currentShow();if(!sh)return;
  const q=sh.queue,h=myHold(),orders=state.orders.filter(o=>o.show===sh.id),pending=orders.find(o=>o.holdId===h?.id&&['processing','unknown'].includes(o.status));
  const confirmed=orders.findLast(o=>o.status==='confirmed');
  const top=`<div class="booking-top"><button class="secondary" data-action="back">← 공연 목록</button><h2>${esc(sh.title)}</h2><div class="steps">01 대기열 <span>→</span> <b>02 좌석 선택</b> <span>→</span> 03 모의 결제</div></div>`;
  if(!q || q.status!=='admitted'){
    $('booking-view').innerHTML=top+`<div class="panel queue-panel"><div class="eyebrow">${confirmed?'RESERVATION COMPLETE':'WAITING ROOM'}</div><h2>${confirmed?'예매가 완료되었습니다':q?'입장 순서를 기다리는 중입니다':'예매 대기열에 입장하세요'}</h2>${confirmed?`<p>${esc(confirmed.seats.join(', '))} · ${money(confirmed.amount)}</p><button class="primary" data-action="orders">예매 내역 보기 →</button>`:q?`<p class="muted">새로고침해도 유효한 발급 순번은 유지됩니다.</p><div class="queue-ring"><span>내 앞 대기 인원</span><strong data-testid="queue-ahead">${q.ahead}</strong><span>명</span></div><div class="queue-meta"><span>발급 순번 <b data-testid="queue-number">${q.number}</b></span><span>연결 <b>${online?'정상':'확인 필요'}</b></span></div><p class="muted">${state.config.paused?'관리자가 신규 입장을 일시 중지했습니다.':'3~5초마다 입장 상태를 확인합니다.'}</p><button class="secondary" data-action="leave">대기 취소</button>`:`<p class="muted">동일 계정·동일 공연의 대기 항목은 하나만 유지됩니다.</p>${state.config.challenge?'<label>테스트 인증 · TEST를 입력하세요<input id="challenge-answer" autocomplete="off"></label>':''}<button class="primary" data-action="queue" data-testid="join-queue">대기열 등록 →</button>`}</div>`;return;
  }
  selected=selected.filter(id=>sh.seats.some(s=>s.id===id&&s.status==='available'));
  const items=h?h.seats:selected,total=items.reduce((n,id)=>n+(sh.seats.find(s=>s.id===id)?.price||0),0);
  $('booking-view').innerHTML=top+`<div class="booking-layout"><div class="panel"><div class="section-title compact"><h3>좌석을 선택해 주세요</h3><span class="status-badge">최대 ${state.config.limit}석</span></div><p class="muted">선택 후 ‘좌석 확보’를 눌러야 임시 점유가 시작됩니다.</p><div class="stage">STAGE</div><div class="seat-grid" style="grid-template-columns:repeat(${state.config.columns},max-content)">${sh.seats.map(s=>`<button class="seat ${s.status} ${s.mine?'mine':''} ${selected.includes(s.id)?'selected':''}" data-seat="${s.id}" data-testid="seat-${s.id}" aria-label="${s.id} ${money(s.price)} ${s.mine?'내 점유':({available:'선택 가능',held:'점유 중',sold:'판매 완료'})[s.status]}" aria-pressed="${selected.includes(s.id)}" ${s.status!=='available'||h?'disabled':''}>${s.id}</button>`).join('')}</div><div class="legend"><span><i></i>선택 가능</span><span><i class="orange"></i>선택</span><span><i class="held"></i>점유 중</span><span><i class="sold"></i>판매 완료</span></div></div><aside class="panel booking-aside"><div class="eyebrow">YOUR SELECTION</div><h3 style="margin-top:8px">${esc(sh.title)}</h3><div class="summary-line"><span>공연 일시</span><span>${esc(sh.date.slice(0,12))}</span></div><div class="summary-line"><span>선택 좌석</span><span>${items.length}석</span></div><div class="selected-tags">${items.map(id=>`<span>${esc(id)}</span>`).join('')||'<p class="muted">좌석을 선택해 주세요.</p>'}</div><div class="total">${money(total)}</div>${h?`<span class="muted">좌석 점유 남은 시간</span><div class="timer" data-expiry="${h.expiresAt}" data-testid="hold-timer"></div>${pending?`<p class="connection-error" data-testid="payment-status">${pending.status==='unknown'?'결과 확인 필요 · 타임아웃을 실패로 단정하지 않고 대사 중입니다.':'모의 결제를 처리하고 있습니다.'}</p><button class="secondary full" data-action="orders">주문 상태 조회</button>`:`<label>모의 결제 시나리오<select id="payment-scenario" data-testid="payment-scenario">${[['success','성공'],['failure','실패'],['delay','15초 지연'],['timeout','타임아웃 후 대사'],['duplicate','중복 알림'],['lost','응답 유실']].map(([v,t])=>`<option value="${v}" ${scenario===v?'selected':''}>${t}</option>`).join('')}</select></label><button class="primary full" data-action="pay" data-testid="pay-submit">${money(total)} 모의 결제</button><button class="secondary full" data-action="release">점유 해제</button>`}`:`<button class="primary full" data-action="hold" data-testid="hold-submit" ${!selected.length?'disabled':''}>선택한 좌석 확보 →</button>`}<p class="muted" style="font-size:10px;margin-top:20px">실제 금액은 청구되지 않습니다. 화면의 좌석 상태와 서버 처리 시점의 상태가 다르면 확보에 실패할 수 있습니다.</p></aside></div>`;
  updateClock();
}
const statuses={processing:'결제 처리 중',unknown:'확인 필요',confirmed:'예매 확정',failed:'결제 실패',refunded:'모의 환불',cancelled:'취소 완료'};
function renderOrders(){
  const orders=state?.orders||[];$('order-count').textContent=orders.filter(o=>o.status==='confirmed').length;
  $('orders-list').innerHTML=orders.length?[...orders].reverse().map(o=>`<article class="panel order-card" data-testid="order-${o.id}"><div class="order-icon">⌁</div><div class="order-detail"><span class="status-badge" data-testid="order-status">${statuses[o.status]}</span><h3>${esc(state.shows.find(s=>s.id===o.show)?.title)}</h3><p>${esc(o.seats.join(' · '))}　${money(o.amount)}</p><p class="muted">예매 번호 ${esc(o.id)}</p>${o.compensation?`<p class="muted">${esc(o.compensation)}</p>`:''}</div>${o.status==='confirmed'?`<button class="secondary danger" data-cancel="${esc(o.id)}" data-testid="cancel-order">예매 취소</button>`:''}</article>`).join(''):`<div class="panel empty"><strong>아직 예매 내역이 없습니다</strong><p>가상 공연의 좌석을 선택하고 모의 결제를 진행해 보세요.</p><button class="primary" data-action="back">공연 둘러보기 →</button></div>`;
}
function updateClock(){const now=Date.now()+offset;$('clock').textContent=`${mode==='demo'?'데모':'서버'} ${new Date(now).toLocaleTimeString('ko-KR',{hour12:false})}`;document.querySelectorAll('[data-expiry]').forEach(el=>{const n=Math.max(0,Math.ceil((+el.dataset.expiry-now)/1000));el.textContent=`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;});}
async function refresh(){
  if(mode==='server'&&!token){state=null;renderEvents();renderOrders();updateMode();return;}
  const result=await api(mode==='demo'&&!user?'public':activeShow?'heartbeat':'state',activeShow?{show:activeShow}:{});
  state=result;offset=state.serverTime-Date.now();renderEvents();renderOrders();if(view==='booking')renderBooking();updateMode();
}
async function renderReport(runId){
  lastReport=await api('admin/report'+(runId?'?run='+encodeURIComponent(runId):''),{},'GET');
  $('admin-content').hidden=false;const r=lastReport,m=r.metrics;
  $('metrics').innerHTML=[['요청 수',m.requests,'건'],['성공률',m.requests?(m.success/m.requests*100).toFixed(1):'—','%'],['p95 처리 시간',mode==='demo'?'—':Math.round(m.p95),'ms'],['정합성 위반',r.violations.length,'건']].map(([a,b,c])=>`<div class="metric"><small>${a}</small><strong>${b}</strong> <em>${c}</em></div>`).join('');
  $('audit-result').textContent=`${r.running?'실행 중':'중지됨'} · 실행 ${r.runId} · 정합성 ${r.violations.length?'위반: '+r.violations.join(', '):'검사 통과'} · 자동화 요청 차단 ${m.blockedBot}/${m.botRequests} · 일반 요청 차단 ${m.blockedHuman}/${m.humanRequests}`;
  $('event-log').innerHTML=r.events.slice(-100).reverse().map(e=>`<tr><td>${new Date(e.at).toLocaleTimeString('ko-KR')}</td><td>${esc(e.user||'관리자')}</td><td>${esc(e.action)}</td><td>${esc(e.code||'OK')}</td><td>${e.durationMs??'—'} ms</td></tr>`).join('');
  $('pause-entry').checked=r.config.paused;$('pause-sales').checked=r.config.salesPaused;$('rate-limit').checked=r.config.rateLimit;$('challenge').checked=r.config.challenge;$('request-limit').value=r.config.requestsPerMinute;$('response-delay').value=r.config.delayMs;$('failure-every').value=r.config.failureEvery;
}
function exportFile(format){if(!lastReport)return;const text=format==='json'?JSON.stringify(lastReport,null,2):'\uFEFF'+[['run_id','at','user','action','code','duration_ms'],...lastReport.events.map(e=>[lastReport.runId,new Date(e.at).toISOString(),e.user,e.action,e.code,e.durationMs])].map(row=>row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:format==='json'?'application/json':'text/csv;charset=utf-8'}));a.download=`ticket-lab-${lastReport.runId}.${format}`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.close){$(b.dataset.close).close();return;}
 if(b.dataset.tab){setView(b.dataset.tab);if(view==='orders')run(refresh);return;}
 if(b.dataset.show){activeShow=b.dataset.show;selected=[];if(!user||!token){$('login-dialog').showModal();return;}setView('booking');run(refresh);return;}
 if(b.dataset.seat){const id=b.dataset.seat;if(selected.includes(id))selected=selected.filter(x=>x!==id);else if(selected.length<state.config.limit)selected.push(id);else toast(`최대 ${state.config.limit}석까지 선택할 수 있습니다.`,true);renderBooking();return;}
 if(b.dataset.cancel){run(async()=>{await api('cancel',{orderId:b.dataset.cancel});toast('예매가 취소되었습니다.');await refresh();});return;}
 if(b.dataset.action)run(async()=>{
   const action=b.dataset.action;
   if(action==='back'){activeShow=null;setView('events');return;}
   if(action==='orders'){setView('orders');await refresh();return;}
   if(action==='queue')await api('queue',{show:activeShow,answer:$('challenge-answer')?.value});
   if(action==='leave'){await api('leave',{show:activeShow});setView('events');activeShow=null;}
   if(action==='hold'){await api('hold',{show:activeShow,seats:selected});selected=[];toast('선택한 좌석을 확보했습니다.');}
   if(action==='release')await api('release',{holdId:myHold().id});
   if(action==='pay'){
     const h=myHold();let saved=JSON.parse(sessionStorage.getItem('tl-payment')||'null');
     if(!saved||saved.holdId!==h.id||saved.scenario!==scenario){saved={holdId:h.id,scenario,key:uid()};sessionStorage.setItem('tl-payment',JSON.stringify(saved));}
     try{await api('pay',saved);toast('모의 결제 요청을 접수했습니다.');}catch(e){await refresh().catch(()=>{});throw e;}
   }
   await refresh();
 });
});
$('login-button').onclick=()=>run(async()=>{if(user&&token){await api('logout');user='';token='';sessionStorage.removeItem('tl-user');sessionStorage.removeItem('tl-token');activeShow=null;setView('events');await refresh();}else $('login-dialog').showModal();});
$('login-form').onsubmit=e=>{e.preventDefault();run(async()=>{const r=await api('login',{user:$('username').value.trim(),password:$('password').value,bot:$('is-bot').checked});user=r.user;token=r.token;sessionStorage.setItem('tl-user',user);sessionStorage.setItem('tl-token',token);$('password').value='';$('login-dialog').close();if(activeShow)setView('booking');await refresh();toast(`${user} 계정으로 로그인했습니다.`);});};
$('connection-button').onclick=()=>{$('mode-select').value=mode;$('api-url').value=base;$('connection-dialog').showModal();};
$('connection-form').onsubmit=e=>{e.preventDefault();run(async()=>{const next=$('mode-select').value;let url=$('api-url').value.trim().replace(/\/$/,'');if(next==='server'){if(!url)url=location.origin;const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('인증정보나 쿼리가 없는 HTTP(S) 주소를 입력하세요.');if(location.protocol==='https:'&&parsed.protocol!=='https:')throw new Error('이 HTTPS 페이지에서는 HTTPS API 주소를 입력하세요. 로컬 HTTP 테스트는 PC 서버의 화면에서 진행하세요.');}mode=next;base=url;localStorage.setItem('tl-mode',mode);localStorage.setItem('tl-api',base);user='';token='';adminToken='';sessionStorage.removeItem('tl-user');sessionStorage.removeItem('tl-token');$('admin-content').hidden=true;$('connection-dialog').close();activeShow=null;setView('events');await refresh();toast('연결 설정을 저장했습니다. 테스트 계정으로 로그인해 주세요.');});};
$('booking-view').onchange=e=>{if(e.target.id==='payment-scenario')scenario=e.target.value;};
$('refresh-orders').onclick=()=>run(refresh);
$('admin-connect').onclick=()=>run(async()=>{adminToken=$('admin-token').value;await renderReport();});
$('refresh-report').onclick=()=>run(()=>renderReport());
for(const action of ['start','stop'])$('run-'+action).onclick=()=>run(async()=>{await api('admin/'+action);await renderReport();toast(action==='start'?'테스트를 시작했습니다.':'신규 입장을 중지했습니다. 진행 중인 결제는 계속 대사합니다.');});
$('save-config').onclick=()=>run(async()=>{await api('admin/config',{paused:$('pause-entry').checked,salesPaused:$('pause-sales').checked,rateLimit:$('rate-limit').checked,challenge:$('challenge').checked,requestsPerMinute:+$('request-limit').value,delayMs:+$('response-delay').value,failureEvery:+$('failure-every').value});await renderReport();toast('설정을 적용했습니다.');});
$('new-run').onclick=()=>run(async()=>{await api('admin/reset',{config:{accounts:+$('new-accounts').value,capacity:+$('new-capacity').value,admitPerSecond:+$('new-admit').value,holdSeconds:+$('new-hold').value,rows:+$('new-rows').value,columns:+$('new-columns').value,limit:+$('new-limit').value,seed:+$('new-seed').value,openAt:$('new-open').value?new Date($('new-open').value).getTime():0,macroVersion:$('macro-version').value}});token='';user='';sessionStorage.removeItem('tl-token');sessionStorage.removeItem('tl-user');activeShow=null;await renderReport();await refresh();toast('새 실행이 생성되었습니다. 테스트 계정으로 다시 로그인하세요.');});
$('export-json').onclick=()=>exportFile('json');$('export-csv').onclick=()=>exportFile('csv');
$('list-runs').onclick=()=>run(async()=>{const runs=await api('admin/runs',{},'GET');$('run-list').replaceChildren();for(const item of runs){const b=document.createElement('button');b.className='secondary';b.textContent=`${new Date(item.created_at).toLocaleString('ko-KR')} · ${item.id.slice(0,8)}`;b.onclick=()=>run(()=>renderReport(item.id));$('run-list').append(b);}});
async function poll(){if(!busy&&document.visibilityState==='visible'&&(mode==='demo'||token)){try{await refresh();}catch(e){if(online)toast(e.message,true);online=false;}}setTimeout(poll,3000+Math.random()*2000);}
updateMode();renderEvents();renderOrders();refresh().catch(e=>toast(e.message,true));setInterval(updateClock,1000);setTimeout(poll,3500);
