# 멀티 LLM 병렬 작업 + 스타크래프트 SCV/배럭 UI 제안서

## 1. 결론부터

이 프로젝트는 이제 `브라우저 데모` 단계에서 `실제 로컬 CLI 오케스트레이션` 단계로 넘어가야 한다. 핵심 결론은 아래 4개다.

1. 실제 `codex`/`claude`/`gemini` 같은 로컬 CLI를 돌리려면 기본 실행 모드는 더 이상 단순 `src/index.html` 브라우저 오픈이 아니라 `Electron live mode`가 되어야 한다.
2. 병렬 코딩은 같은 폴더에 여러 에이전트를 동시에 붙이면 거의 반드시 충돌하므로, 기본 전략은 `에이전트별 독립 worktree + 공유 메모리 + 통제된 머지`여야 한다.
3. UI는 지금의 SCV/배럭 프로토타입을 유지하되, 작업 단위가 시작될 때마다 기존 배럭을 폭발 효과와 함께 철거하고 `0%부터 다시 건설`하게 만드는 방식이 가장 자연스럽다.
4. 1차 버전은 각 CLI의 `비대화형/스트리밍 모드`를 감싸는 오케스트레이터로 구현하고, 진짜 실시간 CLI TUI 임베딩은 2차 버전으로 미루는 것이 맞다.

## 2. 현재 코드 기준 진단

### 현재 장점

- [src/index.html](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/index.html) 안에 이미 다음이 들어 있다.
- SCV 상태 머신
- 배럭 건설 진행률
- 우측 에이전트 목록
- 제거 `✕` 버튼
- 건설/완료/폭발 관련 사운드 훅
- 배럭 클릭 히트 판정
- 미니맵

### 현재 한계

- 렌더러 로직이 거의 전부 [src/index.html](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/index.html)에 한 파일로 들어 있어, 실제 멀티 에이전트 상태/IPC/CLI 실행을 얹기 시작하면 유지보수가 급격히 어려워진다.
- [src/main.js](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/main.js)는 아직 더미 `agent-event` IPC만 있고, 실제 프로세스 실행/스트림 구독/상태 저장이 없다.
- [src/preload.js](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/preload.js)는 `sendAgentEvent()`만 노출하고 있어서, 렌더러가 실시간 이벤트를 구독할 수 없다.
- 현재 작업 폴더는 Git 저장소가 아니다. 병렬 코딩용 `git worktree` 전략을 쓰려면 먼저 저장소화가 필요하다.

## 3. 유사 프로젝트 조사와 여기서 뽑아야 할 패턴

### A. `par`

- GitHub: <https://github.com/amantus-ai/par>
- 핵심 패턴:
- 에이전트마다 `git worktree`를 따로 만든다.
- 각 에이전트를 `tmux` 세션에서 따로 돌린다.
- 에이전트 간 메시징을 지원한다.

이 프로젝트에서 가져와야 할 점은 매우 명확하다. `같은 프로젝트를 병렬 코딩하려면 작업 디렉터리를 물리적으로 분리해야 한다`는 점이다. 이건 선택이 아니라 기본 안전장치다.

### B. LangChain / LangGraph 멀티 에이전트 문서

- 문서: <https://docs.langchain.com/oss/python/langchain/multi-agent>
- 핵심 패턴:
- `supervisor` 패턴: 중앙 조정자가 하위 에이전트에게 작업을 분배
- `handoff` 패턴: 특정 에이전트가 다른 에이전트에게 컨텍스트를 넘김
- `context engineering`: 모든 에이전트에게 같은 정보를 다 주지 말고 필요한 정보만 준다

이 프로젝트에서는 이 패턴이 그대로 맞는다. UI에는 여러 SCV가 보여도, 내부적으로는 `오케스트레이터 1개 + 작업 에이전트 N개` 구조가 가장 합리적이다.

### C. AutoGen Teams

