// ═══════════════════════════════════════════════════════════════
// LIVE STATE MODULE — IPC bridge, run events, engine status
// ═══════════════════════════════════════════════════════════════

const liveAPI=window.clawcraft||null;
const liveMode=!!liveAPI;
const engineStatuses=new Map();
let drawerAgentId=null;
let liveConstraint='mock';
let bootstrapped=false;

function fmtEngine(engine,model){
  return model?`${engine.toUpperCase()} · ${model}`:engine.toUpperCase();
}
function findAgent(id){return agents.find(a=>String(a.id)===String(id));}
function summarizePrompt(prompt){
  if(!prompt)return'대기 중';
  return prompt.replace(/\s+/g,' ').trim().slice(0,56)||'대기 중';
}
function agentStatusMeta(a){
  if(a.runStatus==='failed')return{text:'실패',color:'#ff7d7d'};
  if(a.runStatus==='cancelled')return{text:'취소됨',color:'#c89d64'};
  if(a.runStatus==='running'){
    const labelMap={planning:'기획 중',coding:'코딩 중',testing:'검증 중',summarizing:'정리 중',done:'완료'};
    return{text:a.runLabel||labelMap[a.runPhase]||'작업 중',color:a.runPhase==='done'?'#40ff40':'#f0a030'};
  }
  const stMap={idle:'대기',move_to_build:'이동 중...',building:`건설 중 ${a.progress*100|0}%`,complete:'건설 완료!',patrol:'순찰 중',idle_at_bldg:'건물 근처 대기',manual_move:'이동 중...',manual_idle:'대기 중...',demolishing:'철거 중'};
  const cMap={idle:'#666',move_to_build:'#4a9eff',building:'#f0a030',complete:'#40ff40',patrol:'#60aa60',idle_at_bldg:'#506050',manual_move:'#4a9eff',manual_idle:'#666',demolishing:'#ff7070'};
  return{text:stMap[a.state]||'',color:cMap[a.state]||'#888'};
}
function updateLiveStatus(text){
  document.getElementById('live-status').textContent=text;
}

function ensureRemoteAgent(agent){
  const local=findAgent(agent.id);
  if(local){
    local.syncMeta(agent);
    return local;
  }
  spawnAgent(agent);
  return findAgent(agent.id);
}
function applyRunToAgent(event){
  const agent=findAgent(event.agentId||event.run?.agentId);
  if(!agent)return;
  if(event.type==='run.started'){
    agent.beginLiveRun(event.run);
    openTaskDrawer(agent.id);
    return;
  }
  if(event.type==='run.phase'){
    agent.applyRunPhase(event.phase,event.progress,event.label);
    return;
  }
  if(event.type==='run.output'){
    agent.applyRunPhase(event.phase,event.progress,agent.runLabel);
    agent.appendRunLog(event.text);
    return;
  }
  if(event.type==='run.completed'){
    agent.finishRun('done',event.run);
    return;
  }
  if(event.type==='run.failed'){
    agent.errorText=event.errorText||'실패';
    agent.appendRunLog(`ERROR: ${agent.errorText}`);
    agent.finishRun('failed',event.run);
    return;
  }
  if(event.type==='run.cancelled'){
    agent.finishRun('cancelled',event.run);
  }
}
function handleLiveEvent(event){
  if(event.type==='agent.created'){
    ensureRemoteAgent(event.agent);
    updCnt();
    return;
  }
  if(event.type==='agent.removed'){
    return;
  }
  if(event.type.startsWith('run.')){
    applyRunToAgent(event);
    // Update status bar with active run count
    const running=agents.filter(a=>a.runStatus==='running').length;
    if(event.type==='run.started'){
      updateLiveStatus(running>1?`LIVE MODE · ${running}개 에이전트 병렬 실행 중`:`LIVE MODE · ${event.agent?.name||'에이전트'} 실행 중`);
    }
    if(event.type==='run.completed'){
      updateLiveStatus(running>0?`LIVE MODE · ${running}개 실행 중`:'LIVE MODE · 대기');
    }
    if(event.type==='run.failed')updateLiveStatus(`실패 · ${event.errorText||'run failed'}`);
    if(event.type==='run.cancelled'){
      updateLiveStatus(running>0?`LIVE MODE · ${running}개 실행 중`:'LIVE MODE · 대기');
    }
  }
}

