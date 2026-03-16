// ═══════════════════════════════════════════════════════════════
// AUDIO MODULE — Web Audio Synthesis + Voice/Music playback
// ═══════════════════════════════════════════════════════════════

const VOICE_FILES={scv_ready:'../assets/sounds/voices/scv_reportin.mp3',scv_yessir:'../assets/sounds/voices/scv_yessir.mp3',scv_orders:'../assets/sounds/voices/scv_orders.mp3',scv_rightaway:'../assets/sounds/voices/scv_rogerthat.mp3',scv_rightaway_sir:'../assets/sounds/voices/scv_rightaway_sir.mp3',scv_jobdone:'../assets/sounds/voices/scv_jobfini.mp3',scv_explo:'../assets/sounds/voices/scv_explo.mp3',scv_affirmative:'../assets/sounds/voices/scv_affirmative.mp3',scv_ireadyou:'../assets/sounds/voices/scv_ireadyou.mp3',scv_build:'../assets/sounds/voices/scv_build.mp3'};
const MUSIC_FILES=['../assets/sounds/music/terran1.mp3','../assets/sounds/music/terran2.mp3','../assets/sounds/music/terran3.mp3'];
const SCV_VOICES=['scv_ready','scv_yessir','scv_orders','scv_rightaway','scv_affirmative','scv_ireadyou'];

let audioCtx=null,soundsOk=false,sounds={},audioEls={},bgMusic=null,bgPlaying=false,musicIdx=0;