- 문서: <https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html>
- 핵심 패턴:
- 여러 에이전트를 팀으로 묶고
- 순차 또는 선택 기반으로 발화시키고
- 공용 대화 컨텍스트를 팀 레벨에서 관리한다

이 프로젝트에서는 이걸 그대로 쓰기보다, `공유 대화 채널`과 `개별 작업 채널`을 분리하는 설계에 참고하는 게 맞다.

### D. 각 CLI의 현재 실행 가능성

- 로컬 확인 결과
- `codex` CLI 설치됨
- `claude` CLI 설치됨
- `gemini` CLI는 현재 이 머신에 없음
- 공식/1차 소스
- Gemini CLI README: <https://github.com/google-gemini/gemini-cli>
- Codex CLI는 로컬 `codex --help`, `codex exec --help` 기준으로 `exec`, `--json`, `-C`를 지원
- Claude Code는 로컬 `claude --help` 기준으로 `-p`, `--output-format stream-json`, `--worktree`, `--tmux`를 지원

즉, 1차 버전은 `Codex + Claude`를 바로 붙일 수 있고, `Gemini`는 설치 확인 후 어댑터만 추가하면 된다.

## 4. 제품 목표를 다시 정의

사용자가 원하는 최종 동작은 아래와 같다.

1. 에이전트를 UI에서 추가한다.
2. 각 에이전트는 엔진을 가진다. 예: `Codex`, `Claude`, `Gemini`.
3. 작업을 시작하면 그 에이전트 SCV가 자기 배럭을 처음부터 다시 짓는다.
4. 이미 배럭이 완성돼 있더라도 새 작업이 시작되면 기존 배럭은 삭제되고 다시 건설된다.
5. 여러 에이전트가 서로 독립적으로 일할 수 있다.
6. 필요하면 서로 메시지를 주고받거나, 공유 컨텍스트를 통해 협업할 수 있다.
7. 작업이 끝나면 배럭이 완성되고 SCV가 음성으로 완료를 말한다.
8. 배럭을 클릭하면 해당 작업의 상세 로그, 프롬프트, 변경 파일, 요약, 대화 기록이 펼쳐져야 한다.
9. 우측 `✕`로 에이전트를 삭제하면 SCV/배럭이 효과음과 함께 사라져야 한다.
10. 브라우저용 데모는 유지해도 되지만, 실제 CLI 작업은 Electron에서만 동작해야 한다.

## 5. 추천 아키텍처

### 최종 추천

`Electron main process = 오케스트레이터`, `renderer = 게임 UI`, `engine adapter = CLI 래퍼`, `workspace manager = worktree 담당` 구조로 간다.

### 구조도

```text
Renderer(Canvas/UI)
  -> preload bridge
  -> IPC
Electron Main
  -> AgentOrchestrator
  -> EngineAdapters(codex/claude/gemini)
  -> WorkspaceManager(worktree/branch/shared notes)
  -> RunStore(state/transcripts/artifacts)
  -> EventBus(renderer push + agent-to-agent messages)
```

### 왜 이 구조가 맞는가

- 브라우저 JS는 로컬 CLI 프로세스를 직접 실행할 수 없다.
- Electron main process는 `child_process.spawn()`으로 CLI를 병렬 실행할 수 있다.
- 렌더러는 오직 `정규화된 이벤트 스트림`만 받으면 되므로, 게임 연출과 엔진별 실행 로직을 분리할 수 있다.
- 나중에 엔진이 추가돼도 `adapter`만 늘리면 된다.

## 6. 가장 중요한 설계 원칙

### 원칙 1. 공유 작업과 공유 디렉터리는 다르다

에이전트끼리 협업은 가능하지만, 같은 물리 디렉터리를 동시에 쓰게 하면 안 된다.  
`공유`는 아래를 뜻해야 한다.

- 공용 브리프 파일 공유
- 이전 에이전트 요약 공유
- 메시지 채널 공유
- 패치/디프 공유
- 통제된 머지

즉, `같이 일한다`와 `같은 폴더를 동시에 편집한다`를 분리해야 한다.

