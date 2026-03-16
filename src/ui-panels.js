// ═══════════════════════════════════════════════════════════════
// UI PANELS MODULE — Agent cards, task drawer, engine list
// ═══════════════════════════════════════════════════════════════

function syncDrawer(){
  if(!drawerAgentId){
    document.getElementById('drawer-title').textContent='Task Detail';
    document.getElementById('drawer-engine').textContent='-';
    document.getElementById('drawer-phase').textContent='-';
    document.getElementById('drawer-task').textContent='-';
    document.getElementById('drawer-workspace').textContent='-';
    document.getElementById('drawer-branch').textContent='-';
    document.getElementById('drawer-files-meta').textContent='-';
    document.getElementById('drawer-prompt').textContent='(Select an agent)';
    document.getElementById('drawer-summary').textContent='(None yet)';
    document.getElementById('drawer-logs').textContent='(None yet)';
    document.getElementById('agent-prompt-input').disabled=true;
    document.getElementById('agent-prompt-send').disabled=true;
    return;
  }
  const a=findAgent(drawerAgentId);
  if(!a){drawerAgentId=null;syncDrawer();return;}
  document.getElementById('drawer-title').textContent=`${a.name} Task Detail`;
  document.getElementById('drawer-engine').textContent=fmtEngine(a.engine||'mock',a.model||'demo');
  document.getElementById('drawer-phase').textContent=agentStatusMeta(a).text||'Idle';
  document.getElementById('drawer-task').textContent=a.taskTitle||'Waiting';
  document.getElementById('drawer-workspace').textContent=a.workspaceStrategy||'Idle';
  document.getElementById('drawer-branch').textContent=a.workspaceBranch||'-';
  document.getElementById('drawer-files-meta').textContent=a.filesChanged?.length?`${a.filesChanged.length} files`:a.runStatus==='done'?'0 files':'-';
  document.getElementById('drawer-prompt').textContent=a.runPrompt||'(No task selected)';
  document.getElementById('drawer-summary').textContent=a.runSummary||'(None yet)';
  document.getElementById('drawer-logs').textContent=(a.runLogs&&a.runLogs.length)?a.runLogs.slice(-18).join('\n\n'):'(None yet)';
  document.getElementById('agent-prompt-input').disabled=false;
  document.getElementById('agent-prompt-send').disabled=false;
}
function openTaskDrawer(agentId){drawerAgentId=String(agentId);syncDrawer();}
function closeTaskDrawer(){drawerAgentId=null;syncDrawer();}

// ═══════════════════════════════════════════════════════════════
// BROWSER GEMINI API — direct fetch to Gemini REST API
// ═══════════════════════════════════════════════════════════════
async function callGeminiAPI(apiKey,prompt,agent){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  agent.appendRunLog(`Sending to Gemini...`);
  agent.applyRunPhase('coding',0.2,'Calling Gemini API...');
  const resp=await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      generationConfig:{maxOutputTokens:2048,temperature:0.7},
    }),
  });
  if(!resp.ok){
    const err=await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${err.slice(0,200)}`);
  }
  const data=await resp.json();
  const text=data.candidates?.[0]?.content?.parts?.[0]?.text||'(No response)';
  return text;
}

// Detect if prompt requires heavy work (coding/building/searching) vs simple chat
function isHeavyTask(prompt){
  const p=prompt.toLowerCase();
  const heavy=/\b(code|coding|build|make|create|develop|program|implement|write|fix|debug|refactor|deploy|search|scrape|crawl|draw|render|generate|design|download|install|compile|test|run|execute|script|api|database|server|app|website|function|class|module)\b/;
  return heavy.test(p);
}

// Send prompt to individual agent
async function sendAgentPrompt(){
  if(!drawerAgentId)return;
  const input=document.getElementById('agent-prompt-input');
  const prompt=input.value.trim();
  if(!prompt)return;
  input.value='';
  const a=findAgent(drawerAgentId);
  if(!a)return;

  const apiKey=document.getElementById('api-key-input')?.value?.trim();
  const isGeminiAgent=a.engine==='gemini';
  const needsMining=isHeavyTask(prompt);

  if(liveMode){
    try{
      updateLiveStatus(`${a.name} starting...`);
      const mode=document.getElementById('collab-mode')?.value||'solo';
      await liveAPI.startRun({
        agentId:String(a.id),
        prompt,
        taskTitle:summarizePrompt(prompt),
        mode,
      });
    }catch(err){
      updateLiveStatus(err.message||'Run failed');
      a.appendRunLog(`ERROR: ${err.message||'Run failed'}`);
      a.runStatus='failed';
      updateCard(a.id);
    }
  } else if(isGeminiAgent&&apiKey){
    if(needsMining){
      // Heavy task: start mining animation + call API
      a.beginLiveRun({
        id:`gemini-${Date.now()}-${a.id}`,
        prompt,
        taskTitle:summarizePrompt(prompt),
        progress:.08,
        phase:'planning',
      });
    }
    updateLiveStatus(`${a.name} calling Gemini...`);
    a.taskTitle=summarizePrompt(prompt);
    a.runPrompt=prompt;
    try{
      if(!needsMining){a.appendRunLog(`> ${prompt}`);}
      const response=await callGeminiAPI(apiKey,prompt,a);
      if(needsMining){
        a.applyRunPhase('coding',0.6,'Processing...');
        a.appendRunLog(response);
        a.applyRunPhase('summarizing',0.9,'Finalizing...');
        a.finishRun('done',{summary:response.slice(0,200),filesChanged:[]});
      } else {
        // Simple chat: just show bubble, no mining
        a.appendRunLog(response);
        a.chatBubble=response.replace(/```[\s\S]*?```/g,'').replace(/[#*_`]/g,'').trim().slice(0,120)+(response.length>120?'...':'');
        a.chatBubbleTimer=999;
      }
      updateLiveStatus(`${a.name} done`);
    }catch(err){
      a.appendRunLog(`ERROR: ${err.message}`);
      if(needsMining)a.finishRun('failed',{errorText:err.message});
      updateLiveStatus(`Gemini failed: ${err.message.slice(0,60)}`);
    }
  } else {
    // Mock mode
    if(needsMining){
      // Heavy task: mining animation
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
    } else {
      // Simple chat: just show mock response as bubble
      a.taskTitle=summarizePrompt(prompt);
      a.runPrompt=prompt;
      a.appendRunLog(`> ${prompt}`);
      a.chatBubble=`[Mock] "${prompt.slice(0,40)}" — OK!`;
      a.chatBubbleTimer=999;
    }
  }
  updateCard(a.id);
  syncDrawer();
}

