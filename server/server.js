'use strict';
const {WebSocketServer,WebSocket}=require('ws');
const {randomUUID,randomBytes,scrypt:asyncScrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {readFile,writeFile,rename,mkdir}=require('node:fs/promises');
const path=require('node:path');
const scrypt=promisify(asyncScrypt);
const dataDir=path.join(__dirname,'data');
const usersFile=path.join(dataDir,'users.json');
let users=Object.create(null);
const sessions=new Map();
let saveQueue=Promise.resolve();
async function saveUsers(){const snapshot=JSON.stringify(users,null,2);saveQueue=saveQueue.catch(()=>{}).then(async()=>{await mkdir(dataDir,{recursive:true});const temp=usersFile+'.tmp';await writeFile(temp,snapshot,{mode:0o600});await rename(temp,usersFile)});return saveQueue}
async function hashPassword(password,salt=randomBytes(16).toString('hex')){const hash=await scrypt(password,salt,64);return {salt,hash:hash.toString('hex')}}
async function verifyPassword(password,user){const hash=await scrypt(password,user.salt,64);const saved=Buffer.from(user.hash,'hex');return saved.length===hash.length&&timingSafeEqual(saved,hash)}
function publicUser(user){return {username:user.username,nickname:user.nickname||user.username,photo:user.photo||null,created_at:user.created_at}}
function issueToken(ws,user){const token=randomBytes(32).toString('hex');sessions.set(token,{username:user.username,ws,expires:Date.now()+12*60*60*1000});return token}
function sessionFor(ws,token){const entry=sessions.get(token);if(!entry)return null;if(entry.expires<Date.now()){sessions.delete(token);return null}if(entry.ws&&entry.ws!==ws&&entry.ws.readyState===WebSocket.OPEN)return null;entry.ws=ws;return users[entry.username.toLowerCase()]||null}
function clearSocketSessions(ws){for(const [token,entry] of sessions)if(entry.ws===ws)sessions.delete(token)}
function detachSocketSessions(ws){for(const entry of sessions.values())if(entry.ws===ws)entry.ws=null}
const forbidden=['씨발','새끼','시발','병신','좆','장애','게이','최민서'];
function validNickname(name){return typeof name==='string'&&name.trim().length>=2&&[...name.trim()].length<=24&&!forbidden.some(x=>name.replace(/\s/g,'').toLowerCase().includes(x))&&!/[<>\u0000-\u001f]/.test(name)}
const historyFile=path.join(dataDir,'history.json');let history=Object.create(null);let historyQueue=Promise.resolve();
function saveHistory(){const snapshot=JSON.stringify(history);historyQueue=historyQueue.catch(()=>{}).then(async()=>{await mkdir(dataDir,{recursive:true});await writeFile(historyFile+'.tmp',snapshot,{mode:0o600});await rename(historyFile+'.tmp',historyFile)});return historyQueue}
function storeHistory(username,record){if(!username)return;const key=username.toLowerCase();history[key]||=[];history[key].unshift(record);history[key]=history[key].slice(0,50);saveHistory().catch(console.error)}
const attempts=new Map();
function authAllowed(ws){const now=Date.now(),a=attempts.get(ws)||[];const recent=a.filter(t=>now-t<60000);recent.push(now);attempts.set(ws,recent);return recent.length<=10}

const port=Number(process.env.PORT||8080);
const wss=new WebSocketServer({noServer:true,maxPayload:256*1024});
const players=new Map(), waiting=[], rooms=new Map();
const send=(ws,obj)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))};
const validMinutes=v=>Number.isInteger(v)&&v>=5&&v<=60&&v%5===0;
function score(distanceM,elapsedMs){const d=distanceM/1000,v=elapsedMs>0?d/(elapsedMs/3600000):0;return Math.round(100*d*(0.7+0.3*Math.min(v/12,1)))}
function unqueue(ws){const i=waiting.indexOf(ws);if(i>=0)waiting.splice(i,1)}
function profileForSocket(ws){for(const entry of sessions.values()){if(entry.ws===ws&&entry.expires>Date.now()){const u=users[entry.username.toLowerCase()];if(u)return {nickname:u.nickname||u.username,photo:u.photo||null}}}return {nickname:'게스트 러너',photo:null}}
function notify(room,obj){room.sides.forEach(side=>send(side.ws,obj))}
function stateOf(ws){const p=players.get(ws);return p?.room?rooms.get(p.room):null}
function closeRoom(room,reason='매칭 취소됨'){
  if(!room||room.done)return;room.done=true;clearTimeout(room.timer);clearTimeout(room.disconnectTimer);
  rooms.delete(room.id);room.sides.forEach(side=>{const p=players.get(side.ws);if(p&&p.room===room.id)p.room=null;send(side.ws,{type:'match_cancelled',message:reason})});
}
function finishRoom(room,forfeitIndex=null){
 if(!room||room.done||room.phase!=='running')return;
 room.done=true;clearTimeout(room.timer);clearTimeout(room.disconnectTimer);
 const now=Date.now();const elapsed=Math.min(room.durationMs,Math.max(0,now-room.startedAt));
 const scores=room.sides.map(side=>score(side.distance,elapsed));
 const winner=forfeitIndex!==null?1-forfeitIndex:scores[0]===scores[1]?-1:scores[0]>scores[1]?0:1;
 room.sides.forEach((side,i)=>{const other=room.sides[1-i];const outcome=winner===-1?'draw':winner===i?'win':'lose';const record={id:randomUUID(),date:new Date().toISOString(),mode:'온라인 1대1',distance:side.distance/1000,elapsed,speed:elapsed?side.distance/1000/(elapsed/3600000):0,score:scores[i],opponent_score:scores[1-i],outcome,reason:forfeitIndex===null?'time_limit':'forfeit',splits:side.splits||[],route:side.shareRoute?side.route:[],opponent_route:other.shareRoute?other.route:[],opponent_nickname:other.nickname||'상대'};
   storeHistory(side.username,record);
   send(side.ws,{type:'match_result',room_id:room.id,my_score:scores[i],opponent_score:scores[1-i],my_distance_m:side.distance,opponent_distance_m:other.distance,elapsed_ms:elapsed,outcome,reason:record.reason,forfeited:forfeitIndex===i,record});
 });
 rooms.delete(room.id);room.sides.forEach(side=>{const p=players.get(side.ws);if(p&&p.room===room.id)p.room=null});
}
function disconnectPlayer(ws){unqueue(ws);const room=stateOf(ws);if(!room)return;const side=room.sides.find(x=>x.ws===ws);if(!side)return;
 if(room.phase!=='running'){closeRoom(room,'상대가 연결을 종료했습니다.');return}
 side.ws=null;side.disconnectedAt=Date.now();const other=room.sides.find(x=>x!==side);send(other.ws,{type:'opponent_disconnected',message:'상대 연결 끊김 · 15초 재접속 대기'});
 clearTimeout(room.disconnectTimer);room.disconnectTimer=setTimeout(()=>{if(!room.done&&side.disconnectedAt)finishRoom(room,room.sides.indexOf(side))},15000);
}
function startCountdown(room){room.phase='countdown';room.startedAt=Date.now()+3500;notify(room,{type:'match_countdown',started_at:room.startedAt,duration_ms:room.durationMs});room.timer=setTimeout(()=>{if(room.done)return;room.phase='running';notify(room,{type:'match_started',started_at:room.startedAt,duration_ms:room.durationMs});room.timer=setTimeout(()=>finishRoom(room),room.durationMs)},3500)}
// Detect terminated apps even if TCP never reports a clean close.
// A screen-off phone with a healthy WebSocket remains connected.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { ws.terminate(); }
  }
}, 10000);
wss.on('close', () => clearInterval(heartbeat));
wss.on('connection',ws=>{
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const id=randomUUID();players.set(ws,{id,room:null,lastUpdate:0});
  send(ws,{type:'server_info',message:'Running Arena 서버 연결 완료'});
  ws.on('message',async raw=>{
    let msg;try{msg=JSON.parse(raw.toString())}catch{return send(ws,{type:'error',message:'잘못된 JSON'})}
    if(!msg||typeof msg.type!=='string')return;
    const p=players.get(ws);if(!p)return;
    if(msg.type==='hello')return send(ws,{type:'hello_ack',protocol:1,server_time:Date.now()});
    if(msg.type==='auth_register'||msg.type==='auth_login'){
      if(!authAllowed(ws))return send(ws,{type:'auth_error',message:'요청이 너무 많습니다. 잠시 후 다시 시도하세요.'});
      const username=String(msg.username||'').trim(),password=String(msg.password||'');
      if(!/^[A-Za-z0-9_]{3,20}$/.test(username)||password.length<8||password.length>128)return send(ws,{type:'auth_error',message:'아이디 또는 비밀번호 형식이 올바르지 않습니다.'});
      const key=username.toLowerCase();
      try{
        if(msg.type==='auth_register'){
          if(users[key])return send(ws,{type:'auth_error',message:'이미 사용 중인 아이디입니다.'});
          const hashed=await hashPassword(password);
          // Re-check after asynchronous password hashing to prevent duplicate registration.
          if(users[key])return send(ws,{type:'auth_error',message:'이미 사용 중인 아이디입니다.'});
          const user={username,nickname:null,photo:null,...hashed,created_at:new Date().toISOString()};users[key]=user;
          try{await saveUsers()}catch(e){delete users[key];throw e}
          clearSocketSessions(ws);return send(ws,{type:'auth_success',token:issueToken(ws,user),user:publicUser(user)});
        }
        const user=users[key];if(!user||!await verifyPassword(password,user))return send(ws,{type:'auth_error',message:'아이디 또는 비밀번호가 올바르지 않습니다.'});
        clearSocketSessions(ws);return send(ws,{type:'auth_success',token:issueToken(ws,user),user:publicUser(user)});
      }catch(e){console.error('auth error:',e.message);return send(ws,{type:'auth_error',message:'서버 인증 처리에 실패했습니다.'})}
    }
    if(msg.type==='auth_me'){const user=sessionFor(ws,String(msg.token||''));return send(ws,{type:'auth_me',user:user?publicUser(user):null})}
    if(msg.type==='profile_update'||msg.type==='account_update'||msg.type==='account_delete'||msg.type==='history_list'||msg.type==='practice_save'){
      const user=sessionFor(ws,String(msg.token||''));if(!user)return send(ws,{type:'profile_error',message:'로그인이 필요합니다.'});
      if(msg.type==='history_list')return send(ws,{type:'history_data',records:history[user.username.toLowerCase()]||[]});
      if(msg.type==='practice_save'){
        const r=msg.record;if(!r||typeof r!=='object')return;
        const distance=Number(r.distance),elapsed=Number(r.elapsed);
        if(!Number.isFinite(distance)||distance<0||distance>20||!Number.isFinite(elapsed)||elapsed<0||elapsed>86400000)return;
        storeHistory(user.username,{id:randomUUID(),date:new Date().toISOString(),mode:'개인 연습',distance,elapsed,speed:elapsed?distance/(elapsed/3600000):0,score:score(distance*1000,elapsed),splits:Array.isArray(r.splits)?r.splits.slice(0,100):[],route:Array.isArray(r.route)?r.route.slice(0,600).filter(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)).map(p=>p.map(v=>Number(v.toFixed(4)))):[],opponent_route:[]});return send(ws,{type:'history_saved'});
      }
      if(msg.type==='profile_update'){
        if(!validNickname(msg.nickname))return send(ws,{type:'profile_error',message:'닉네임은 2~24자이며 금지된 표현을 사용할 수 없습니다.'});
        if(msg.photo!==null&&msg.photo!==undefined&&(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(msg.photo)||msg.photo.length>130000))return send(ws,{type:'profile_error',message:'사진 형식 또는 용량이 올바르지 않습니다.'});
        user.nickname=msg.nickname.trim();if(msg.photo!==undefined)user.photo=msg.photo;await saveUsers();return send(ws,{type:'profile_saved',user:publicUser(user)});
      }
      if(msg.type==='account_delete'){const key=user.username.toLowerCase();delete users[key];delete history[key];clearSocketSessions(ws);await Promise.all([saveUsers(),saveHistory()]);return send(ws,{type:'account_deleted'})}
      if(msg.type==='account_update'){
        if(msg.username){const newId=String(msg.username).trim(),key=newId.toLowerCase(),old=user.username.toLowerCase();if(!/^[A-Za-z0-9_]{3,20}$/.test(newId)||users[key]&&key!==old)return send(ws,{type:'profile_error',message:'사용할 수 없는 아이디입니다.'});delete users[old];users[key]=user;user.username=newId;if(history[old]){history[key]=history[old];delete history[old];await saveHistory()}for(const entry of sessions.values())if(entry.username.toLowerCase()===old)entry.username=newId;}
        if(msg.password){if(String(msg.password).length<8||String(msg.password).length>128)return send(ws,{type:'profile_error',message:'비밀번호는 8~128자여야 합니다.'});Object.assign(user,await hashPassword(String(msg.password)))}
        await saveUsers();return send(ws,{type:'account_updated',user:publicUser(user)});
      }
    }
    if(msg.type==='auth_logout'){const token=String(msg.token||'');if(sessions.get(token)?.ws===ws)sessions.delete(token);return send(ws,{type:'auth_logout'})}

    if(msg.type==='match_resume'){
      const room=rooms.get(String(msg.room_id||''));
      if(!room||room.done||room.phase!=='running')return send(ws,{type:'resume_error',message:'재접속 가능한 경기가 없습니다.'});
      const side=room.sides.find(x=>x.ws===null&&x.resumeKey===msg.resume_key&&x.disconnectedAt);
      if(!side)return send(ws,{type:'resume_error',message:'재접속 인증 실패'});
      side.ws=ws;side.disconnectedAt=null;p.room=room.id;
      clearTimeout(room.disconnectTimer);room.disconnectTimer=null;
      send(ws,{type:'match_resumed',room_id:room.id,started_at:room.startedAt,duration_ms:room.durationMs,distance_m:side.distance});
      notify(room,{type:'opponent_reconnected'});return;
    }
    if(msg.type==='match_request'){
      if(p.room||waiting.includes(ws))return send(ws,{type:'match_error',message:'이미 매칭 중입니다.'});
      if(msg.mode!=='duel')return send(ws,{type:'match_error',message:'현재 서버는 1대1만 지원합니다.'});
      let other=null;while(waiting.length&&!other){const candidate=waiting.shift();if(candidate!==ws&&candidate.readyState===WebSocket.OPEN&&!players.get(candidate)?.room)other=candidate}
      if(!other){waiting.push(ws);return send(ws,{type:'match_waiting'})}
      const op=players.get(other);if(!op)return send(ws,{type:'match_error',message:'매칭 상대 오류'});
      const room={id:randomUUID().slice(0,8),phase:'negotiate',round:0,sides:[{ws,username:null,nickname:null,resumeKey:randomBytes(24).toString('hex'),choice:null,ready:false,distance:0,elapsed:0,lastDistanceAt:0,route:[],splits:[],shareRoute:false},{ws:other,username:null,nickname:null,resumeKey:randomBytes(24).toString('hex'),choice:null,ready:false,distance:0,elapsed:0,lastDistanceAt:0,route:[],splits:[],shareRoute:false}],done:false,timer:null,disconnectTimer:null,durationMs:0,startedAt:0};
      rooms.set(room.id,room);p.room=room.id;op.room=room.id;
      room.sides.forEach((side,i)=>send(side.ws,{type:'match_found',room_id:room.id,resume_key:side.resumeKey,opponent:profileForSocket(room.sides[1-i].ws)}));return;
    }
    if(msg.type==='match_cancel'){const room=stateOf(ws);if(room&&room.phase!=='running')closeRoom(room,'플레이어가 매칭을 취소했습니다.');else {unqueue(ws);send(ws,{type:'match_cancelled',message:'매칭 대기가 취소되었습니다.'})}return}
    const room=stateOf(ws);if(!room||msg.room_id!==room.id)return;
    const index=room.sides.findIndex(x=>x.ws===ws),side=room.sides[index];if(index<0)return;
    if(msg.type==='time_choice'&&room.phase==='negotiate'){
      if(!validMinutes(msg.minutes)||side.choice!==null)return;
      side.choice=msg.minutes;send(ws,{type:'time_choice_saved'});
      if(room.sides.every(x=>x.choice!==null)){
        const [a,b]=room.sides.map(x=>x.choice);const diff=Math.abs(a-b);
        if(diff>15){room.phase='conflict';notify(room,{type:'time_conflict',a_minutes:a,b_minutes:b,round:room.round,retries_left:2-room.round});}
        else{room.durationMs=(a+b)*30000;room.phase='ready';notify(room,{type:'time_agreed',a_minutes:a,b_minutes:b,duration_ms:room.durationMs});}
      }return;
    }
    if(msg.type==='time_retry'&&room.phase==='conflict'){
      if(room.round>=2)return;
      side.ready=true;send(ws,{type:'time_retry_saved'});
      if(room.sides.every(x=>x.ready)){room.round++;room.phase='negotiate';room.sides.forEach(x=>{x.choice=null;x.ready=false});notify(room,{type:'time_retry_start',round:room.round})}return;
    }
    if(msg.type==='match_ready'&&room.phase==='ready'){
      side.ready=true;side.shareRoute=msg.share_route===true;const u=sessionFor(ws,String(msg.token||''));side.username=u?.username||null;side.nickname=u?.nickname||u?.username||'게스트';notify(room,{type:'ready_update',ready:room.sides.map(x=>x.ready)});
      if(room.sides.every(x=>x.ready))startCountdown(room);return;
    }
    if(msg.type==='run_update'&&room.phase==='running'){
      const now=Date.now();if(now-p.lastUpdate<700)return;p.lastUpdate=now;
      const elapsed=Math.min(room.durationMs,Math.max(0,now-room.startedAt));
      const claimed=Number(msg.distance_m);
      if(!Number.isFinite(claimed)||claimed<0||claimed>1e7)return;
      // Server-side anti-cheat: limit per-update progress, never trust client score/time.
      const dt=side.lastDistanceAt?Math.max(0,(now-side.lastDistanceAt)/1000):Math.max(0,elapsed/1000);
      const maxIncrease=6*dt+3;
      if(claimed>side.distance+maxIncrease){send(ws,{type:'anti_cheat_warning',message:'비정상적으로 빠른 이동이 감지되어 거리 증가가 제한됐습니다.'});}
      side.distance=Math.max(side.distance,Math.min(claimed,side.distance+maxIncrease));side.lastDistanceAt=now;side.elapsed=elapsed;
      if(side.shareRoute&&Array.isArray(msg.route_point)&&side.route.length<600&&now-(side.lastRouteAt||0)>4000){const [lat,lon]=msg.route_point.map(Number);if(Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180){side.route.push([Number(lat.toFixed(4)),Number(lon.toFixed(4))]);side.lastRouteAt=now}}
      if(Array.isArray(msg.splits))side.splits=msg.splits.filter(x=>Number.isFinite(x)&&x>=0&&x<3600000).slice(0,100);
      send(room.sides[1-index].ws,{type:'opponent_update',room_id:room.id,distance_m:side.distance,elapsed_ms:elapsed,score:score(side.distance,elapsed)});return;
    }
    if(msg.type==='run_forfeit'&&room.phase==='running'){
      const now=Date.now(),elapsed=Math.min(room.durationMs,Math.max(0,now-room.startedAt));
      side.elapsed=elapsed; // final score uses last server-validated distance only
      finishRoom(room,index);return;
    }

  });
  ws.on('close',()=>{disconnectPlayer(ws);players.delete(ws);detachSocketSessions(ws);attempts.delete(ws)});
  ws.on('error',err=>console.error('WebSocket:',err.message));
});
(async()=>{try{history=JSON.parse(await readFile(historyFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}try{users=JSON.parse(await readFile(usersFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}const {createServer}=require('node:http');const http=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('Running Arena WebSocket server')});http.on('upgrade',(req,socket,head)=>{wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req))});http.listen(port,'0.0.0.0',()=>console.log(`Running Arena server ready on ws://0.0.0.0:${port}`))})().catch(e=>{console.error('Cannot load user database:',e);process.exit(1)});