### 원칙 2. UI는 이벤트 기반으로만 움직인다

렌더러가 CLI stdout을 직접 해석하면 안 된다.  
반드시 main process에서 아래처럼 정규화해서 보내야 한다.

```json
{
  "type": "run.phase",
  "agentId": "agent-03",
  "runId": "run_20260316_001",
  "phase": "coding",
  "progress": 0.58,
  "label": "src/index.html 분리 중",
  "timestamp": "2026-03-16T12:30:22.000Z"
}
```

### 원칙 3. CLI TUI 임베딩보다 헤드리스 실행부터

1차 버전은 각 CLI의 structured output을 사용한다.

- Codex: `codex exec --json`
- Claude: `claude -p --output-format stream-json`
- Gemini: 가능하면 CLI structured mode, 안 되면 API adapter 또는 stdout parser

이 방식이 맞는 이유:

- 엔진별 ANSI/TUI를 캔버스 안에 그대로 심는 건 구현비용이 너무 크다.
- structured output이 있어야 진행률, 단계, 메시지, 완료 상태를 안정적으로 잡을 수 있다.
- 취소/재시작/재할당이 쉬워진다.

## 7. 추천 작업 모드

### 모드 1. `Solo`

- 에이전트 1개가 자기 worktree에서 독립 작업
- 다른 에이전트와 메시지 없음
- 가장 안정적

### 모드 2. `Shared Brief`

- 에이전트별 worktree는 유지
- 공용 `brief.md`, `decision-log.md`, `shared-context.md`를 함께 읽음
- 각자 독립 구현 가능

### 모드 3. `Relay`

- 리더 에이전트가 계획 수립
- 구현 에이전트들이 분담
- 리뷰 에이전트가 마지막 검수

### 모드 4. `Chat`

- 에이전트들끼리 질문/응답/요약을 주고받음
- 단, 1차 버전은 `체크포인트 기반 메시지 공유`만 권장
- 완전한 실시간 자유 대화는 2차 버전

## 8. CLI는 실제로 어떻게 굴릴 것인가

### 8-1. 에이전트 실행 단위

한 번의 작업은 아래 단위로 본다.

```ts
AgentRun = {
  id: string;
  agentId: string;
  engine: "codex" | "claude" | "gemini";
  model: string;
  mode: "solo" | "shared-brief" | "relay" | "chat";
  workspaceDir: string;
  branchName: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  phase: "queued" | "planning" | "coding" | "testing" | "summarizing" | "done";
  prompt: string;
  summary: string;
  filesChanged: string[];
  startedAt: string;
  endedAt?: string;
};
```

### 8-2. 엔진별 실행 방식

#### Codex

권장 예시:

```bash
codex exec \
  --json \
  --skip-git-repo-check \
  -C "$WORKTREE" \
  "$PROMPT"
```

설명:

- `--json`으로 structured event를 받는다.
- `-C`로 worktree 디렉터리를 분리한다.
- 현재 프로젝트가 Git repo가 아니므로 초기에는 `--skip-git-repo-check`가 필요할 수 있다.
- 다만 병렬 코딩 정식 버전에서는 Git repo를 먼저 만드는 것이 맞다.

#### Claude

권장 예시:

```bash
claude -p \
  --output-format stream-json \
  --permission-mode auto \
  --add-dir "$SHARED_DIR" \
  "$PROMPT"
```

설명:

- `stream-json`으로 진행 스트림을 받는다.
- `--add-dir`로 공유 컨텍스트 폴더를 읽게 할 수 있다.
- Claude는 자체 `--worktree` 옵션도 있지만, 오케스트레이터가 공통 방식으로 workspace를 관리하는 편이 낫다.

#### Gemini

권장 방향:

```bash
gemini -p "$PROMPT"
```

설명:

