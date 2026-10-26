// Pure state machine shared by the server and explicitly labelled browser demo.
export class Fault extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new Fault(code, message, status); };
export const defaults = { accounts: 1000, rows: 10, columns: 12, limit: 2, holdSeconds: 180,
  sessionSeconds: 600, graceSeconds: 60, capacity: 300, admitPerSecond: 50, openAt: 0,
  paused: false, salesPaused: false, rateLimit: false, requestsPerMinute: 120,
  challenge: false, delayMs: 0, failureEvery: 0, seed: 2026, macroVersion: 'manual' };
export function validateConfig(input) {
  const bounds = {accounts:[1,10000],rows:[1,26],columns:[1,30],limit:[1,10],holdSeconds:[1,900],
    sessionSeconds:[5,3600],graceSeconds:[5,300],capacity:[1,1000],admitPerSecond:[1,1000],
    requestsPerMinute:[5,10000],delayMs:[0,10000],failureEvery:[0,1000],seed:[0,2147483647],openAt:[0,4102444800000]};
  for (const [k,v] of Object.entries(input)) {
    if (!(k in defaults)) fail('CONFIG', `알 수 없는 설정: ${k}`,400);
    if (bounds[k] && (!Number.isSafeInteger(v) || v < bounds[k][0] || v > bounds[k][1])) fail('CONFIG',`${k} 범위를 확인하세요.`,400);
    if (typeof defaults[k] === 'boolean' && typeof v !== 'boolean') fail('CONFIG',`${k}: 참/거짓이 필요합니다.`,400);
    if (k === 'macroVersion' && (typeof v !== 'string' || v.length > 80)) fail('CONFIG','매크로 버전은 80자 이내입니다.',400);
  }
  return input;
}
export function createRun(id, now, input = {}) {
  const config = {...defaults, ...validateConfig(input)};
  const shows = [
    {id:'aurora', title:'AURORA LIVE', subtitle:'빛과 음악이 만나는 밤', date:'2026. 12. 12. SAT · 19:00', venue:'테스트 아레나', price:88000},
    {id:'jazz', title:'BLUE HOUR', subtitle:'도시의 저녁을 위한 재즈', date:'2026. 12. 19. SAT · 18:00', venue:'테스트 뮤직홀', price:66000},
    {id:'orbit', title:'ORBIT FEST', subtitle:'새로운 궤도에서 만나는 사운드', date:'2026. 12. 26. SAT · 17:00', venue:'테스트 파크', price:55000}
  ].map(show => ({...show, next:0, bucket:-1, admitted:0, queue:[], seats:Array.from({length:config.rows*config.columns},(_,i)=>({id:`${String.fromCharCode(65+Math.floor(i/config.columns))}${String(i%config.columns+1).padStart(2,'0')}`,status:'available',holdId:null,orderId:null,version:0,price:show.price + (Math.floor(i/config.columns)<3?22000:0)}))}));
  return {id,createdAt:now,config,shows,holds:[],orders:[],keys:{},events:[],rates:{},revoked:{},running:true,
    metrics:{requests:0,success:0,errors:{},latencies:[],blockedBot:0,blockedHuman:0,botRequests:0,humanRequests:0}};
}
const showOf = (s,id) => s.shows.find(x=>x.id===id) || fail('SHOW','공연을 찾을 수 없습니다.',404);
const validUser = (s,u) => { if (!/^user\d{5}$/.test(u || '') || +u.slice(4)<1 || +u.slice(4)>s.config.accounts) fail('ACCOUNT','등록된 테스트 계정을 사용하세요.',401); };
const queueOf = (show,u) => show.queue.find(q=>q.user===u && ['waiting','admitted'].includes(q.status));
function release(s,h,status) {
  for (const seat of showOf(s,h.show).seats) if(seat.holdId===h.id && seat.status==='held') Object.assign(seat,{status:'available',holdId:null,version:seat.version+1});
  h.status=status;
}
export function tick(s,now) {
  for(const h of s.holds) if(h.status==='active' && h.expiresAt<=now) release(s,h,'expired');
  // Durable payment jobs: recovery after server restart uses the same event identifier.
  for(const o of s.orders) if(['processing','unknown'].includes(o.status) && o.dueAt<=now) {settle(s,o,now);if(o.scenario==='duplicate')settle(s,o,now);}
  for(const sh of s.shows) {
    for(const q of sh.queue) {
      if(q.status==='waiting' && q.lastSeen+s.config.graceSeconds*1000<=now) q.status='expired';
      if(q.status==='admitted' && q.expiresAt<=now) q.status='expired';
    }
    const second=Math.floor(now/1000);
    if(sh.bucket!==second) {sh.bucket=second;sh.admitted=0;}
    if(s.config.paused || !s.running || now<s.config.openAt) continue;
    let active=sh.queue.filter(q=>q.status==='admitted').length;
    for(const q of sh.queue) if(q.status==='waiting' && active<s.config.capacity && sh.admitted<s.config.admitPerSecond) {
      q.status='admitted';q.expiresAt=now+s.config.sessionSeconds*1000;active++;sh.admitted++;
    }
  }
}
function admitted(s,show,user,now) {
  if(!s.running || s.config.salesPaused) fail('SALES_PAUSED','신규 예매가 중지되었습니다.');
  if(now<s.config.openAt) fail('NOT_OPEN','아직 예매 시작 전입니다.');
  const q=queueOf(show,user);
  if(!q || q.status!=='admitted' || q.expiresAt<=now) fail('ENTRY_REQUIRED','대기열에 등록하여 입장 자격을 받아 주세요.',403);
  return q;
}
function settle(s,o,now) {
  if(o.eventApplied) return;
  const h=s.holds.find(h=>h.id===o.holdId);
  o.eventApplied=true;o.eventId=`payment:${o.id}`;
  if(o.scenario==='failure') {o.status='failed';if(h?.status==='active') release(s,h,'released');return;}
  const sh=showOf(s,o.show);
  if(!h || h.status!=='active' || h.expiresAt<=now || !o.seats.every(id=>sh.seats.some(x=>x.id===id && x.holdId===h.id && x.status==='held'))) {
    o.status='refunded';o.compensation='모의 결제 성공이 점유 만료 후 도착하여 모의 환불 처리';return;
  }
  for(const id of o.seats) Object.assign(sh.seats.find(x=>x.id===id),{status:'sold',orderId:o.id,version:sh.seats.find(x=>x.id===id).version+1});
  h.status='sold';o.status='confirmed';o.confirmedAt=now;
  const q=queueOf(sh,o.user);if(q) q.status='completed';
}
export function snapshot(s,user,now) {
  return {runId:s.id,serverTime:now,running:s.running,config:s.config,
    shows:s.shows.map(sh=>({id:sh.id,title:sh.title,subtitle:sh.subtitle,date:sh.date,venue:sh.venue,price:sh.price,
      available:sh.seats.filter(x=>x.status==='available').length,total:sh.seats.length,
      waiting:sh.queue.filter(q=>q.status==='waiting').length,active:sh.queue.filter(q=>q.status==='admitted').length,
      queue:(()=>{const q=queueOf(sh,user);return q?{...q,ahead:sh.queue.filter(x=>x.status==='waiting' && x.number<q.number).length}:null;})(),
      seats:sh.seats.map(x=>({id:x.id,price:x.price,status:x.status,version:x.version,mine:s.holds.some(h=>h.id===x.holdId && h.user===user && h.status==='active')}))})),
    holds:s.holds.filter(h=>h.user===user),orders:s.orders.filter(o=>o.user===user)};
}
export function command(s,action,data,user,now,id) {
  validUser(s,user);
  if(action==='state') return snapshot(s,user,now);
  if(action==='logout') return {ok:true};
  const sh=data.show?showOf(s,data.show):null;
  if(action==='queue') {
    if(!sh) fail('SHOW','공연을 선택하세요.',400);
    if(!s.running) fail('STOPPED','테스트 실행이 중지되었습니다.');
    if(now<s.config.openAt) fail('NOT_OPEN','아직 예매 시작 전입니다.');
    if(s.config.challenge && data.answer!=='TEST') fail('CHALLENGE','테스트 인증란에 TEST를 입력하세요.',403);
    let q=queueOf(sh,user);
    if(!q){q={user,number:++sh.next,status:'waiting',lastSeen:now,createdAt:now};sh.queue.push(q);}
    q.lastSeen=now;tick(s,now);return snapshot(s,user,now);
  }
  if(action==='heartbeat') {if(sh){const q=queueOf(sh,user);if(q) q.lastSeen=now;}return snapshot(s,user,now);}
  if(action==='leave') {if(sh){const q=queueOf(sh,user);if(q)q.status='left';for(const h of s.holds)if(h.user===user&&h.show===sh.id&&h.status==='active'&&!s.orders.some(o=>o.holdId===h.id&&['processing','unknown'].includes(o.status)))release(s,h,'released');}return {ok:true};}
  if(action==='hold') {
    if(!sh)fail('SHOW','공연을 선택하세요.',400);admitted(s,sh,user,now);
    if(!Array.isArray(data.seats)||!data.seats.length||new Set(data.seats).size!==data.seats.length||data.seats.length>s.config.limit)fail('SEATS','좌석 선택과 구매 한도를 확인하세요.',400);
    if(s.holds.some(h=>h.user===user&&h.show===sh.id&&h.status==='active'))fail('HOLD_EXISTS','기존 점유를 해제한 후 다시 선택하세요.');
    const purchased=s.orders.filter(o=>o.user===user&&o.show===sh.id&&o.status==='confirmed').reduce((n,o)=>n+o.seats.length,0);
    if(purchased+data.seats.length>s.config.limit)fail('LIMIT','계정별 구매 한도를 초과했습니다.');
    const seats=data.seats.map(id=>sh.seats.find(x=>x.id===id));
    if(seats.some(x=>!x))fail('SEATS','존재하지 않는 좌석입니다.',400);
    if(seats.some(x=>x.status!=='available'))fail('SEAT_TAKEN','다른 사용자가 먼저 확보한 좌석입니다. 새로 선택하세요.');
    const h={id,user,show:sh.id,seats:[...data.seats].sort(),status:'active',expiresAt:now+s.config.holdSeconds*1000,createdAt:now};
    s.holds.push(h);for(const seat of seats)Object.assign(seat,{status:'held',holdId:id,version:seat.version+1});return h;
  }
  if(action==='release') {
    const h=s.holds.find(x=>x.id===data.holdId&&x.user===user);
    if(!h)fail('HOLD','점유를 찾을 수 없습니다.',404);
    if(s.orders.some(o=>o.holdId===h.id&&['processing','unknown'].includes(o.status)))fail('PAYMENT_PENDING','결제 결과를 확인한 후 다시 시도하세요.');
    if(h.status==='active')release(s,h,'released');return {ok:true};
  }
  if(action==='pay') {
    if(typeof data.key!=='string'||data.key.length<8||data.key.length>100)fail('KEY','8~100자 멱등성 키가 필요합니다.',400);
    const key=`${user}:${data.key}`, hash=JSON.stringify([data.holdId,data.scenario]);
    if(s.keys[key]) {if(s.keys[key].hash!==hash)fail('IDEMPOTENCY_CONFLICT','같은 키에 다른 요청을 사용할 수 없습니다.');return s.orders.find(o=>o.id===s.keys[key].orderId);}
    const h=s.holds.find(x=>x.id===data.holdId&&x.user===user);
    if(!h||h.status!=='active'||h.expiresAt<=now)fail('HOLD_EXPIRED','점유가 만료되었습니다. 좌석을 다시 선택하세요.');
    const show=showOf(s,h.show);admitted(s,show,user,now);
    if(s.orders.some(o=>o.holdId===h.id))fail('ORDER_EXISTS','이미 주문이 생성된 점유입니다. 예매 내역에서 확인하세요.');
    if(!['success','failure','delay','timeout','duplicate','lost'].includes(data.scenario))fail('SCENARIO','지원하지 않는 결제 시나리오입니다.',400);
    const o={id,user,show:show.id,holdId:h.id,seats:[...h.seats],amount:h.seats.reduce((n,id)=>n+show.seats.find(x=>x.id===id).price,0),
      scenario:data.scenario,status:data.scenario==='timeout'?'unknown':'processing',createdAt:now,dueAt:now+(['delay','timeout'].includes(data.scenario)?15000:500),eventApplied:false};
    s.orders.push(o);s.keys[key]={hash,orderId:id};return o;
  }
  if(action==='cancel') {
    const o=s.orders.find(x=>x.id===data.orderId&&x.user===user);
    if(!o)fail('ORDER','예매를 찾을 수 없습니다.',404);
    if(o.status==='cancelled')return o;
    if(o.status!=='confirmed')fail('ORDER_STATUS','확정된 예매만 취소할 수 있습니다.');
    o.status='cancelled';o.cancelledAt=now;
    for(const seat of showOf(s,o.show).seats)if(seat.orderId===o.id)Object.assign(seat,{status:'available',orderId:null,holdId:null,version:seat.version+1});
    return o;
  }
  fail('ACTION','알 수 없는 요청입니다.',404);
}
export function audit(s) {
  const problems=[];
  for(const sh of s.shows) {
    const active=sh.queue.filter(q=>['waiting','admitted'].includes(q.status));
    if(new Set(active.map(q=>q.user)).size!==active.length)problems.push(`${sh.id}: duplicate queue`);
    if(new Set(sh.queue.map(q=>q.number)).size!==sh.queue.length)problems.push(`${sh.id}: duplicate sequence`);
    if(sh.queue.filter(q=>q.status==='admitted').length>s.config.capacity)problems.push(`${sh.id}: capacity`);
    for(const seat of sh.seats) {
      const orders=s.orders.filter(o=>o.show===sh.id&&o.status==='confirmed'&&o.seats.includes(seat.id));
      const holds=s.holds.filter(h=>h.show===sh.id&&h.status==='active'&&h.seats.includes(seat.id));
      if(orders.length+holds.length>1)problems.push(`${sh.id}/${seat.id}: multiple owners`);
      if((seat.status==='sold')!==(orders.length===1)|| (orders.length===1&&seat.orderId!==orders[0].id))problems.push(`${sh.id}/${seat.id}: order mismatch`);
      if((seat.status==='held')!==(holds.length===1)|| (holds.length===1&&seat.holdId!==holds[0].id))problems.push(`${sh.id}/${seat.id}: hold mismatch`);
    }
    const totals={};for(const o of s.orders)if(o.show===sh.id&&o.status==='confirmed')totals[o.user]=(totals[o.user]||0)+o.seats.length;
    if(Object.values(totals).some(n=>n>s.config.limit))problems.push(`${sh.id}: purchase limit`);
  }
  return problems;
}
export function report(s) {
  const sorted=[...s.metrics.latencies].sort((a,b)=>a-b);
  return {runId:s.id,createdAt:s.createdAt,config:s.config,running:s.running,metrics:{...s.metrics,latencies:undefined,p95:sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]||0},
    violations:audit(s),counts:{orders:s.orders.length,confirmed:s.orders.filter(o=>o.status==='confirmed').length,waiting:s.shows.reduce((n,x)=>n+x.queue.filter(q=>q.status==='waiting').length,0)},events:s.events};
}