function startAllMock(){
  initAudio();
  agents.forEach((a,i)=>{
    const prompt=document.getElementById('task-prompt').value.trim()||'Mock task';
    setTimeout(()=>{
      a.beginLiveRun({
        id:`mock-${Date.now()}-${a.id}`,
        prompt,
        taskTitle:summarizePrompt(prompt),
        progress:.08,
        phase:'planning',
      });
      a.appendRunLog(`MOCK START: ${prompt}`);
      let progress=.08;
      const timer=setInterval(()=>{
        progress=Math.min(1,progress+.12);
        const phase=progress<.25?'planning':progress<.8?'coding':'summarizing';
        a.applyRunPhase(phase,progress,phase==='coding'?'모의 코딩 중':'모의 작업 진행 중');
        if(progress>=1){
          clearInterval(timer);
          a.finishRun('done',{summary:`${a.name} mock run finished.`,filesChanged:[]});
        }
      },500);
    },i*350);
  });
}

async function startRunFromUI(){
  const prompt=document.getElementById('task-prompt').value.trim();
  if(!prompt){
    updateLiveStatus('프롬프트를 입력하세요');
    return;
  }
  if(!agents.length){
    updateLiveStatus('에이전트를 먼저 추가하세요');
    return;
  }
  if(!liveMode){
    startAllMock();
    updateLiveStatus('MOCK RUNNING');
    return;
  }
  const collabMode=document.getElementById('collab-mode').value;
  const selected=[...selectedAgents].map(id=>findAgent(id)).filter(Boolean);
  const targets=selected.length?selected:[...agents];
  if(!targets.length){
    updateLiveStatus('시작할 에이전트가 없습니다');
    return;
  }

  // 4단계: Relay mode — chain agents sequentially
  if(collabMode==='relay'&&targets.length>=2){
    updateLiveStatus(`RELAY · ${targets.length}개 에이전트 순차 실행 시작`);
    try{
      const results=await liveAPI.startRelay({
        agentIds:targets.map(t=>String(t.id)),
        prompt,
        taskTitle:summarizePrompt(prompt),
      });
      const done=results.filter(r=>r.status==='done').length;
      updateLiveStatus(`RELAY 완료 · ${done}/${results.length} 성공`);
    }catch(err){
      updateLiveStatus(`RELAY 실패: ${err.message}`);
    }
    return;
  }

  // Solo / Shared Brief — fire all starts in parallel
  updateLiveStatus(`${targets.length}개 에이전트 시작 중...`);
  const results=await Promise.allSettled(targets.map(target=>
    liveAPI.startRun({
      agentId:String(target.id),
      prompt,
      taskTitle:summarizePrompt(prompt),
    }).catch(err=>{
      target.appendRunLog(`ERROR: ${err.message||'실행 실패'}`);
      target.runStatus='failed';
      updateCard(target.id);
      throw err;
    })
  ));
  const started=results.filter(r=>r.status==='fulfilled').length;
  const failed=results.filter(r=>r.status==='rejected').length;
  if(started>0)updateLiveStatus(`LIVE MODE · ${started}개 에이전트 실행 중${failed?` (${failed}개 실패)`:''}`);
  else updateLiveStatus('모든 에이전트 시작 실패');
}

async function bootstrapLiveMode(){
  renderEngineList();
  if(!liveMode){
    document.getElementById('layer-copy').textContent='브라우저 모드에서는 mock 작업만 실행됩니다.';
    updateLiveStatus('MOCK DEMO');
    if(!bootstrapped){
      bootstrapped=true;
      setTimeout(()=>{spawnAgent({name:'Scout-01',engine:'mock',model:'demo'});setTimeout(()=>spawnAgent({name:'Miner-02',engine:'mock',model:'demo'}),200);setTimeout(()=>spawnAgent({name:'Builder-03',engine:'mock',model:'demo'}),400);},300);
    }
    return;
  }
  const state=await liveAPI.getState();
  liveConstraint=state.parallelMode||'git-worktree';
  (state.engines||[]).forEach((engine)=>engineStatuses.set(engine.id,engine));
  renderEngineList();
  document.getElementById('layer-copy').textContent=`LIVE MODE: ${liveConstraint==='git-worktree'?'에이전트별 독립 worktree 병렬 실행':'단일 실행 모드'}`;
  updateLiveStatus('LIVE MODE · 대기');
  document.getElementById('btn-start').textContent='▶ 선택 에이전트 시작';
  state.agents.forEach((agent)=>ensureRemoteAgent(agent));
  updCnt();
  liveAPI.onEvent(handleLiveEvent);
}