- 공식 Gemini CLI는 `-p/--prompt` 및 자동 실행 옵션 계열이 있다.
- 현재 이 머신에는 CLI가 없으므로, UI에는 `Unavailable` 상태로 먼저 노출하고 설치 후 adapter를 붙이는 방식이 안전하다.
- Gemini는 structured stdout 안정성이 실제 구현 전에 다시 확인되어야 한다. 불안정하면 API adapter로 우회하는 편이 낫다.

### 8-3. CLI를 UI와 연결하는 방식

추천은 `실행 세션 = child_process 1개`다.

각 세션은 아래를 가진다.

- `process`
- `stdout buffer`
- `stderr buffer`
- `current phase`
- `progress`
- `cancel token`
- `transcript file path`

메인 프로세스는 stdout을 읽어서 `EngineAdapter.parseChunk()`에 넘기고, adapter는 이를 공통 이벤트로 바꾼다.

## 9. 왜 1차 버전에서 PTY/터미널 임베딩을 미루는가

사용자가 궁금해한 부분이 `CLI에서는 어떻게 작업하게 해야 되느냐`인데, 답은 아래처럼 두 단계로 나눠야 한다.

### 1차: 헤드리스 작업 오케스트레이션

- UI에서 작업 시작
- main process가 CLI를 비대화형 모드로 실행
- stdout 이벤트를 받아 진행률/상태 반영
- 완료 후 결과 요약/파일 목록 표시

장점:

- 구현 난이도가 낮다
- 엔진 추가가 쉽다
- 상태 동기화가 쉽다
- 병렬 실행 제어가 쉽다

### 2차: 진짜 터미널 세션 붙이기

- 필요하면 각 에이전트에 PTY를 붙여 실제 TUI를 보여준다
- 이건 `terminal pane`, `attach`, `resume`, `stdin passthrough`까지 필요하다

단점:

- 엔진마다 UI/키입력/ANSI 처리 방식이 다르다
- structured 상태 파싱이 어려워진다
- 지금 단계에서 비용 대비 이득이 낮다

즉, 첫 구현은 절대 PTY 중심으로 가면 안 된다.

## 10. 추천 UI 레이아웃

### 중앙 캔버스

- 기존 캔버스 유지
- 배럭 크기/패널 크기를 조금 더 줄여서 다중 에이전트가 더 많이 보이게 조정
- 현재 상단 44px, 우측 260px인데, 다음 정도 권장
- 상단 바 `36px`
- 우측 에이전트 패널 `220px`
- 좌측 레이어 패널 `160~180px`
- 미니맵 `128x80`

### 좌측 새 패널: `레이어 / 작전도`

추가 권장 항목:

- 뷰 토글
- `SCV`
- `배럭`
- `작업선`
- `에이전트 대화선`
- `미니맵`
- 필터
- 엔진별
- 상태별
- 협업 모드별
- 정렬
- 실행 중 우선
- 최근 완료 우선

이 패널은 사용자가 말한 `에이전트목록 왼쪽 레이어 하나` 역할을 한다.

### 우측 패널: `에이전트 목록`

현재 구조를 유지하되 카드 내용을 늘린다.

- 에이전트 이름
- 엔진 아이콘/라벨
- 모델
- 현재 작업명
- 상태
- 진행률
- 협업 모드
- `✕` 삭제

### 하단 또는 좌측 슬라이드 상세 패널: `배럭 상세`

배럭 클릭 시 펼쳐진다.

표시 내용:

- 작업 제목
- 원본 프롬프트
- 현재 phase
- 실행 로그 요약
- 변경 파일 목록
- 생성된 diff/patch
- 에이전트 간 메시지
- 실행 시간
- 실패 시 에러 로그

## 11. 애니메이션/연출 명세

### 에이전트 추가

1. 카드 생성
2. SCV 스폰
3. `scv_reportin` 또는 `scv_ready` 재생
4. 건물은 아직 없음 또는 반투명 슬롯만 표시

### 작업 시작

이미 배럭이 있으면:

1. 배럭 선택 강조
2. 폭발 사운드
3. 배럭 제거
4. 진행률 0으로 초기화
5. SCV가 건설 위치로 이동
6. 용접/건설 루프 시작