function initAudio(){
  if(audioCtx)return;
  audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended')audioCtx.resume();
  genSounds();soundsOk=true;
  Object.entries(VOICE_FILES).forEach(([k,p])=>{const a=new Audio(p);a.preload='auto';audioEls[k]=a;});
}
function toggleMusic(){
  if(!bgMusic){bgMusic=new Audio(MUSIC_FILES[musicIdx]);bgMusic.volume=0.22;bgMusic.onended=()=>{musicIdx=(musicIdx+1)%MUSIC_FILES.length;bgMusic.src=MUSIC_FILES[musicIdx];bgMusic.play().catch(()=>{});}}
  if(bgPlaying){bgMusic.pause();bgPlaying=false;document.getElementById('btn-music').textContent='♪ 음악';}
  else{bgMusic.play().then(()=>{bgPlaying=true;document.getElementById('btn-music').textContent='♪ ON';}).catch(()=>{});}
}
function genSounds(){
  sounds.scv_ready=mkVoice(180,6,30,.15,.55);
  sounds.scv_yessir=mkVoice(210,9,45,.12,.45);
  sounds.scv_orders=mkVoice(170,5,25,.18,.5);
  sounds.scv_rightaway=mkVoice(225,11,50,.10,.48);
  sounds.scv_jobdone=mkVoice(195,7,35,.14,.65);
  sounds.weld=mkWeld(2.5);
  sounds.weld_short=mkWeld(.35);
  sounds.ching=mkChing();
  sounds.complete=mkComplete();
  sounds.click=mkTone(1200,.06,80);
  sounds.select=mkSelect();
}
function mkVoice(bf,mr,md,na,dur){
  const sr=audioCtx.sampleRate,len=sr*dur|0,buf=audioCtx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  for(let i=0;i<len;i++){
    const t=i/sr,env=Math.min(1,t/.03)*Math.min(1,(dur-t)/.08);
    const f=bf+Math.sin(6.283*mr*t)*md;
    const v=Math.sin(6.283*f*t)+Math.sin(6.283*f*2.5*t)*.4+Math.sin(6.283*f*3.8*t)*.15;
    const n=(Math.random()*2-1)*na,syl=Math.max(0,Math.sin(6.283*(4+dur*2)*t));
    let s=(v+n+Math.sin(6.283*60*t)*.05)*env*syl*.3;
    s=Math.tanh(s*2.5)*.35;
    if(t<.04||t>dur-.04)s+=(Math.random()*2-1)*.12*(1-Math.min(t,dur-t)/.04);
    d[i]=s;
  }return buf;
}
function mkWeld(dur){
  const sr=audioCtx.sampleRate,len=sr*dur|0,buf=audioCtx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  for(let i=0;i<len;i++){
    const t=i/sr;
    const env=(.6+.4*Math.sin(6.283*3*t))*Math.min(1,t/.02)*Math.min(1,(dur-t)/.05);
    const c1=Math.sin(6.283*3200*t)*Math.max(0,Math.sin(6.283*12*t));
    const c2=Math.sin(6.283*4800*t)*Math.max(0,Math.sin(6.283*18*t+1));
    const sz=(Math.random()*2-1)*Math.max(0,Math.sin(6.283*8*t))*.5;
    const sp=Math.random()>.97?(Math.random()*2-1)*.8:0;
    d[i]=Math.tanh((c1*.2+c2*.15+sz+Math.sin(6.283*120*t)*.15+sp)*env*.2*3)*.25;
  }return buf;
}
function mkChing(){
  const sr=audioCtx.sampleRate,dur=0.55,len=sr*dur|0,buf=audioCtx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  const hits=[0, 0.22];
  for(let i=0;i<len;i++){
    const t=i/sr;
    let s=0;
    hits.forEach(ht=>{
      const dt=t-ht;if(dt<0)return;
      const env=Math.exp(-dt*28)*(1-Math.exp(-dt*600));
      const f1=2200+ht*300;
      const f2=3800+ht*200;
      const metallic=Math.sin(6.283*f1*dt)*0.55+Math.sin(6.283*f2*dt)*0.3+Math.sin(6.283*f1*2.76*dt)*0.12;
      const impact=Math.exp(-dt*180)*(Math.random()*2-1)*0.4;
      s+=Math.tanh((metallic+impact)*1.8)*env*0.35;
    });
    d[i]=s;
  }return buf;
}
function mkComplete(){
  const sr=audioCtx.sampleRate,len=sr*1|0,buf=audioCtx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  for(let i=0;i<len;i++){
    const t=i/sr;
    const n1=Math.sin(6.283*880*t)*Math.max(0,1-t/.5)*(t<.5?1:0);
    const n2=Math.sin(6.283*1320*t)*Math.max(0,1-(t-.25)/.75)*(t>.25?1:0);
    d[i]=(n1*.3+n2*.25+Math.sin(6.283*2640*t)*Math.exp(-t*4)*.12)*.3;
  }return buf;
}
function mkTone(f,dur,decay){
  const sr=audioCtx.sampleRate,len=sr*dur|0,buf=audioCtx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  for(let i=0;i<len;i++){const t=i/sr;d[i]=Math.sin(6.283*f*t)*Math.exp(-t*decay)*.25;}return buf;
}
function mkSelect(){
  const sr=audioCtx.sampleRate,len=sr*.12|0,buf=audioCtx.createBuffer(1,len,sr),d=buf.getChannelData(0);
  for(let i=0;i<len;i++){const t=i/sr;d[i]=Math.sin(6.283*(600+t*2000)*t)*Math.exp(-t*25)*.2;}return buf;
}
function play(name,vol){
  if(!soundsOk||!sounds[name])return null;
  const s=audioCtx.createBufferSource(),g=audioCtx.createGain();
  g.gain.value=vol||1;s.buffer=sounds[name];s.connect(g);g.connect(audioCtx.destination);s.start(0);return s;
}
let vq=[],vp=false,vpCurrent=null;
function playV(n){vq.push(n);if(!vp)drainV();}
// Play voice immediately, cancel any queued/playing voices
function playVNow(n){
  vq=[];vp=false;
  // Stop currently playing voice
  if(vpCurrent){try{vpCurrent.pause();vpCurrent.currentTime=0;}catch(e){}}
  vpCurrent=null;
  const ae=audioEls[n];
  if(ae){const a=new Audio(ae.src);a.volume=0.7;a.play().catch(()=>{});vpCurrent=a;}
  else play(n,.7);
}
function drainV(){
  if(!vq.length){vp=false;return;}vp=true;const name=vq.shift();
  const ae=audioEls[name];
  if(ae){const a=new Audio(ae.src);a.volume=0.7;vpCurrent=a;a.addEventListener('ended',()=>setTimeout(drainV,150),{once:true});a.play().catch(()=>setTimeout(drainV,150));}
  else{const s=play(name,.7);if(s)s.onended=()=>setTimeout(drainV,150);else drainV();}
}

const buildAudioEls=new Map();
function startWeld(id){
  if(!audioEls.scv_build||buildAudioEls.has(id))return;
  const ba=new Audio(audioEls.scv_build.src);
  ba.loop=true;ba.volume=1.0;ba.play().catch(()=>{});
  buildAudioEls.set(id,ba);
}
function stopWeld(id){
  const ba=buildAudioEls.get(id);
  if(ba){ba.pause();ba.currentTime=0;buildAudioEls.delete(id);}
}
