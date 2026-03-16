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
// Build team context for an agent (browser-side PromptCompiler equivalent)
function buildTeamContext(agent,taskPrompt){
  let ctx='';
  const me=agent;
  const myName=me.nickname||me.displayName||me.name;
  ctx+=`You are **${myName}**.\n`;
  ctx+=`Engine: ${me.engine}, Model: ${me.model}\n\n`;
  // Teammates — identified by nickname
  const teammates=agents.filter(a=>a.id!==me.id);
  if(teammates.length>0){
    ctx+=`## Your teammates\n`;
    teammates.forEach(t=>{
      const tName=t.nickname||t.displayName||t.name;
      const status=t.runStatus==='running'?'working':t.state==='building'?'mining':'idle';
      ctx+=`- **${tName}** — ${t.engine}/${t.model}, status=${status}`;
      if(t.taskTitle&&t.taskTitle!=='Waiting')ctx+=`, task="${t.taskTitle}"`;
      ctx+='\n';
    });
    ctx+='\n';
  }
  // Recent radio (last messages from all agents)
  const allLogs=[];
  agents.forEach(a=>{
    const last=a.runLogs.slice(-3);
    last.forEach(l=>{
      if(l&&!l.startsWith('Sending to')&&!l.startsWith('MOCK START'))
        allLogs.push(`**${a.nickname||a.displayName||a.name}**: ${l.slice(0,150)}`);
    });
  });
  if(allLogs.length>0){
    ctx+=`## Recent radio\n${allLogs.slice(-8).join('\n')}\n\n`;
  }
  ctx+=`## Communication rules\n`;
  const exampleName=teammates[0]?(teammates[0].nickname||teammates[0].displayName||teammates[0].name):'teammate';
  ctx+=`- You can mention teammates by their nickname with @ (e.g. @${exampleName}).\n`;
  ctx+=`- Report what you're doing so teammates know.\n`;
  ctx+=`- Respond in the same language as the user's prompt.\n\n`;
  ctx+=`---\n\n## Current task\n${taskPrompt}`;
  return ctx;
}