배럭이 없으면:

1. SCV 이동
2. 기초 -> 골조 -> 외벽 -> 디테일 -> 완공

### 작업 진행률과 건설 단계 매핑

권장 매핑:

| 작업 phase | 배럭 단계 | 진행률 범위 |
|---|---|---|
| queued | 기초 예약 | 0.00~0.05 |
| planning | 기초/골조 | 0.05~0.20 |
| coding | 골조/외벽 | 0.20~0.70 |
| testing | 디테일 | 0.70~0.90 |
| summarizing | 마감 | 0.90~0.98 |
| done | 완공 | 1.00 |

주의:

- 토큰 수 기반 진행률보다 `phase 기반 진행률`이 훨씬 안정적이다.
- 엔진이 phase를 명확히 안 주면, stdout 키워드나 내부 체크포인트로 phase를 합성해야 한다.

### 작업 완료

1. 진행률 100%
2. 완공 플래시
3. `scv_jobdone` 음성
4. 카드 상태 `건설 완료`
5. 배럭 클릭 시 작업 상세 노출

### 작업 실패

권장 연출:

1. 배럭 60~85% 선에서 정지
2. 붉은 연기/경고 테두리
3. 카드 상태 `실패`
4. 상세 패널에서 stderr/에러 요약 표시

### 에이전트 삭제

1. 실행 중이면 먼저 취소
2. SCV/배럭 폭발 효과
3. 카드 제거
4. 슬롯 반환

현재 [src/index.html](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/index.html)에 이미 제거 훅이 있으므로, 이 로직을 `removeAgent()`와 `cancelRun()` 연결형으로 확장하면 된다.

## 12. 에이전트 간 대화는 어떻게 붙일 것인가

### 권장 방식: `Message Bus`

```ts
AgentMessage = {
  id: string;
  fromAgentId: string;
  toAgentId: string | "broadcast";
  runId: string;
  kind: "question" | "answer" | "summary" | "handoff" | "warning";
  body: string;
  createdAt: string;
  consumed: boolean;
};
```

### 1차 구현

- 작업 중간중간 에이전트가 `checkpoint summary`를 남긴다.
- 다른 에이전트는 새 작업 시작 시 또는 다음 phase 진입 시 그 요약을 읽는다.
- 즉시 실시간 자유 채팅보다, `체크포인트 공유`가 우선이다.

### 2차 구현

- 특정 에이전트에 `질문 보내기`
- 응답이 오면 두 배럭 사이에 짧은 통신선/핑 이펙트 표시
- 상세 패널에 대화 스레드 누적

## 13. 파일 구조 제안

현재처럼 모든 걸 [src/index.html](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/index.html)에 유지하면 곧 막힌다. 아래처럼 분리하는 것을 권장한다.

```text
scv-agent-animation/
  src/
    main.js
    preload.js
    index.html
    main/
      orchestrator/
        agent-orchestrator.js
        run-store.js
        workspace-manager.js
        message-bus.js
        preflight.js
      engines/
        base-adapter.js
        codex-adapter.js
        claude-adapter.js
        gemini-adapter.js
    renderer/
      app.js
      state/store.js
      ui/topbar.js
      ui/left-layer-panel.js
      ui/right-agent-panel.js
      ui/task-drawer.js
      game/scene.js
      game/entities/agent.js
      game/entities/barracks.js
      game/entities/effects.js
```

## 14. 파일별 수정 지시

### [src/main.js](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/main.js)

현재:

- Electron 창 생성
- 더미 IPC 핸들러 1개

바꿔야 할 내용:

- `AgentOrchestrator` 초기화
- IPC 핸들러 등록
- renderer 이벤트 push 채널 등록
- 앱 종료 시 child process 정리

추가할 IPC 예시:

- `agent:list`
- `agent:create`
- `agent:remove`
- `run:start`
- `run:cancel`
- `run:retry`
- `message:send`
- `state:get`
- `events:subscribe`

