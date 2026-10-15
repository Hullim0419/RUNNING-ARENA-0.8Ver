'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const KEY='running-arena-records-v3', SERVER_KEY='running-arena-server-url', SESSION_KEY='running-arena-session';
  const modes={'1대1':'duel','팀전':'team','배틀로얄':'royale'};
  let mode='1대1', running=false, watchId=null, timer=null, startAt=0, elapsedMs=0, distanceM=0, lastPoint=null, lastFix=0;
  let socket=null, socketUrl='', connecting=null, roomId=null, opponentScore=null, lastSent=0, matchmaking=false, matchRequestPending=false;
  let routePoints=[],splitTimes=[],nextSplit=1000,routeShare=false,historyServer=[];let gameDuration=0, gameStartedAt=0, gameFinished=false, onlineActive=false, resultTimers=[], antiFlags=0, resumeKey=null;
  const uid=(()=>{try{let v=localStorage.getItem('ra-uid');if(!v){v=crypto.randomUUID?crypto.randomUUID():'runner-'+Date.now();localStorage.setItem('ra-uid',v)}return v}catch{return 'guest-'+Date.now()}})();
  $('serverUrl').value=localStorage.getItem(SERVER_KEY)||'';
  let authMode='login', authToken=null, authUser=null, authPending=null, authTimeout=null;
  try { const saved=JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null'); if(saved?.token)authToken=saved.token; } catch {}
  function authStatus(message, error=false){$('authMessage').textContent=message;$('authMessage').classList.toggle('error',error)}
  function renderAuth(){const logged=Boolean(authUser&&authToken);$('guestPanel').classList.toggle('hidden',logged);$('userPanel').classList.toggle('hidden',!logged);if(logged)$('signedInName').textContent=authUser.nickname||authUser.username;}
  function setSession(token,user){authToken=token;authUser=user;try{if(token)sessionStorage.setItem(SESSION_KEY,JSON.stringify({token}));else sessionStorage.removeItem(SESSION_KEY)}catch{}renderAuth()}
  function authReply(msg){if(msg.type==='auth_success'){setSession(msg.token,msg.user);$('accountPassword').value='';$('accountConfirm').value='';authStatus('환영합니다, '+msg.user.username+'님! 로그인 완료.');afterLogin();}
    else if(msg.type==='auth_me'){if(msg.user){authUser=msg.user;renderAuth();authStatus('로그인 세션을 복원했습니다.');refreshProfile();requestHistory()}else{setSession(null,null);authStatus('로그인 세션이 만료됐습니다. 다시 로그인해 주세요.',true)}}
    else if(msg.type==='auth_error'){authStatus(msg.message||'계정 요청 실패',true)}
    else if(msg.type==='auth_logout'){setSession(null,null);authStatus('로그아웃했습니다. 게스트 모드로 계속 사용할 수 있습니다.')}
    if(['auth_success','auth_me','auth_error','auth_logout'].includes(msg.type)&&authPending){clearTimeout(authTimeout);const resolve=authPending;authPending=null;resolve(msg.type!=='auth_error')}
  }
  function waitAuth(){return new Promise(resolve=>{authPending=resolve;authTimeout=setTimeout(()=>{if(authPending===resolve){authPending=null;authStatus('서버 인증 응답 시간이 초과됐습니다.',true);resolve(false)}},8000)})}
  async function submitAuth(){const username=$('accountName').value.trim(),password=$('accountPassword').value;
    if(!/^[A-Za-z0-9_]{3,20}$/.test(username)){authStatus('아이디는 영문·숫자·밑줄 3~20자로 입력해 주세요.',true);return}
    if(password.length<8||password.length>128){authStatus('비밀번호는 8~128자로 입력해 주세요.',true);return}
    if(authMode==='register'&&password!==$('accountConfirm').value){authStatus('비밀번호 확인이 일치하지 않습니다.',true);return}
    $('authSubmit').disabled=true;authStatus('서버에 연결하는 중…');
    try{if(!await connect()){authStatus('서버 연결 없음 · 회원가입/로그인은 서버 실행 후 사용할 수 있습니다.',true);return}
      const promise=waitAuth();send({type:authMode==='register'?'auth_register':'auth_login',username,password});await promise;
    }finally{$('authSubmit').disabled=false}
  }
  function switchAuth(mode){authMode=mode;$('loginTab').classList.toggle('selected',mode==='login');$('registerTab').classList.toggle('selected',mode==='register');$('confirmGroup').classList.toggle('hidden',mode!=='register');$('authSubmit').textContent=mode==='register'?'회원가입':'Running Arena 로그인';$('accountPassword').autocomplete=mode==='register'?'new-password':'current-password';authStatus(mode==='register'?'서버에서 계정을 생성합니다.':'서버에서 계정을 확인합니다.')}
  $('loginTab').onclick=()=>switchAuth('login');$('registerTab').onclick=()=>switchAuth('register');
  $('authForm').onsubmit=e=>{e.preventDefault();submitAuth()};
  $('logoutBtn').onclick=()=>{if(socket?.readyState===WebSocket.OPEN&&authToken)send({type:'auth_logout',token:authToken});setSession(null,null);authStatus('로그아웃했습니다. 게스트 모드로 계속 사용할 수 있습니다.')};

  document.querySelectorAll('.mode:not(:disabled)').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.mode').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');mode=btn.dataset.mode;
  }));
  const timeFmt=ms=>{const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
  const score=()=>Math.round(100*(distanceM/1000)*(0.7+0.3*Math.min(speed()/12,1))); 
  const speed=()=>elapsedMs>0?(distanceM/1000)/(elapsedMs/3600000):0;
  function render(){
    $('distance').innerHTML=(distanceM/1000).toFixed(2)+' <span class="unit">km</span>';
    $('elapsed').innerHTML=timeFmt(elapsedMs)+' <span class="unit">min</span>';
    $('speed').innerHTML=speed().toFixed(1)+' <span class="unit">km/h</span>';
    $('score').innerHTML=score()+' <span class="unit">pts</span>';if($('liveMyScore'))$('liveMyScore').textContent=score()+' pts';
  }
  function hav(a,b){const rad=x=>x*Math.PI/180,R=6371000,dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);const v=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;return 2*R*Math.atan2(Math.sqrt(v),Math.sqrt(1-v))}
  function gpsError(t){$('gpsStatus').textContent=t;$('gpsDot').classList.remove('live')}
  function onPosition(p){
    const c=p.coords,now=p.timestamp||Date.now();
    if(c.mocked===true||!Number.isFinite(c.latitude)||!Number.isFinite(c.longitude)||!Number.isFinite(c.accuracy)||c.accuracy>40||c.accuracy<=0){antiFlags++;gpsError('GPS 오차가 커서 이동을 제외했습니다.');return}
    const point={lat:c.latitude,lon:c.longitude};
    if(lastPoint&&now>lastFix){const delta=hav(lastPoint,point),dt=(now-lastFix)/1000;if(delta>=2&&dt>=0.5&&delta/dt<=6){distanceM+=delta;if(distanceM>=nextSplit){splitTimes.push(elapsedMs);nextSplit+=1000;renderSplits()}}else if(delta>=2){antiFlags++;$('gpsStatus').textContent='이상 GPS 이동 감지 · 해당 기록 제외';}}
    lastPoint=point;lastFix=now;if(routePoints.length<2500&&(routePoints.length===0||hav({lat:routePoints.at(-1)[0],lon:routePoints.at(-1)[1]},point)>6)){routePoints.push([point.lat,point.lon]);drawMap('liveMap',routePoints)}$('gpsDot').classList.add('live');$('gpsStatus').textContent='GPS 연결 · 정확도 약 '+Math.round(c.accuracy)+'m';render();
  }
  function runStart(){
    if(gameType==='online'){gpsError('온라인 경기는 양쪽 READY 후 자동 시작됩니다.');return}
    if(!navigator.geolocation){gpsError('이 환경에서 GPS를 지원하지 않습니다.');return}
    if(!window.isSecureContext){gpsError('GPS를 사용하려면 HTTPS 또는 보안 앱 환경에서 열어 주세요.');return}
    running=true;startAt=Date.now()-elapsedMs;lastPoint=null;lastFix=0;routePoints=[];splitTimes=[];nextSplit=1000;renderSplits();
    $('runState').textContent='LIVE';$('startBtn').disabled=true;$('finishBtn').disabled=false;
    $('gpsStatus').textContent='GPS 위치 확인 중…';
    watchId=navigator.geolocation.watchPosition(onPosition,e=>gpsError(e.code===1?'위치 권한이 거부되었습니다.':e.code===2?'GPS 위치를 확인할 수 없습니다.':'GPS 응답 시간이 초과되었습니다.'),{enableHighAccuracy:true,maximumAge:1000,timeout:15000});
    timer=setInterval(()=>{elapsedMs=Date.now()-startAt;render();},500);
  }
  function records(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch{return []}}
  function renderRecords(){
    const list=authUser?historyServer:records();$('records').replaceChildren();
    if(!list.length){const d=document.createElement('div');d.className='small';d.textContent=authUser?'서버 전적이 없거나 아직 불러오지 못했습니다.':'아직 저장된 기록이 없습니다.';$('records').append(d);return}
    list.forEach(r=>{const d=document.createElement('div');d.className='record';const a=document.createElement('div');a.textContent=r.mode+' · '+Number(r.distance||0).toFixed(2)+'km · '+timeFmt(r.elapsed);const b=document.createElement('b');b.textContent=r.score+' pts'+(r.outcome?' · '+r.outcome.toUpperCase():'');d.append(a,b);d.onclick=()=>showRecord(r);$('records').append(d)})
  }
  function runFinish(){
    if(gameType==='online'){if(!onlineActive||gameFinished)return;if(confirm('지금 종료하면 점수와 관계없이 기권 패배합니다. 종료할까요?'))send({type:'run_forfeit',room_id:roomId,distance_m:Math.round(distanceM)});return}
    if(!running)return;
    elapsedMs=Date.now()-startAt;running=false;if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;clearInterval(timer);timer=null;
    $('runState').textContent='FINISHED';$('startBtn').disabled=false;$('finishBtn').disabled=true;$('gpsDot').classList.remove('live');$('gpsStatus').textContent='러닝 종료';render();
    const r={date:new Date().toISOString(),mode,distance:distanceM/1000,elapsed:elapsedMs,speed:speed(),score:score(),splits:[...splitTimes],route:[...routePoints],opponent_route:[]};if(authToken)send({type:'practice_save',token:authToken,record:{distance:r.distance,elapsed:r.elapsed,splits:r.splits,route:$('savePracticeRoute').checked?r.route:[]}});
    const list=records();list.unshift(r);try{localStorage.setItem(KEY,JSON.stringify(list.slice(0,20)))}catch{}
    $('resultTitle').textContent='러닝 기록 저장 완료';$('resultText').textContent=r.distance.toFixed(2)+'km · '+timeFmt(elapsedMs)+' · '+score()+'점';$('resultTag').textContent='SAVED';renderRecords();
    showRunResult();
  }
  function log(text){const el=$('netLog');el.textContent=new Date().toLocaleTimeString()+' '+text+'\n'+(el.textContent==='아직 통신 없음'?'':el.textContent).slice(0,1800)}
  function netStatus(text,connected=false){$('netStatus').textContent=text;$('netDot').classList.toggle('live',connected)}
  function matchStatus(text){$('matchMessage').textContent=text}
  function setMatchmaking(active){matchmaking=active;$('matchBtn').textContent=active?'매칭 취소':'온라인 매칭';$('matchBtn').classList.toggle('is-cancel',active);$('matchBtn').setAttribute('aria-pressed',String(active))}
  function cancelMatch(){matchRequestPending=false;setMatchmaking(false);send({type:'match_cancel',room_id:roomId});matchStatus('매칭을 취소했습니다.');}
  function send(obj){if(socket?.readyState!==WebSocket.OPEN)return false;socket.send(JSON.stringify(obj));log('→ '+obj.type);return true}
  function handleMessage(msg){
    if(!msg||typeof msg.type!=='string')return;
    log('← '+msg.type);
    if(msg.type.startsWith('auth_')){authReply(msg);return}
    if(msg.type==='profile_saved'||msg.type==='account_updated'){authUser=msg.user;refreshProfile();$('profileMessage').textContent='변경사항이 서버에 저장되었습니다.';$('accountSettingsStatus').textContent='계정 변경 완료';if(currentScreen==='nickname'){enterLobby();showWelcome()}}
    if(msg.type==='profile_error'){$('profileMessage').textContent=msg.message;$('nicknameError').textContent=msg.message;$('accountSettingsStatus').textContent=msg.message}
    if(msg.type==='account_deleted'){setSession(null,null);historyServer=[];showScreen('auth');alert('계정과 서버 전적이 삭제되었습니다.')}
    if(msg.type==='history_data'){historyServer=msg.records||[];renderRecords()}
    if(msg.type==='history_saved')requestHistory();
    if(msg.type==='hello_ack')netStatus('서버 연결됨 · 통신 정상',true);
    if(msg.type==='match_waiting'){if(!matchmaking){send({type:'match_cancel'});return}matchStatus('매칭 대기 중 · 다른 플레이어를 기다립니다.');}
    if(msg.type==='match_found'){if(!matchmaking){roomId=msg.room_id;send({type:'match_cancel',room_id:roomId});roomId=null;return}setMatchmaking(false);showOpponentIntro(msg.opponent);roomId=msg.room_id;resumeKey=msg.resume_key;gameFinished=false;onlineActive=false;opponentScore=0;$('negStatus').textContent='희망 시간을 선택하세요.';$('negActions').classList.add('hidden');$('submitMinutes').disabled=false;showScreen('negotiate');matchStatus('매칭 성공 · 시간 협상 시작');}
    if(msg.type==='time_choice_saved'){$('negStatus').textContent='선택 완료! 상대의 선택을 기다리는 중…';}
    if(msg.type==='time_conflict'){$('negStatus').textContent=`시간 차이 ${Math.abs(msg.a_minutes-msg.b_minutes)}분 (각각 ${msg.a_minutes}분 / ${msg.b_minutes}분). ${msg.retries_left>0?'재협상하거나 매칭을 취소하세요.':'재협상 횟수를 모두 사용했습니다. 매칭을 취소하세요.'}`;$('negActions').classList.remove('hidden');$('retryNeg').disabled=msg.retries_left<=0;}
    if(msg.type==='time_retry_saved'){$('negStatus').textContent='재협상 신청 완료 · 상대 동의 대기';$('retryNeg').disabled=true;}
    if(msg.type==='time_retry_start'){$('negRound').textContent=(msg.round+1)+'차 협상';$('negStatus').textContent='다시 희망 시간을 선택하세요.';$('submitMinutes').disabled=false;$('negActions').classList.add('hidden');}
    if(msg.type==='time_agreed'){gameDuration=msg.duration_ms;$('agreedTime').textContent='최종 경기 시간: '+timeFmt(gameDuration)+' · 두 플레이어 모두 READY를 눌러 주세요.';$('readyStatus').textContent=`협상 완료: ${msg.a_minutes}분 / ${msg.b_minutes}분 → ${timeFmt(gameDuration)}`;$('readyBtn').disabled=false;showScreen('ready');}
    if(msg.type==='ready_update'){$('readyStatus').textContent='준비 상태: '+msg.ready.filter(Boolean).length+' / 2';}
    if(msg.type==='match_countdown'){gameStartedAt=msg.started_at;gameDuration=msg.duration_ms;enterGame('online');$('gameCaption').textContent='준비 완료! 3 · 2 · 1 · GO!';$('gameLimit').textContent='경기 제한시간: '+timeFmt(gameDuration);$('startBtn').disabled=true;$('finishBtn').disabled=true;}
    if(msg.type==='match_started'){gameStartedAt=msg.started_at;gameDuration=msg.duration_ms;beginOnlineRun();}
    if(msg.type==='opponent_update'){$('liveOpponentScore').textContent=(Number(msg.score)||0)+' pts';opponentScore=Number(msg.score)||0;}
    if(msg.type==='opponent_disconnected'){$('gameCaption').textContent='상대 연결 끊김 · 15초 재접속 대기';}
    if(msg.type==='anti_cheat_warning'){$('gpsStatus').textContent=msg.message;}
    if(msg.type==='match_resumed'){roomId=msg.room_id;gameStartedAt=msg.started_at;gameDuration=msg.duration_ms;distanceM=Math.max(distanceM,msg.distance_m);stopGPS();beginOnlineRun(true);$('gameCaption').textContent='서버 재접속 성공 · 경기 복귀';}
    if(msg.type==='opponent_reconnected'){$('gameCaption').textContent='상대 재접속 완료 · 경기 진행 중';}
    if(msg.type==='resume_error'){$('gameCaption').textContent='경기 재접속 실패 · '+msg.message;}
    if(msg.type==='match_result'){finishOnlineRun(msg);}
    if(msg.type==='match_cancelled'){setMatchmaking(false);roomId=null;onlineActive=false;matchStatus(msg.message||'매칭이 취소됐습니다.');showScreen('lobby');}
    if(msg.type==='match_error'){setMatchmaking(false);matchStatus(msg.message||'매칭 오류')}
    if(msg.type==='error')matchStatus(msg.message||'서버 오류');
  }
  function connect(){
    const url=$('serverUrl').value.trim();
    if(!url){netStatus('서버 주소 미설정 · 매칭 불가');matchStatus('서버 연결 없음 · 매칭만 사용할 수 없습니다.');return Promise.resolve(false)}
    if(!/^wss?:\/\//.test(url)){netStatus('주소는 ws:// 또는 wss://로 시작해야 합니다.');return Promise.resolve(false)}
    if(socket?.readyState===WebSocket.OPEN&&socketUrl===url)return Promise.resolve(true);
    if(connecting)return connecting;
    if(socket){socket.onclose=null;socket.close()}
    socketUrl=url;netStatus('서버 연결 중…');log('연결 시도 '+url);
    connecting=new Promise(resolve=>{
      let finished=false;const done=ok=>{if(!finished){finished=true;resolve(ok)}};
      try{socket=new WebSocket(url)}catch(e){netStatus('연결 생성 실패');log(String(e));done(false);return}
      const current=socket;
      const timeout=setTimeout(()=>{if(current.readyState!==WebSocket.OPEN){current.close();netStatus('서버 응답 없음 · 매칭 불가');done(false)}},5000);
      current.onopen=()=>{clearTimeout(timeout);netStatus('서버 연결됨',true);log('WebSocket 연결 성공');send({type:'hello',client_id:uid,protocol:1});if(authToken)send({type:'auth_me',token:authToken});if(roomId&&resumeKey&&onlineActive)send({type:'match_resume',room_id:roomId,resume_key:resumeKey});done(true)};
      current.onmessage=e=>{try{handleMessage(JSON.parse(e.data))}catch{log('잘못된 서버 메시지')}};
      current.onerror=()=>{netStatus('서버 연결 실패 · 매칭 불가');log('연결 오류');done(false)};
      current.onclose=()=>{clearTimeout(timeout);if(matchmaking){setMatchmaking(false);matchStatus('서버 연결이 끊겨 매칭 대기가 취소됐습니다.')}netStatus('서버 연결 끊김 · 매칭 불가');log('연결 종료');done(false);if(onlineActive){$('gameCaption').textContent='연결이 끊겼습니다. 재접속을 시도합니다.';setTimeout(()=>connect(),1200)}};
    }).finally(()=>{connecting=null});
    return connecting;
  }
  async function match(){
    if(matchmaking){cancelMatch();return}
    if(matchRequestPending)return;
    matchRequestPending=true;setMatchmaking(true);matchStatus('서버 연결 중…');
    try{
      if(!await connect()){
        if(matchmaking){setMatchmaking(false);matchStatus('서버에 연결할 수 없습니다. 서버 주소를 확인하세요.')}
        return;
      }
      if(!matchmaking){send({type:'match_cancel'});return}
      roomId=null;
      if(!send({type:'match_request',mode:'duel',client_id:uid})){
        setMatchmaking(false);matchStatus('매칭 요청을 전송하지 못했습니다.');return;
      }
      matchStatus('매칭 요청 전송 완료 · 서버 응답 대기 중…');
    }finally{matchRequestPending=false}
  }
  let opponentIntroTimer=null;
  function showOpponentIntro(opponent){
    const data=opponent||{};
    $('opponentIntroName').textContent=data.nickname||'게스트 러너';
    const photo=typeof data.photo==='string'&&data.photo.startsWith('data:image/')?data.photo:'user_icon.png';
    $('opponentIntroPhoto').src=photo;
    $('opponentIntro').classList.remove('hidden');
    clearTimeout(opponentIntroTimer);
    opponentIntroTimer=setTimeout(()=>$('opponentIntro').classList.add('hidden'),2500);
  }
  $('opponentIntroClose').onclick=()=>{clearTimeout(opponentIntroTimer);$('opponentIntro').classList.add('hidden')};
  for(let m=5;m<=60;m+=5){const option=document.createElement('option');option.value=String(m);option.textContent=m+'분';if(m===15)option.selected=true;$('desiredMinutes').append(option)}
  $('submitMinutes').onclick=()=>{if(send({type:'time_choice',room_id:roomId,minutes:Number($('desiredMinutes').value)}))$('submitMinutes').disabled=true};
  $('retryNeg').onclick=()=>send({type:'time_retry',room_id:roomId});
  $('cancelNeg').onclick=()=>send({type:'match_cancel',room_id:roomId});
  $('readyCancel').onclick=()=>send({type:'match_cancel',room_id:roomId});
  $('readyBtn').onclick=()=>{routeShare=$('shareRoute').checked;if(send({type:'match_ready',room_id:roomId,share_route:routeShare,token:authToken}))$('readyBtn').disabled=true};
  $('openRules').onclick=()=>showScreen('rules');$('rulesBack').onclick=enterLobby;
  function stopGPS(){if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;if(timer)clearInterval(timer);timer=null;running=false;onlineActive=false;$('gpsDot').classList.remove('live')}
  function beginOnlineRun(resuming=false){if(gameFinished)return;onlineActive=true;running=true;if(!resuming){distanceM=0;elapsedMs=0;routePoints=[];splitTimes=[];nextSplit=1000;renderSplits();}lastPoint=null;lastFix=0;antiFlags=0;startAt=gameStartedAt;$('runState').textContent='LIVE';$('startBtn').disabled=true;$('finishBtn').disabled=false;$('gameCaption').textContent='경기 진행 중 · 안전한 장소에서 달려 주세요.';
    if(!navigator.geolocation||!window.isSecureContext){gpsError('GPS를 사용할 수 없는 환경입니다. 기록은 0점으로 진행됩니다.')}else{watchId=navigator.geolocation.watchPosition(onPosition,e=>gpsError('GPS 위치 오류: '+e.message),{enableHighAccuracy:true,maximumAge:1000,timeout:15000})}
    timer=setInterval(()=>{elapsedMs=Math.min(gameDuration,Math.max(0,Date.now()-gameStartedAt));render();if(Date.now()-lastSent>=1000){lastSent=Date.now();send({type:'run_update',room_id:roomId,distance_m:Math.round(distanceM),elapsed_ms:elapsedMs,splits:splitTimes,route_point:routeShare&&routePoints.length?routePoints.at(-1):null})}if(elapsedMs>=gameDuration){$('gameCaption').textContent='제한시간 종료 · 서버 판정 대기';$('finishBtn').disabled=true}},500);
  }
  function animateResult(my,other,outcome,reason){resultTimers.forEach(clearTimeout);resultTimers=[];['revealMine','revealOther','revealVerdict'].forEach(id=>$(id).classList.add('hidden'));$('revealMineValue').textContent='0';$('revealOtherValue').textContent='0';
    const animateNumber=(id,target)=>{const start=performance.now(),duration=750;function step(t){const p=Math.min(1,(t-start)/duration);$(id).textContent=String(Math.round(target*(1-(1-p)**3)));if(p<1)requestAnimationFrame(step)}requestAnimationFrame(step)};
    resultTimers.push(setTimeout(()=>{$('revealMine').classList.remove('hidden');animateNumber('revealMineValue',my)},900));
    resultTimers.push(setTimeout(()=>{$('revealOther').classList.remove('hidden');animateNumber('revealOtherValue',other)},2200));
    resultTimers.push(setTimeout(()=>{const e=$('revealVerdict');e.textContent=outcome==='win'?'VICTORY':outcome==='lose'?'DEFEAT':'DRAW';e.classList.toggle('lose',outcome==='lose');e.classList.remove('hidden');$('resultTitle').textContent=reason==='forfeit'?'기권으로 경기 종료':'경기 종료';$('resultText').textContent='내 점수 '+my+'점 / 상대 '+other+'점'+(reason==='forfeit'?' · 기권 우선 판정':'');$('resultTag').textContent=outcome.toUpperCase()},3600));
  }
  function finishOnlineRun(msg){if(gameFinished)return;gameFinished=true;stopGPS();elapsedMs=msg.elapsed_ms;roomId=null;render();$('resultCaption').textContent='서버에서 실제 두 플레이어의 기록을 비교한 결과입니다.';const r={date:new Date().toISOString(),mode:'온라인 1대1',distance:msg.my_distance_m/1000,elapsed:msg.elapsed_ms,speed:msg.elapsed_ms?msg.my_distance_m/1000/(msg.elapsed_ms/3600000):0,score:msg.my_score,splits:msg.record?.splits||splitTimes,route:msg.record?.route||[],opponent_route:msg.record?.opponent_route||[],opponent_score:msg.opponent_score,outcome:msg.outcome,reason:msg.reason};showResultRoutes(r);if(authToken)setTimeout(requestHistory,500);const list=records();list.unshift(r);try{localStorage.setItem(KEY,JSON.stringify(list.slice(0,20)))}catch{}renderRecords();showScreen('result');animateResult(msg.my_score,msg.opponent_score,msg.outcome,msg.reason)}
  $('startBtn').onclick=runStart;$('finishBtn').onclick=runFinish;
  $('resetBtn').onclick=()=>{if(running){alert('먼저 러닝을 종료해 주세요.');return}elapsedMs=0;distanceM=0;lastPoint=null;render();$('runState').textContent='READY';$('gpsStatus').textContent='GPS 대기 중 · 위치 권한이 필요합니다.'};

  $('serverUrl').addEventListener('input',()=>localStorage.setItem(SERVER_KEY,$('serverUrl').value.trim()));
  $('saveServer').onclick=()=>{localStorage.setItem(SERVER_KEY,$('serverUrl').value.trim());netStatus('서버 주소 저장됨 · 연결 테스트 필요');log('서버 주소 저장')};
  $('testServer').onclick=async()=>{const ok=await connect();matchStatus(ok?'서버 연결 테스트 성공':'서버 연결 실패 · 온라인 매칭만 사용 불가')};
  $('matchBtn').onclick=match;
  window.addEventListener('pagehide',()=>{if(watchId!==null)navigator.geolocation.clearWatch(watchId);if(socket)socket.close()});

  // One HTML entrypoint, separate app-style screens. Socket/GPS state survives screen changes.
  let currentScreen='auth', previousScreen='auth', gameType='practice';
  // Visual-only page transition. Keeps WebSocket, login session and GPS state alive.
  const loadingLayer=$('arenaLoading');
  let navigationTimer=null, revealTimer=null, pendingScreen=null;
  function showScreen(name){
    if(name===currentScreen && !pendingScreen)return;
    if(name==='settings' && currentScreen!=='settings')previousScreen=currentScreen;
    pendingScreen=name;
    clearTimeout(navigationTimer);clearTimeout(revealTimer);
    loadingLayer.classList.add('is-visible');
    loadingLayer.setAttribute('aria-hidden','false');
    const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    navigationTimer=setTimeout(()=>{
      const target=pendingScreen;pendingScreen=null;
      document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('hidden',el.id!=='screen-'+target));
      currentScreen=target;$('bottomNav').classList.toggle('hidden',!['lobby','records','profile'].includes(target));document.querySelectorAll('#bottomNav button').forEach(b=>{const active=(target==='lobby'&&b.id==='navHome')||(target==='records'&&b.id==='navRecords')||(target==='profile'&&b.id==='navProfile');b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});window.scrollTo(0,0);
      revealTimer=setTimeout(()=>{
        loadingLayer.classList.remove('is-visible');
        loadingLayer.setAttribute('aria-hidden','true');
      },reduced?0:260);
    },reduced?0:640);
  }
  function enterLobby(){
    $('lobbyGreeting').textContent=authUser?'환영합니다, '+(authUser.nickname||authUser.username)+'님. 경기 모드를 선택하세요.':'게스트 모드 · 경기 모드를 선택하세요.';
    showScreen('lobby');
  }
  function enterGame(kind){
    gameType=kind;
    $('gameEyebrow').textContent=kind==='online'?'ONLINE DUEL':'PRACTICE RUN';
    $('gameCaption').textContent=kind==='online'?'경기 시작을 기다립니다.':'연습 모드 · 서버 연결 없이 GPS 기록을 측정합니다.';
    $('liveOpponentScore').textContent=kind==='online'?'0 pts':'연습 모드';$('gameLimit').textContent=kind==='online'?'경기 제한시간: '+timeFmt(gameDuration):'연습 모드';
    if(!running){elapsedMs=0;distanceM=0;lastPoint=null;lastFix=0;routePoints=[];splitTimes=[];nextSplit=1000;renderSplits();render();$('runState').textContent='READY'}
    showScreen('game');
  }
  function showRunResult(){showResultRoutes(records()[0]||{});
    ['revealMine','revealOther','revealVerdict'].forEach(id=>$(id).classList.add('hidden'));
    $('resultCaption').textContent=gameType==='online'?'온라인 경기 결과':'개인 러닝 종료 · 기록이 이 브라우저에 저장됐습니다.';
    showScreen('result');
  }
  $('guestEnter').onclick=enterLobby;
  $('authEnter').onclick=()=>{$('authLanding').classList.add('hidden');$('accountCard').classList.remove('hidden');};
  $('authBack').onclick=()=>{$('accountCard').classList.add('hidden');$('authLanding').classList.remove('hidden');};
  $('authSettings').onclick=()=>{$('authServerUrl').value=$('serverUrl').value;showScreen('auth-server');};
  $('authServerBack').onclick=()=>showScreen('auth');
  $('authSaveServer').onclick=()=>{const url=$('authServerUrl').value.trim();$('serverUrl').value=url;localStorage.setItem(SERVER_KEY,url);$('authServerStatus').textContent='서버 주소가 저장되었습니다.';};
  $('authTestServer').onclick=async()=>{const url=$('authServerUrl').value.trim();$('serverUrl').value=url;localStorage.setItem(SERVER_KEY,url);const ok=await connect();$('authServerStatus').textContent=ok?'서버 연결 성공':'서버 연결 실패 · 주소와 서버 상태를 확인하세요.';};
  $('openSettings').onclick=()=>showScreen('settings');
  $('openRecords').onclick=()=>{requestHistory();showScreen('records')};
  $('practiceBtn').onclick=()=>enterGame('practice');
  $('settingsBack').onclick=()=>showScreen(previousScreen==='settings'?'auth':previousScreen);
  $('recordsBack').onclick=enterLobby;
  $('resultLobby').onclick=enterLobby;
  $('resultRecords').onclick=()=>{requestHistory();showScreen('records')};
  $('gameBack').onclick=()=>{if(running){alert('러닝을 먼저 종료해 주세요.');return}if(roomId){alert('온라인 경기 진행 중입니다.');return}enterLobby()};
  $('lobbyLogout').onclick=()=>{if(authToken&&socket?.readyState===WebSocket.OPEN)send({type:'auth_logout',token:authToken});setSession(null,null);showScreen('auth');authStatus('로그아웃했습니다. 게스트 모드도 사용할 수 있어요.')};

  // v0.6 account, theme, routes and history
  const bad=['씨발','새끼','시발','병신','좆','장애','게이','최민서'];
  const nicknameValid=n=>n.trim().length>=2&&[...n.trim()].length<=24&&!bad.some(x=>n.replace(/\s/g,'').toLowerCase().includes(x))&&!/[<>]/.test(n);
  function afterLogin(){refreshProfile();requestHistory();if(!authUser?.nickname)showScreen('nickname');else{enterLobby();showWelcome()}}
  function refreshProfile(){const n=authUser?.nickname||authUser?.username||'게스트';$('profileDisplay').textContent=n;$('profileId').textContent='ID · '+(authUser?.username||'GUEST');$('editNickname').value=n;const img=$('profilePreview');img.src=authUser?.photo||'user_icon.png';const variants=['#d9f5d2','#d3eee0','#eaf7da','#d7f2ea','#e1f0d3'];let index=Number(localStorage.getItem('ra-profile-color'));if(!Number.isInteger(index)||index<0||index>=5){index=Math.floor(Math.random()*5);localStorage.setItem('ra-profile-color',index)}img.style.background=variants[index]}
  function requestHistory(){if(authToken)send({type:'history_list',token:authToken})}
  $('saveFirstNickname').onclick=()=>{const n=$('firstNickname').value.trim();if(!nicknameValid(n)){$('nicknameError').textContent='닉네임 형식이 올바르지 않거나 금지된 표현입니다.';return}send({type:'profile_update',token:authToken,nickname:n})};
  $('openProfile').onclick=()=>{refreshProfile();showScreen('profile')};$('navHome').onclick=enterLobby;$('navRecords').onclick=()=>{requestHistory();showScreen('records')};$('navProfile').onclick=()=>$('openProfile').click();$('profileBack').onclick=enterLobby;$('profileSettings').onclick=()=>showScreen('settings');
  let pendingPhoto=undefined;
  async function imageSelected(file){if(!file)return;if(file.size>10*1024*1024){$('profileMessage').textContent='10MB 이하 사진을 선택해 주세요.';return}const img=new Image(),url=URL.createObjectURL(file);await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url}).catch(()=>{});if(!img.naturalWidth){URL.revokeObjectURL(url);return}const canvas=document.createElement('canvas');canvas.width=canvas.height=192;const ctx=canvas.getContext('2d');const size=Math.min(img.width,img.height);ctx.drawImage(img,(img.width-size)/2,(img.height-size)/2,size,size,0,0,192,192);pendingPhoto=canvas.toDataURL('image/jpeg',.7);$('profilePreview').src=pendingPhoto;URL.revokeObjectURL(url)}
  $('photoUploadBtn').onclick=()=>$('photoFile').click();$('photoCameraBtn').onclick=()=>$('photoCamera').click();$('photoResetBtn').onclick=()=>{pendingPhoto=null;$('profilePreview').src='user_icon.png'};
  $('photoFile').onchange=e=>imageSelected(e.target.files[0]);$('photoCamera').onchange=e=>imageSelected(e.target.files[0]);
  $('saveProfile').onclick=()=>{if(!authToken){$('profileMessage').textContent='서버 계정 로그인이 필요합니다.';return}const n=$('editNickname').value.trim();if(!nicknameValid(n)){$('profileMessage').textContent='사용할 수 없는 닉네임입니다.';return}send({type:'profile_update',token:authToken,nickname:n,...(pendingPhoto!==undefined?{photo:pendingPhoto}:{})})};
  $('settingsLogout').onclick=()=>{$('lobbyLogout').click()};$('deleteAccount').onclick=()=>{if(!authToken)return alert('로그인해 주세요.');if(confirm('계정과 서버 전적을 영구 삭제할까요?'))send({type:'account_delete',token:authToken})};
  $('saveId').onclick=()=>{if(authToken)send({type:'account_update',token:authToken,username:$('changeId').value.trim()})};
  $('savePassword').onclick=()=>{if(authToken)send({type:'account_update',token:authToken,password:$('changePassword').value})};
  const theme=localStorage.getItem('ra-theme')||'dark',fs=localStorage.getItem('ra-font')||'100';$('themeSelect').value=theme;$('fontSizeSelect').value=fs;document.body.classList.toggle('light',theme==='light');document.documentElement.style.setProperty('--ra-scale',Number(fs)/100);
  $('themeSelect').onchange=e=>{localStorage.setItem('ra-theme',e.target.value);document.body.classList.toggle('light',e.target.value==='light')};$('fontSizeSelect').onchange=e=>{localStorage.setItem('ra-font',e.target.value);document.documentElement.style.setProperty('--ra-scale',Number(e.target.value)/100)};
  // 소셜 로그인은 대회 제출 버전에서 비활성화됩니다.
  
  const intro=['Running Arena에 오신 것을 환영합니다.','1대1 매칭 후 각자 5~60분의 희망 시간을 선택합니다.','희망 시간의 평균으로 경기하고, 15분 초과 차이는 재협상합니다.','두 플레이어가 READY를 누르면 3초 뒤 동시에 출발합니다.','거리 70%와 속도 보너스 30%로 점수를 계산합니다.','제한시간 종료 시 높은 점수가 승리합니다.','FINISH RUN은 즉시 기권 패배이며 점수는 그대로 공개됩니다.','GPS 오차가 큰 이동은 제외합니다. 안전을 최우선으로 달리세요.'];let introStep=0;
  function showWelcome(){if(!authUser||localStorage.getItem('ra-intro-'+authUser.username))return;introStep=0;$('welcomeLines').replaceChildren();$('closeWelcome').classList.add('hidden');$('welcomeOverlay').classList.remove('hidden');nextIntro()}
  function nextIntro(){if(introStep>=intro.length){$('closeWelcome').classList.remove('hidden');return}const p=document.createElement('p');p.textContent='';$('welcomeLines').append(p);const content=intro[introStep++];let i=0;const tick=()=>{if(!$('welcomeOverlay').classList.contains('hidden')&&i<content.length){p.textContent+=content[i++];setTimeout(tick,28)}};tick();if(introStep===intro.length)setTimeout(()=>$('closeWelcome').classList.remove('hidden'),content.length*30+300)}
  $('welcomeOverlay').onclick=e=>{if(e.target.id==='closeWelcome')return;nextIntro()};$('closeWelcome').onclick=()=>{localStorage.setItem('ra-intro-'+authUser.username,'1');$('welcomeOverlay').classList.add('hidden')};
  const maps={};function drawMap(id,points,other=[]){if(!window.L||!$(id)||!points?.length&&!other?.length)return;const valid=arr=>(arr||[]).filter(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite));points=valid(points);other=valid(other);if(!points.length&&!other.length)return;let m=maps[id];if(!m){m=L.map(id,{zoomControl:true}).setView((points[0]||other[0]),14);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(m);maps[id]=m}if(m.lines)m.lines.forEach(line=>m.removeLayer(line));m.lines=[];if(points.length)m.lines.push(L.polyline(points,{color:'#55cf58',weight:5}).addTo(m));if(other.length)m.lines.push(L.polyline(other,{color:'#ff8b48',weight:4}).addTo(m));const all=points.concat(other);if(all.length>1)m.fitBounds(L.latLngBounds(all),{padding:[22,22],maxZoom:16});else m.setView(all[0],15);setTimeout(()=>m.invalidateSize(),700)}
  function renderSplits(){$('liveSplits').textContent=splitTimes.length?splitTimes.map((t,i)=>`${i+1}km · ${timeFmt(t-(i?splitTimes[i-1]:0))}`).join('  |  '):'아직 기록된 구간이 없습니다.'}
  function showResultRoutes(r){$('resultMapInfo').textContent=(r.route?.length||0)||(r.opponent_route?.length||0)?'초록색: 내 경로 / 주황색: 상대가 공유한 경로':'공유된 경로가 없습니다. 상대 경로는 사전 동의한 경우에만 표시됩니다.';setTimeout(()=>drawMap('resultMap',r.route,r.opponent_route),1200)}
  function showRecord(r){$('recordDetail').textContent=`${r.date?new Date(r.date).toLocaleString():''} · ${r.mode} · ${Number(r.distance||0).toFixed(2)}km · ${timeFmt(r.elapsed)} · 평균 페이스 ${r.distance?timeFmt(r.elapsed/r.distance):'--:--'}/km · 평균속도 ${Number(r.speed||0).toFixed(1)}km/h · ${r.score}점 · ${r.outcome||'연습'} · 구간 ${r.splits?.length?r.splits.map((t,i)=>`${i+1}km ${timeFmt(t-(i?r.splits[i-1]:0))}`).join(', '):'없음'}`;drawMap('recordMap',r.route,r.opponent_route)}
  render();renderRecords();renderAuth();refreshProfile();if(authToken)connect();
})();
