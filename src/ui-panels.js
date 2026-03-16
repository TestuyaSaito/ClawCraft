// ═══════════════════════════════════════════════════════════════
// UI PANELS MODULE — Agent cards, task drawer, engine list
// ═══════════════════════════════════════════════════════════════

function syncDrawer(){
  if(!drawerAgentId){
    document.getElementById('drawer-title').textContent='작업 상세';
    document.getElementById('drawer-engine').textContent='-';
    document.getElementById('drawer-phase').textContent='-';
    document.getElementById('drawer-task').textContent='-';
    document.getElementById('drawer-workspace').textContent='-';
    document.getElementById('drawer-branch').textContent='-';
    document.getElementById('drawer-files-meta').textContent='-';
    document.getElementById('drawer-prompt').textContent='(에이전트를 선택하세요)';
    document.getElementById('drawer-summary').textContent='(아직 없음)';
    document.getElementById('drawer-logs').textContent='(아직 없음)';
    document.getElementById('agent-prompt-input').disabled=true;
    document.getElementById('agent-prompt-send').disabled=true;
    return;
  }
  const a=findAgent(drawerAgentId);
  if(!a){drawerAgentId=null;syncDrawer();return;}
  document.getElementById('drawer-title').textContent=`${a.name} 작업 상세`;
  document.getElementById('drawer-engine').textContent=fmtEngine(a.engine||'mock',a.model||'demo');
  document.getElementById('drawer-phase').textContent=agentStatusMeta(a).text||'대기';
  document.getElementById('drawer-task').textContent=a.taskTitle||'대기 중';
  document.getElementById('drawer-workspace').textContent=a.workspaceStrategy||'대기';
  document.getElementById('drawer-branch').textContent=a.workspaceBranch||'-';
  document.getElementById('drawer-files-meta').textContent=a.filesChanged?.length?`${a.filesChanged.length}개`:a.runStatus==='done'?'0개':'-';
  document.getElementById('drawer-prompt').textContent=a.runPrompt||'(선택된 작업이 없습니다)';
  document.getElementById('drawer-summary').textContent=a.runSummary||'(아직 없음)';
  document.getElementById('drawer-logs').textContent=(a.runLogs&&a.runLogs.length)?a.runLogs.slice(-18).join('\n\n'):'(아직 없음)';
  document.getElementById('agent-prompt-input').disabled=false;
  document.getElementById('agent-prompt-send').disabled=false;
}
function openTaskDrawer(agentId){drawerAgentId=String(agentId);syncDrawer();}
function closeTaskDrawer(){drawerAgentId=null;syncDrawer();}

// Send prompt to individual agent — connects to live backend if available
async function sendAgentPrompt(){
  if(!drawerAgentId)return;
  const input=document.getElementById('agent-prompt-input');
  const prompt=input.value.trim();
  if(!prompt)return;
  input.value='';
  const a=findAgent(drawerAgentId);
  if(!a)return;

  if(liveMode){
    // Live mode: dispatch to backend via IPC
    try{
      updateLiveStatus(`${a.name} 실행 요청 중`);
      await liveAPI.startRun({
        agentId:String(a.id),
        prompt,
        taskTitle:summarizePrompt(prompt),
      });
    }catch(err){
      updateLiveStatus(err.message||'실행 실패');
      a.appendRunLog(`ERROR: ${err.message||'실행 실패'}`);
      a.runStatus='failed';
      updateCard(a.id);
    }
  } else {
    // Mock mode: local simulation
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
  }
  updateCard(a.id);
  syncDrawer();
}

function renderEngineList(){
  const host=document.getElementById('engine-status-list');
  const items=[...engineStatuses.values()];
  if(!items.length){
    host.innerHTML='<div class="engine-item"><div class="name">Mock</div><div class="meta">브라우저 데모 모드</div></div>';
    return;
  }
  host.innerHTML=items.map((engine)=>`<div class="engine-item${engine.available?'':' offline'}"><div class="name">${engine.label}</div><div class="meta">${engine.available?'CLI 사용 가능':'이 머신에서 CLI 없음'}</div></div>`).join('');
}

function addCard(a){
  const bt=BLDG_TYPES.find(b=>b.id===a.bt);const d=document.createElement('div');
  d.className='agent-card';d.id=`ac-${a.id}`;
  d.innerHTML=`<div class="card-top"><div class="aname">${a.name}</div><button class="abtn-remove" title="SCV 제거">✕</button></div><div class="astatus">대기</div><div class="aengine">${fmtEngine(a.engine||'mock',a.model||'demo')}</div><div class="abldg">${bt.name}</div><div class="atask">대기 중</div><div class="pbar"><div class="pfill"></div></div>`;
  d.querySelector('.abtn-remove').onclick=(e)=>{e.stopPropagation();void removeAgent(a.id);};
  d.onclick=(e)=>{
    if(!e.ctrlKey&&!e.metaKey){
      clearSelection();
    }
    if(a.selected&&(e.ctrlKey||e.metaKey)){
      a.selected=false;
      selectedAgents.delete(a.id);
    } else {
      selectAgent(a);
    }
    a.select();
    if(selectedAgents.size===1){
      openTaskDrawer([...selectedAgents][0]);
    } else {
      closeTaskDrawer();
    }
  };
  document.getElementById('agent-list').appendChild(d);
  updateCard(a.id);
}
function updateCard(id){
  const a=agents.find(a=>a.id===id);if(!a)return;const c=document.getElementById(`ac-${id}`);if(!c)return;
  const st=c.querySelector('.astatus'),fl=c.querySelector('.pfill');
  const engineEl=c.querySelector('.aengine'),taskEl=c.querySelector('.atask');
  c.className='agent-card'+(a.state==='building'?' building':'')+(a.progress>=1&&a.runStatus!=='running'?' done':'')+(a.runStatus==='failed'?' failed':'');
  const status=agentStatusMeta(a);
  st.textContent=status.text||'대기';
  st.style.color=status.color;
  const wsLabel=a.workspaceBranch?` · ${a.workspaceBranch}`:'';
  engineEl.textContent=fmtEngine(a.engine||'mock',a.model||'demo')+wsLabel;
  taskEl.textContent=a.taskTitle||'대기 중';
  fl.style.width=`${a.progress*100|0}%`;
  fl.className='pfill'+(a.progress>=1&&a.runStatus!=='running'?' complete':'');
  syncDrawer();
}
function updCnt(){document.getElementById('agent-count').textContent=`에이전트: ${agents.length}`;}