### [src/preload.js](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/preload.js)

현재:

- `sendAgentEvent()`만 있음

바꿔야 할 내용:

- `window.clawcraft` 또는 `window.agentAPI` 노출
- invoke + event subscription 모두 제공

예시:

```js
contextBridge.exposeInMainWorld('clawcraft', {
  listAgents: () => ipcRenderer.invoke('agent:list'),
  createAgent: (payload) => ipcRenderer.invoke('agent:create', payload),
  removeAgent: (agentId) => ipcRenderer.invoke('agent:remove', agentId),
  startRun: (payload) => ipcRenderer.invoke('run:start', payload),
  cancelRun: (runId) => ipcRenderer.invoke('run:cancel', runId),
  sendMessage: (payload) => ipcRenderer.invoke('message:send', payload),
  onEvent: (handler) => {
    const wrapped = (_, evt) => handler(evt);
    ipcRenderer.on('orchestrator:event', wrapped);
    return () => ipcRenderer.removeListener('orchestrator:event', wrapped);
  }
});
```

### [src/index.html](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/index.html)

현재:

- CSS + HTML + 게임 로직 + UI 카드 로직이 전부 인라인

바꿔야 할 내용:

- HTML shell만 남기고 JS는 모듈로 이동
- 좌측 레이어 패널 DOM 추가
- 상세 drawer DOM 추가
- 엔진 선택 UI 추가
- 브라우저 단독 실행 시 mock 모드로 fallback

권장 DOM 변경:

- `#left-panel`
- `#task-drawer`
- `#engine-create-modal`

### 새 파일: `src/main/orchestrator/agent-orchestrator.js`

역할:

- 전체 에이전트 등록/삭제
- 실행 큐 관리
- child process 생명주기 관리
- 엔진 adapter 선택
- 이벤트 정규화 후 renderer로 broadcast

핵심 메서드:

- `createAgent(config)`
- `removeAgent(agentId)`
- `startRun(payload)`
- `cancelRun(runId)`
- `retryRun(runId)`
- `sendMessage(msg)`
- `emit(event)`

### 새 파일: `src/main/orchestrator/workspace-manager.js`

역할:

- worktree 또는 workspace 생성
- 공용 컨텍스트 폴더 관리
- run별 artifact 폴더 관리

권장 경로:

```text
.clawcraft/
  shared/
    brief.md
    decision-log.md
    messages.ndjson
  runs/
    run_*/
      transcript.ndjson
      summary.md
      files.json
  worktrees/
    agent-01/
    agent-02/
```

중요:

- 현재는 Git repo가 아니므로, 1순위 작업은 루트 저장소화다.
- 저장소화 전에는 임시 `workspace copies`로 시뮬레이션 가능하지만 정식 운영에는 비추천이다.

### 새 파일: `src/main/engines/codex-adapter.js`

역할:

- Codex CLI command 생성
- JSONL stdout 파싱
- phase/progress 추론

필수 메서드:

- `isAvailable()`
- `buildCommand(run)`
- `parseStdout(line)`
- `cancel(proc)`

### 새 파일: `src/main/engines/claude-adapter.js`

역할:

- Claude CLI command 생성
- `stream-json` 이벤트를 공통 이벤트로 변환

### 새 파일: `src/main/engines/gemini-adapter.js`

역할:

- 설치 여부 확인
- 미설치 시 `available:false`
- 설치 후 prompt 실행 / stdout 파싱

### 새 파일: `src/renderer/state/store.js`

역할:

- renderer 단일 상태 저장소
- agent / run / message / selection / filters 저장

예시 shape:

```ts
{
  agents: Record<string, AgentViewModel>,
  runs: Record<string, RunViewModel>,
  messages: AgentMessage[],
  selectedAgentId: string | null,
  selectedRunId: string | null,
  leftPanel: { filters: {}, layers: {} },
  drawerOpen: boolean
}
```

### 새 파일: `src/renderer/game/scene.js`

역할:

