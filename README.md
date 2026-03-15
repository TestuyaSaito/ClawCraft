# SCV Agent Animation

StarCraft SCV 기반 에이전트 작업 시각화 프로토타입.  
**Electron (데스크톱) 또는 브라우저** 모두 지원. 외부 의존성 제로.

## 구조

```
scv-agent-animation/
├── package.json
├── README.md
├── src/
│   ├── main.js              # Electron main process
│   ├── preload.js            # Context bridge
│   └── index.html            # ★ 전체 앱 (Canvas + WebAudio, 단일 파일)
```

## 실행 방법

### 방법 1: 브라우저에서 바로 실행 (가장 빠름)
```bash
# src/index.html 을 브라우저에서 열기
open src/index.html        # macOS
xdg-open src/index.html    # Linux
start src/index.html       # Windows
```

### 방법 2: Electron 데스크톱 앱
```bash
npm install
npm start
```

## 기능

### SCV 유닛
- **상태 머신**: idle → 이동 → 건설(용접) → 완료 → 순찰 → 건물 근처 대기
- **애니메이션**: 바디 밥, 팔 스윙, 용접 스파크, 배기 연기
- **음성**: "SCV ready!", "Yes sir!", "Orders?", "Right away sir", "Job's done" (Web Audio 합성)
- **클릭 반응**: 선택 원 + 음성 재생

### 건물
- **3종**: 커맨드 센터 / 서플라이 디팟 / 배럭
- **6단계 건설**: 기초 → 골조 → 외벽 → 디테일 → 완공
- **건설 효과**: 비계선, 진행률 바, 완공 플래시

### 사운드
- **SCV 음성 5종**: 라디오 필터 포먼트 합성
- **용접 효과음**: 찌직찌직 (전기 아크 + 크래클 + 험)
- **완공 차임**: 상승 2음 + 쉬머
- **UI 사운드**: 클릭, 선택

### 에이전트 시스템
- **병렬 작업**: N개 에이전트 동시 독립 건설
- **1:1 매핑**: 에이전트 1개 = SCV 1개
- **사이드 패널**: 실시간 상태 + 진행률
- **미니맵**: 좌하단 전체 맵 뷰

## 조작

| 입력 | 동작 |
|------|------|
| 화살표 / WASD | 카메라 이동 |
| 우클릭 드래그 | 카메라 팬 |
| SCV 좌클릭 | 유닛 선택 + 음성 |

## OpenClaw 연결 (추후)

`src/main.js`의 IPC 핸들러에 OpenClaw Gateway WebSocket (`ws://localhost:18789`) 연결 추가 예정.
이벤트 형식: `{ type: 'agent_start'|'tool_start'|'tool_end'|'agent_end', agentId, ... }`

## 기술 스택

| 구성요소 | 기술 | 외부 의존성 |
|---------|------|-----------|
| 렌더링 | Canvas 2D API | 없음 |
| 사운드 | Web Audio API | 없음 |
| 스프라이트 | 프로그래밍 생성 | 없음 |
| 데스크톱 | Electron 28 | npm install 시 |
| 에이전트 | WebSocket (준비) | OpenClaw 연결 시 |
