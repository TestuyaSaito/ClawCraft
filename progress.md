Original prompt: 이 프로젝트 스타크래프트1 scv 가 베럭스 짓는 형식의 프로토타입은 다 만들었어. 이제 llm을 선택해서 코딩을 하거나 작업을 진행하면 그 모션이 건물짓는 모션이 되게 할거야. 이미 지어진 건물은 삭제되고 처음부터 다시지어지게 하면돼. claude나 codex, gemini 등 엔진들을 병렬로 놓고 서로 작업할수있게 할거야 따로따로작업 할수도있고, 서로 공유해서 작업할수도있어 대화하면서. 그걸 적용하려면 어떻게해야돼? 다른 유사한 프로젝트 있으면 병렬작업 어떻게하는지 찾아보고 나에게 추천 제시안을 제시해줘. 에이전트 추가도 되고, 필요없는 에이전트는 삭제할거야. 오른쪽에서 x눌러서 삭제하는 배럭과 scv는 효과음과 함꼐 사라질거고 추가하면 나타날거야. 근데 cli에서는 어떻게 작업하게 해야되는건지 궁금해. 제시안을 제안해주면 좋겠어. 작업시작하면 건물짓기 시작하고 끝나면 배럭 다지어지고 scv가 음성말하면서 끝나는거지. 그 배럭 클릭하면 어떤 작업이었는지 내용 쫙 나오고, 에이전트목록 왼쪽에 레이어 하나만들어서 해도되. 스타크래프트 게임ui이미지는 이미지이기 때문에 저것보다 더 작아도 되거든. 제안서 아주디테일하게 제시해줘, 다른 에이전트한테 전달할거 어딜 어떻게 고쳐야하는지.

- `develop-web-game` 스킬 지침 확인.
- 현재 구조 확인:
- 실질 앱은 `scv-agent-animation/src/index.html` 단일 파일 렌더러 구조.
- `src/main.js`와 `src/preload.js`는 최소 Electron 브리지 상태.
- 로컬 CLI 확인:
- `codex` 설치됨
- `claude` 설치됨
- `gemini` 미설치
- 웹 리서치 기반 제안서 작성:
- `par`의 worktree/tmux/message 패턴
- LangChain multi-agent의 supervisor/handoff/context engineering
- AutoGen group chat 팀 구조
- Gemini CLI 공식 GitHub
- 산출물:
- `docs/multi-agent-llm-starcraft-proposal.md` 추가

2026-03-16 phase 1 implementation:
- Electron main process live orchestrator 추가:
- `src/main/orchestrator/agent-orchestrator.js`
- `src/main/orchestrator/run-store.js`
- `src/main/orchestrator/workspace-manager.js`
- 엔진 어댑터 추가:
- `src/main/engines/codex-adapter.js`
- `src/main/engines/claude-adapter.js`
- `src/main/engines/gemini-adapter.js`
- `src/main.js`에 IPC 핸들러 연결:
- `agent:list`
- `engine:list`
- `state:get`
- `agent:create`
- `agent:remove`
- `run:start`
- `run:cancel`
- `src/preload.js`에 `window.clawcraft` 브리지 추가
- `src/index.html`에 아래 기능 추가:
- 엔진 선택 셀렉트
- 작업 프롬프트 입력
- 좌측 `작전 레이어` 패널
- 우하단 `task drawer`
- live/mock 상태 표시
- 에이전트 카드에 엔진/작업명 표시
- run 이벤트 기반 진행률 반영
- 새 작업 시작 시 기존 배럭 철거 후 재건설
- `window.render_game_to_text`
- `window.advanceTime`

검증:
- `AgentOrchestrator` 단독 smoke test:
- Codex run 성공
- Claude run 성공
- 브라우저 mock 모드 Playwright 로드 성공
- mock prompt 입력 + `#btn-start` 클릭 후 run 상태가 `running/coding`으로 변하는 것 확인
- task drawer가 카드 클릭으로 열리는 것 확인
- full-page screenshot: `output/web-game/full-page.png`
- canvas screenshot/state: `output/web-game/shot-*.png`, `output/web-game/state-*.json`

주의/남은 일:
- 현재 live 모드는 `in-place single-live-run` 제한
- Git/worktree 기반 병렬 live 실행은 아직 미구현
- renderer 로직은 여전히 `src/index.html` 단일 파일이라 다음 단계에서 분리 필요
- Gemini availability는 로컬 `command -v gemini` 기준으로 true가 나올 수 있으나 실제 run smoke test는 아직 안 돌림

TODO for next agent:
- 프로젝트 루트를 Git 저장소로 만들지 여부 먼저 결정
- `src/index.html` 분리 리팩터링부터 시작
- Electron main process에 orchestrator 뼈대 추가
- Codex/Claude adapter 2개 우선 구현