- 기존 캔버스 렌더 루프 유지
- 다만 데이터 소스는 로컬 배열이 아니라 store state 사용
- `demolishing`, `failed`, `chatting` 같은 상태 추가

### 새 파일: `src/renderer/ui/task-drawer.js`

역할:

- 배럭 클릭 시 작업 상세 표시
- prompt / summary / changed files / logs / messages 표시

## 15. 상태 머신 제안

현재 Agent state:

- `idle`
- `move_to_build`
- `building`
- `complete`
- `patrol`
- `idle_at_bldg`
- `manual_move`
- `manual_idle`

추천 추가 상태:

- `queued`
- `demolishing`
- `planning`
- `coding`
- `testing`
- `summarizing`
- `failed`
- `cancelled`
- `chatting`

권장 해석:

- 화면 애니메이션은 기존 `move_to_build/building/complete`를 유지
- 논리 상태는 위처럼 더 세분화
- 즉, `logic state`와 `animation state`를 분리하는 것이 좋다

## 16. 배럭 클릭 UX 제안

현재는 배럭 클릭이 선택 위주다. 바꿔야 한다.

추천:

1. 배럭 클릭
2. 해당 agent/run 선택
3. 좌/하단 상세 drawer 오픈
4. 상세 패널에서 아래 탭 제공
- `개요`
- `로그`
- `변경 파일`
- `대화`
- `실행 이력`

추가 권장:

- 배럭 위에 작은 엔진 배지 표시
- `C` = Codex
- `A` = Claude
- `G` = Gemini

## 17. 에이전트 생성 UX 제안

`+ 에이전트 추가` 버튼 클릭 시 간단한 생성 모달:

- 이름
- 엔진
- 모델
- 역할
- 협업 모드
- 기본 workspace 전략

권장 역할:

- `builder`
- `reviewer`
- `planner`
- `researcher`

실제 연출:

- 생성 즉시 SCV 등장
- 음성 재생
- 우측 카드 생성
- 아직 작업이 없으면 배럭 없음

## 18. 병렬 작업의 안전 규칙

다른 에이전트에게 그대로 전달해야 하는 핵심 규칙이다.

1. 두 에이전트가 같은 worktree를 동시에 편집하지 않는다.
2. 공유는 파일 시스템 공유가 아니라 컨텍스트 공유다.
3. 공용 브랜치에 직접 쓰지 않는다.
4. 에이전트 결과는 `diff`, `summary`, `changed files`로 정규화한다.
5. 병합은 리뷰 단계 또는 사람 승인 단계가 있어야 한다.

## 19. 추천 머지 전략

### 기본 추천: `Lead + Workers + Reviewer`

- Lead: 작업 분해
- Workers: 각자 worktree에서 구현
- Reviewer: 결과 비교, 테스트, 머지 제안

이 구조가 좋은 이유:

- 사용자 요구인 `따로따로 작업`과 `공유 작업`을 둘 다 지원한다.
- UI에서도 명확하다.
- 리더/워커/리뷰어를 SCV 단위로 표현 가능하다.

### 머지 방식

- 1차: 사람 승인 후 수동 반영
- 2차: orchestrator가 patch apply 지원

## 20. 브라우저 모드는 어떻게 남길 것인가

브라우저 모드는 완전히 버릴 필요는 없다. 다만 역할을 분리해야 한다.

### Browser Demo Mode

- mock 에이전트
- fake progress
- fake logs
- 디자인/연출 테스트용

### Electron Live Mode

- 실제 CLI 실행
- 실제 파일 변경
- 실제 이벤트 스트림

즉, README도 이 구조로 바뀌어야 한다.

## 21. 구현 순서 제안

### Phase 0. 저장소 정리

1. 프로젝트 루트 Git 저장소화
2. `.clawcraft/` 작업 폴더 정의
3. renderer 로직 분리 시작

### Phase 1. 단일 에이전트 실연동