function renderEngineList(){
  const host=document.getElementById('engine-status-list');
  const items=[...engineStatuses.values()];
  if(!items.length){
    host.innerHTML='<div class="engine-item"><div class="name">Mock</div><div class="meta">Browser demo mode</div></div>';
    return;
  }
  host.innerHTML=items.map((engine)=>`<div class="engine-item${engine.available?'':' offline'}"><div class="name">${engine.label}</div><div class="meta">${engine.available?'CLI available':'CLI not found'}</div></div>`).join('');
}

function formatAgentIdTag(id){
  return String(id).slice(0,5);
}

function addCard(a){
  const bt=BLDG_TYPES.find(b=>b.id===a.bt);const d=document.createElement('div');
  d.className='agent-card';d.id=`ac-${a.id}`;
  const badge=String(a.sessionKind||'').startsWith('codex-cli')?'<span class="agent-badge">YOU</span>':'';
  const removeButton=a.locked?'':`<button class="abtn-remove" title="Remove SCV">✕</button>`;
  d.innerHTML=`<div class="card-top"><div class="aname">${a.name}${badge}<span style="color:#556;font-size:9px;font-weight:normal"> (${formatAgentIdTag(a.id)})</span></div>${removeButton}</div><div class="astatus">Idle</div><div class="aengine">${fmtEngine(a.engine||'mock',a.model||'demo')}</div><div class="abldg">${bt.name}</div><div class="atask">Waiting</div><div class="pbar"><div class="pfill"></div></div>`;
  const removeEl=d.querySelector('.abtn-remove');
  if(removeEl)removeEl.onclick=(e)=>{e.stopPropagation();void removeAgent(a.id);};
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
  c.className='agent-card'
    +(a.sessionKind?' session':'')
    +(a.state==='building'?' building':'')
    +(a.progress>=1&&a.runStatus!=='running'?' done':'')
    +(a.runStatus==='failed'?' failed':'');
  const status=agentStatusMeta(a);
  st.textContent=status.text||'Idle';
  st.style.color=status.color;
  const wsLabel=a.workspaceBranch?` · ${a.workspaceBranch}`:'';
  engineEl.textContent=fmtEngine(a.engine||'mock',a.model||'demo')+wsLabel;
  taskEl.textContent=a.taskTitle||'Waiting';
  fl.style.width=`${a.progress*100|0}%`;
  fl.className='pfill'+(a.progress>=1&&a.runStatus!=='running'?' complete':'');
  syncDrawer();
}
function updCnt(){document.getElementById('agent-count').textContent=`Agents: ${agents.length}`;}