async function callGeminiAPI(apiKey,prompt,agent){
  // Inject team context into prompt
  const fullPrompt=buildTeamContext(agent,prompt);
  const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  agent.appendRunLog(`Sending to Gemini...`);
  agent.applyRunPhase('coding',0.2,'Calling Gemini API...');
  const resp=await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      contents:[{parts:[{text:fullPrompt}]}],
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

// Delegate task to another agent (called after A walks to B and back)
async function delegateTaskToAgent(target,sender,prompt,apiKey,isGemini){
  const senderName=sender.nickname||sender.displayName||sender.name;
  const heavy=isHeavyTask(prompt);
  if(isGemini&&apiKey){
    const taskForTarget=`${senderName} asked you: "${prompt}". Help them.`;
    target.taskTitle=summarizePrompt(taskForTarget);
    if(heavy){
      target.beginLiveRun({id:`gemini-delegate-${Date.now()}`,prompt:taskForTarget,taskTitle:target.taskTitle,progress:.08,phase:'planning'});
      try{
        const resp=await callGeminiAPI(apiKey,taskForTarget,target);
        target.appendRunLog(resp);
        target.finishRun('done',{summary:resp.slice(0,200),filesChanged:[]});
      }catch(err){
        target.appendRunLog(`ERROR: ${err.message}`);
        target.finishRun('failed',{errorText:err.message});
      }
    } else {
      try{
        const resp=await callGeminiAPI(apiKey,`${senderName} says: "${prompt}". Reply briefly.`,target);
        target.chatBubble=resp.replace(/```[\s\S]*?```/g,'').replace(/[#*_`]/g,'').trim().slice(0,300);
        target.chatBubbleTimer=999;
        target.appendRunLog(resp);
      }catch(err){target.appendRunLog(`ERROR: ${err.message}`);}
    }
  } else {
    // Mock delegation
    if(heavy){
      target.beginLiveRun({id:`mock-delegate-${Date.now()}`,prompt:`Task from ${senderName}: ${prompt}`,taskTitle:`Helping ${senderName}`,progress:.08,phase:'planning'});
      let p2=.08;
      const t2=setInterval(()=>{
        p2=Math.min(1,p2+.1);
        target.applyRunPhase(p2<.5?'planning':'coding',p2,'Working...');
        if(p2>=1){clearInterval(t2);target.finishRun('done',{summary:`Helped ${senderName}`,filesChanged:[]});}
      },600);
    } else {
      target.chatBubble=`Roger! From ${senderName}.`;
      target.chatBubbleTimer=999;
    }
  }
  updateCard(target.id);
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
        a.chatBubble=response.replace(/```[\s\S]*?```/g,'').replace(/[#*_`]/g,'').trim().slice(0,300)+(response.length>300?'...':'');
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

  // === Shared Brief: detect @mentions and delegate to other agents ===
  const collabMode=document.getElementById('collab-mode')?.value||'solo';
  if(collabMode==='shared-brief'||collabMode==='relay'){
    // Find @mentions in the prompt (e.g. "@Miner-02" or "@Claude-01")
    const mentionPattern=/@([\w-]+)/g;
    let match;
    while((match=mentionPattern.exec(prompt))!==null){
      const mentionName=match[1];
      const target=agents.find(t=>
        t.id!==a.id&&(
          (t.name||'').toLowerCase().includes(mentionName.toLowerCase())||
          (t.nickname||'').toLowerCase().includes(mentionName.toLowerCase())||
          (t.displayName||'').toLowerCase().includes(mentionName.toLowerCase())
        )
      );
      if(target){
        target.appendRunLog(`Radio from ${a.nickname||a.displayName||a.name}: ${prompt}`);

        // A walks to B, delivers message, then walks back
        const savedState=a.state;
        const savedX=a.x,savedY=a.y;
        a.chatBubble=`Going to ${target.nickname||target.displayName||target.name}...`;
        a.chatBubbleTimer=999;
        // Walk A to B's position
        a.moveTo(target.x,target.y+20,()=>{
          // Arrived at B — show message
          a.chatBubble=`"${prompt.slice(0,50)}"`;
          a.chatBubbleTimer=999;
          target.chatBubble=`📨 ${a.nickname||a.displayName||a.name}: "${prompt.slice(0,50)}"`;
          target.chatBubbleTimer=999;
          // Walk A back to original position after 1.5s
          setTimeout(()=>{
            a.moveTo(savedX,savedY,()=>{
              a.chatBubble='';a.chatBubbleTimer=0;
              // Resume A's previous work if was mining
              if(savedState==='building'&&a.progress>=1){
                a.miningTarget=true;a.miningPause=0;
                a.setState('building');
              }
            });
            a.setState('manual_move');
          },1500);
          // After A leaves, B starts working
          setTimeout(()=>{
            if(typeof generateDelegationReport==='function')generateDelegationReport(target,a,prompt);
            delegateTaskToAgent(target,a,prompt,apiKey,isGeminiAgent);
          },2000);
        });
        a.setState('manual_move');

        // Live mode: also route through backend
        if(liveMode&&liveAPI.sendMessage){
          liveAPI.sendMessage({from:String(a.id),to:String(target.id),text:prompt,kind:'task'}).catch(()=>{});
        }
      }
    }
  }
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

// Nickname modal (Electron doesn't support window.prompt)
let _nickAgent=null;
function showNicknameModal(agent){
  _nickAgent=agent;
  const modal=document.getElementById('nick-modal');
  const input=document.getElementById('nick-modal-input');
  input.value=agent.nickname||agent.displayName||'';
  modal.classList.add('open');
  setTimeout(()=>input.focus(),50);
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('nick-modal-ok')?.addEventListener('click',()=>{
    if(!_nickAgent)return;
    const nick=document.getElementById('nick-modal-input').value.trim();
    _nickAgent.nickname=nick;
    _nickAgent.displayName=nick;
    if(nick)_nickAgent.name=nick;
    updateCard(_nickAgent.id);
    // Sync to backend — so Leader and other agents know the nickname
    if(liveMode&&liveAPI.setNickname){
      liveAPI.setNickname(String(_nickAgent.id),nick).catch(()=>{});
    }
    // Immediately save renderer state so nickname persists
    if(typeof saveRendererState==='function')saveRendererState();
    document.getElementById('nick-modal').classList.remove('open');
    _nickAgent=null;
  });
  document.getElementById('nick-modal-cancel')?.addEventListener('click',()=>{
    document.getElementById('nick-modal').classList.remove('open');
    _nickAgent=null;
  });
  document.getElementById('nick-modal-input')?.addEventListener('keydown',(e)=>{
    if(e.key==='Enter')document.getElementById('nick-modal-ok')?.click();
    if(e.key==='Escape')document.getElementById('nick-modal-cancel')?.click();
  });
});

function formatAgentIdTag(id){
  return String(id).slice(0,5);
}

function addCard(a){
  const bt=BLDG_TYPES.find(b=>b.id===a.bt);const d=document.createElement('div');
  d.className='agent-card';d.id=`ac-${a.id}`;
  const shortId=String(a.id).replace(/[^0-9a-zA-Z]/g,'').slice(0,5);
  const nickDisplay=a.nickname||a.displayName||'';
  d.innerHTML=`<div class="card-top"><div class="aname" style="color:#ffdd44;font-weight:bold;font-size:11px">${nickDisplay||a.name} <span style="color:#556;font-size:9px;font-weight:normal">(${shortId})</span></div><div style="display:flex;gap:2px"><button class="abtn-nick" title="Set nickname" style="background:none;border:none;color:#888;font-size:10px;cursor:pointer">✏</button><button class="abtn-stop" title="Emergency stop" style="background:none;border:none;color:#664444;font-size:10px;cursor:pointer;display:none">⏹</button><button class="abtn-remove" title="Remove SCV" style="background:none;border:none;color:#664444;font-size:11px;cursor:pointer">✕</button></div></div><div class="astatus" style="font-size:10px;margin-top:2px"></div><div class="aengine" style="font-size:9px;color:#666;margin-top:1px">${fmtEngine(a.engine||'mock',a.model||'demo')}</div><div class="atask" style="font-size:9px;color:#666;margin-top:1px">Waiting</div><div class="pbar"><div class="pfill"></div></div>`;
  const removeEl=d.querySelector('.abtn-remove');
  if(removeEl)removeEl.onclick=(e)=>{e.stopPropagation();void removeAgent(a.id);};
  const nickEl=d.querySelector('.abtn-nick');
  if(nickEl)nickEl.onclick=(e)=>{
    e.stopPropagation();
    const agent=findAgent(a.id);
    if(!agent)return;
    showNicknameModal(agent);
  };
  const stopEl=d.querySelector('.abtn-stop');
  if(stopEl)stopEl.onclick=(e)=>{
    e.stopPropagation();
    const agent=findAgent(a.id);
    if(agent&&agent.runId&&liveMode&&liveAPI.cancelRun){
      liveAPI.cancelRun(agent.runId);
      updateLiveStatus(`Stopped: ${agent.name}`);
    }
    stopWeld(a.id);
    if(agent){agent.chatBubble='⚠ Stopped';agent.chatBubbleTimer=3;}
  };
  d.onclick=(e)=>{
    const agent=findAgent(a.id);
    if(!agent)return;
    if(!e.ctrlKey&&!e.metaKey){
      clearSelection();
    }
    if(agent.selected&&(e.ctrlKey||e.metaKey)){
      agent.selected=false;
      selectedAgents.delete(agent.id);
      const c=document.getElementById(`ac-${agent.id}`);
      if(c)c.classList.remove('selected');
    } else {
      selectAgent(agent);
    }
    agent.select();
    syncCardSelection();
  };
  document.getElementById('agent-list').appendChild(d);
  updateCard(a.id);
}
function updateCard(id){
  const a=agents.find(a=>a.id===id);if(!a)return;const c=document.getElementById(`ac-${id}`);if(!c)return;
  const st=c.querySelector('.astatus'),fl=c.querySelector('.pfill');
  const engineEl=c.querySelector('.aengine'),taskEl=c.querySelector('.atask');
  c.className='agent-card'
    +(a.state==='building'?' building':'')
    +(a.progress>=1&&a.runStatus!=='running'?' done':'')
    +(a.runStatus==='failed'?' failed':'')
    +(a.selected?' selected':'');
  st.textContent=a.runStatus==='running'?(a.runLabel||'Working'):'';
  st.style.color=a.runStatus==='running'?'#f0a030':'#666';
  // Sync nickname into card name and canvas display name
  const nameEl=c.querySelector('.aname');
  const displayName=a.nickname||a.displayName||a.name;
  const shortId=String(a.id).replace(/[^0-9a-zA-Z]/g,'').slice(0,5);
  if(nameEl)nameEl.innerHTML=`${displayName} <span style="color:#556;font-size:9px;font-weight:normal">(${shortId})</span>`;
  // Engine
  engineEl.textContent=fmtEngine(a.engine||'mock',a.model||'demo');
  taskEl.textContent=a.taskTitle||'Waiting';
  // Show/hide stop button based on run status
  const stopBtn=c.querySelector('.abtn-stop');
  if(stopBtn)stopBtn.style.display=a.runStatus==='running'?'inline':'none';
  fl.style.width=`${a.progress*100|0}%`;
  fl.className='pfill'+(a.progress>=1&&a.runStatus!=='running'?' complete':'');
  syncDrawer();
}
function updCnt(){document.getElementById('agent-count').textContent=`Agents: ${agents.length}`;}

// ═══════════════════════════════════════════════════════════════
// REPORT PANEL — SCV agent reports to the commander
// ═══════════════════════════════════════════════════════════════
const reports=[];
let reportPanelCollapsed=false;

function toggleReportPanel(){
  const panel=document.getElementById('report-panel');
  reportPanelCollapsed=!reportPanelCollapsed;
  panel.classList.toggle('collapsed',reportPanelCollapsed);
}

function fmtKST(date){
  const d=new Date(date);
  const y=d.getFullYear();
  const mo=String(d.getMonth()+1).padStart(2,'0');
  const da=String(d.getDate()).padStart(2,'0');
  const h=String(d.getHours()).padStart(2,'0');
  const mi=String(d.getMinutes()).padStart(2,'0');
  return `${y}/${mo}/${da} ${h}:${mi}`;
}

function addReport(agentId,agentName,title,content){
  const report={
    id:`rpt-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    agentId,
    agentName,
    title:title.slice(0,80),
    content,
    timestamp:Date.now(),
    read:false,
  };
  reports.unshift(report);
  if(reports.length>50)reports.length=50;
  renderReports();
  updateReportBadge();
}

function renderReports(){
  const body=document.getElementById('rp-body');
  if(!body)return;
  body.innerHTML=reports.map(r=>`<div class="rp-item" id="rpi-${r.id}" onclick="toggleReport('${r.id}')">
  <div class="rp-item-head">
    <div class="rp-item-sender">
      <div class="rp-nick">${r.agentName}</div>
      <div class="rp-time">${fmtKST(r.timestamp)}</div>
    </div>
    <div class="rp-item-title${r.read?'':' unread'}">${r.title}</div>
  </div>
  <div class="rp-item-content">${r.content}</div>
</div>`).join('');
}

function toggleReport(id){
  const report=reports.find(r=>r.id===id);
  if(!report)return;
  const el=document.getElementById(`rpi-${id}`);
  if(!el)return;
  const wasExpanded=el.classList.contains('expanded');
  // Close all others
  document.querySelectorAll('.rp-item.expanded').forEach(e=>e.classList.remove('expanded'));
  if(!wasExpanded){
    el.classList.add('expanded');
    if(!report.read){
      report.read=true;
      const titleEl=el.querySelector('.rp-item-title');
      if(titleEl)titleEl.classList.remove('unread');
      updateReportBadge();
    }
  }
}

function updateReportBadge(){
  const badge=document.getElementById('rp-badge');
  if(!badge)return;
  const unread=reports.filter(r=>!r.read).length;
  if(unread>0){
    badge.style.display='inline-block';
    badge.textContent=unread>9?'N':`${unread}`;
  } else {
    badge.style.display='none';
  }
}

// Generate a report from an agent after run completion
function generateAgentReport(agent,status,run){
  const name=agent.nickname||agent.displayName||agent.name;
  const task=agent.taskTitle||'작업';
  if(status==='done'){
    const title=`${task} 완료 보고`;
    const summary=(run&&run.summary)?run.summary.replace(/[#*_`]/g,'').trim().slice(0,200):'작업을 성공적으로 완료했습니다.';
    const files=(agent.filesChanged&&agent.filesChanged.length>0)?`\n변경 파일: ${agent.filesChanged.length}개`:'';
    const content=`주인님 충성! 보고드립니다!\n\n${task} 작업 완료했습니다.\n결과: ${summary}${files}\n\n이상입니다!`;
    addReport(agent.id,name,title,content);
  } else if(status==='failed'){
    const errMsg=agent.errorText||run?.errorText||'원인 불명';
    const title=`${task} 실패 보고`;
    const content=`주인님 충성! 보고드립니다!\n\n${task} 작업 중 문제가 발생했습니다.\n오류: ${errMsg}\n\n이상입니다!`;
    addReport(agent.id,name,title,content);
  }
}

// Generate delegation report (when agent relays work from another agent)
function generateDelegationReport(target,sender,task){
  const targetName=target.nickname||target.displayName||target.name;
  const senderName=sender.nickname||sender.displayName||sender.name;
  const title=`${senderName} 지시사항 수령 보고`;
  const content=`주인님 충성! 보고드립니다!\n\n${senderName} 님이 지시한 작업을 전달받았습니다.\n내용: "${task.slice(0,100)}"\n현재 작업에 착수합니다.\n\n이상입니다!`;
  addReport(target.id,targetName,title,content);
}
