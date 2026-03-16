// ═══════════════════════════════════════════════════════════════
// LIVE STATE MODULE — IPC bridge, run events, engine status
// ═══════════════════════════════════════════════════════════════

const liveAPI=window.clawcraft||null;
const liveMode=!!liveAPI;
const engineStatuses=new Map();
let drawerAgentId=null;
let liveConstraint='mock';
let bootstrapped=false;

function openSessionAgentIfPresent(){
  // No auto-open — user selects agents manually
}

function fmtEngine(engine,model){
  return model?`${engine.toUpperCase()} · ${model}`:engine.toUpperCase();
}
function findAgent(id){return agents.find(a=>String(a.id)===String(id));}
function summarizePrompt(prompt){
  if(!prompt)return'Waiting';
  return prompt.replace(/\s+/g,' ').trim().slice(0,56)||'Waiting';
}
function agentStatusMeta(a){
  if(a.runStatus==='failed')return{text:'Failed',color:'#ff7d7d'};
  if(a.runStatus==='cancelled')return{text:'Cancelled',color:'#c89d64'};
  if(a.runStatus==='running'){
    const labelMap={planning:'Planning',coding:'Coding',testing:'Testing',summarizing:'Summarizing',done:'Done'};
    return{text:a.runLabel||labelMap[a.runPhase]||'Working',color:a.runPhase==='done'?'#40ff40':'#f0a030'};
  }
  const stMap={idle:'Idle',move_to_build:'Moving...',building:a.progress<1?`Building ${a.progress*100|0}%`:'Mining',complete:'Complete!',patrol:'Patrol',idle_at_bldg:'Standby',manual_move:'Moving...',manual_idle:'Waiting...',demolishing:'Demolishing'};
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
    agent.errorText=event.errorText||'Failed';
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
    const running=agents.filter(a=>a.runStatus==='running').length;
    if(event.type==='run.started'){
      updateLiveStatus(running>1?`LIVE · ${running} agents running`:`LIVE · ${event.agent?.name||'agent'} running`);
    }
    if(event.type==='run.completed'){
      updateLiveStatus(running>0?`LIVE · ${running} running`:'LIVE · Idle');
    }
    if(event.type==='run.failed')updateLiveStatus(`Failed · ${event.errorText||'run failed'}`);
    if(event.type==='run.cancelled'){
      updateLiveStatus(running>0?`LIVE · ${running} running`:'LIVE · Idle');
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
        a.applyRunPhase(phase,progress,phase==='coding'?'Mock coding...':'Mock running...');
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
    updateLiveStatus('Enter a prompt');
    return;
  }
  if(!agents.length){
    updateLiveStatus('Add agents first');
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
    updateLiveStatus('No agents to start');
    return;
  }

  // Leader Loop mode: persistent leader continuously delegates
  if(collabMode==='leader-loop'){
    if(targets.length<2){
      updateLiveStatus('Leader Loop needs 2+ agents');
      return;
    }
    updateLiveStatus(`♾ LEADER LOOP · ${targets[0].name} commanding ${targets.length-1} builders`);
    try{
      const result=await liveAPI.startLeaderLoop({prompt,leaderId:selected.length?String(selected[0].id):undefined});
      updateLiveStatus(`♾ LEADER LOOP running · Leader: ${result.leaderName}`);
    }catch(err){
      updateLiveStatus(`Leader Loop failed: ${err.message}`);
    }
    return;
  }

  // Collaborate mode: leader decomposes → builders execute → leader reports
  if(collabMode==='collaborate'&&targets.length>=2){
    updateLiveStatus(`COLLAB · Leader planning, ${targets.length-1} builders standing by`);
    try{
      const plan=await liveAPI.startCollaboration({prompt,taskTitle:summarizePrompt(prompt)});
      const done=plan.subtasks?.filter(s=>s.status==='done').length||0;
      const total=plan.subtasks?.length||0;
      updateLiveStatus(`COLLAB done · ${done}/${total} subtasks completed`);
    }catch(err){
      updateLiveStatus(`COLLAB failed: ${err.message}`);
    }
    return;
  }

  if(collabMode==='relay'&&targets.length>=2){
    updateLiveStatus(`RELAY · ${targets.length} agents sequential start`);
    try{
      const results=await liveAPI.startRelay({
        agentIds:targets.map(t=>String(t.id)),
        prompt,
        taskTitle:summarizePrompt(prompt),
      });
      const done=results.filter(r=>r.status==='done').length;
      updateLiveStatus(`RELAY done · ${done}/${results.length} succeeded`);
    }catch(err){
      updateLiveStatus(`RELAY failed: ${err.message}`);
    }
    return;
  }

  updateLiveStatus(`Starting ${targets.length} agents... (${collabMode})`);
  const results=await Promise.allSettled(targets.map(target=>
    liveAPI.startRun({
      agentId:String(target.id),
      prompt,
      taskTitle:summarizePrompt(prompt),
      mode:collabMode,
    }).catch(err=>{
      target.appendRunLog(`ERROR: ${err.message||'Run failed'}`);
      target.runStatus='failed';
      updateCard(target.id);
      throw err;
    })
  ));
  const started=results.filter(r=>r.status==='fulfilled').length;
  const failed=results.filter(r=>r.status==='rejected').length;
  if(started>0)updateLiveStatus(`LIVE · ${started} agents running${failed?` (${failed} failed)`:''}`);
  else updateLiveStatus('All agents failed to start');
}

async function bootstrapLiveMode(){
  renderEngineList();
  if(!liveMode){
    // Browser/mock mode — spawn demo agents locally
    if(!bootstrapped){
      bootstrapped=true;
      document.getElementById('layer-copy').textContent='Browser mode: mock tasks only.';
      updateLiveStatus('MOCK DEMO');
      setTimeout(()=>{
        spawnAgent({name:'Gemini CLI',engine:'gemini',model:'pro-1.5',role:'assistant',silent:true});
        spawnAgent({name:'Scout-01',engine:'mock',model:'demo',silent:true});
        setTimeout(()=>spawnAgent({name:'Miner-02',engine:'mock',model:'demo',silent:true}),200);
        setTimeout(()=>spawnAgent({name:'Builder-03',engine:'mock',model:'demo',silent:true}),400);
      },500);
    }
    return;
  }
  // Live mode — backend is source of truth
  bootstrapped=true;
  const state=await liveAPI.getState();
  liveConstraint=state.parallelMode||'git-worktree';
  (state.engines||[]).forEach((engine)=>engineStatuses.set(engine.id,engine));
  renderEngineList();
  document.getElementById('layer-copy').textContent=`LIVE MODE: ${liveConstraint==='git-worktree'?'Independent worktree per agent':'Single run mode'}`;
  updateLiveStatus('LIVE · Idle');
  document.getElementById('btn-start').textContent='▶ Start Selected';
  // Show current project path
  if(liveAPI.getProjectPath){
    liveAPI.getProjectPath().then(p=>{
      if(p){
        document.getElementById('project-path').textContent=p.split('/').slice(-2).join('/');
        document.getElementById('project-path').title=p;
      }
    }).catch(()=>{});
  }
  // Only show agents that backend already knows about
  state.agents.forEach((agent)=>ensureRemoteAgent(agent));
  updCnt();
  openSessionAgentIfPresent();
  liveAPI.onEvent(handleLiveEvent);
}