1. `main.js` 오케스트레이터 연결
2. `preload.js` 이벤트 구독 API 추가
3. Codex adapter 붙이기
4. 작업 시작 시 배럭 철거 후 재건설
5. 완료 시 상세 drawer 표시

### Phase 2. 멀티 에이전트 병렬화

1. 여러 child process 병렬 실행
2. 우측 카드에 엔진/모델/작업 상태 표시
3. 슬롯 충돌 없는 배럭 배치
4. 삭제/취소/재시작 동작 완성

### Phase 3. 공유 컨텍스트/메시지

1. shared brief
2. message bus
3. 배럭 간 통신 연출
4. 대화 탭

### Phase 4. 머지/리뷰 워크플로

1. reviewer agent
2. diff 비교 UI
3. 승인 후 반영

## 22. 다른 에이전트에게 바로 넘길 수 있는 구현 지시문

아래 순서로 작업하라고 전달하면 된다.

1. [src/index.html](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/index.html)의 인라인 JS를 `renderer` 모듈로 분리하라.
2. [src/main.js](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/main.js)에 더미 IPC 대신 `AgentOrchestrator`를 연결하라.
3. [src/preload.js](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/preload.js)에 `list/create/remove/start/cancel/subscribe` 브리지를 추가하라.
4. `codex-adapter`, `claude-adapter`, `gemini-adapter` 파일을 만들고 공통 인터페이스를 맞춰라.
5. 작업 시작 시 기존 배럭을 무조건 철거하고 0%에서 다시 건설하게 하라.
6. 배럭 클릭 시 선택만 하지 말고 `task drawer`를 열어 프롬프트/요약/로그/변경 파일을 보여주게 하라.
7. 우측 카드 `✕` 삭제는 `cancel -> explosion -> remove -> slot release` 순서로 바꿔라.
8. 좌측 `레이어/작전도` 패널을 추가하고 엔진/상태/협업 모드 필터를 넣어라.
9. 브라우저 모드는 mock runner를 쓰고, 실제 runner는 Electron에서만 켜지게 하라.
10. 병렬 코딩의 기본 workspace 전략은 반드시 `agent별 worktree`로 하라.

## 23. 하지 말아야 할 것

1. 모든 새 로직을 다시 [src/index.html](/Users/jayhyeoklim/Desktop/개발/ClawCraft/scv-agent-animation/src/index.html)에 계속 추가하지 말 것
2. 여러 에이전트를 같은 작업 디렉터리에서 동시에 돌리지 말 것
3. raw ANSI 터미널 파싱에 의존하지 말 것
4. 엔진별 상태 형식을 renderer에서 직접 처리하지 말 것
5. `공유 작업 = 같은 파일 직접 동시 수정`으로 이해하지 말 것

## 24. 최종 추천안

가장 현실적이고 좋은 1차 제안은 아래다.

- 실제 제품 모드는 Electron으로 고정
- Codex + Claude부터 live 연결
- Gemini는 `Unavailable` 상태로 먼저 노출 후 adapter 추가
- 에이전트별 독립 worktree
- 공유는 `shared brief + message bus + reviewer merge`
- 새 작업 시작 시 기존 배럭 철거 후 처음부터 재건설
- 배럭 클릭 시 작업 상세 drawer 오픈
- 우측 패널은 에이전트 카드
- 좌측 패널은 레이어/필터
- 브라우저 모드는 mock demo 유지

이 방식이 사용자 요구인 아래 3개를 가장 잘 만족한다.

- 스타크래프트식 시각 연출
- 멀티 엔진 병렬 작업
- 독립 작업과 공유 작업의 동시 지원

## 25. 참고 소스

- `par` GitHub: <https://github.com/amantus-ai/par>
- LangChain multi-agent docs: <https://docs.langchain.com/oss/python/langchain/multi-agent>
- AutoGen group chat docs: <https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html>
- Gemini CLI GitHub: <https://github.com/google-gemini/gemini-cli>
- 로컬 확인:
- `codex --help`
- `codex exec --help`
- `claude --help`
