# Screen Recorder Debug Guide

## 문제 진단 가이드

발생한 문제들과 해결 방법:

### 1. "Failed to fetch" 아이콘 오류
**원인**: icons/recording.png 파일이 비어있었음
**해결**: 기존 아이콘으로 복사완료
```bash
cd icons
cp icon-128.png recording.png
cp icon-128.png not-recording.png
```

### 2. "Cannot capture a tab with an active stream" 오류
**원인**: 이전 세션에서 남은 streamId가 정리되지 않음
**해결**:
- service-worker.js의 `startCapture()`에서 stream 정리 로직 추가
- `recoverRecording()`에서 orphaned stream 정리
- offscreen document 재생성 전 cleanup

### 3. Dock가 표시되지 않음
**원인**: 메시지 타입 불일치 및 전달 경로 문제
**해결**:
- offscreen.js → service-worker → content-script 메시지 체인 수정
- `recording-stats` 메시지 전달 경로 확립
- error handling으로 메시지 실패 시 graceful degradation

### 4. Popup UI가 업데이트되지 않음
**원인**: popup과 service-worker 간 상태 동기화 부족
**해결**:
- `RECORDING_STATE_CHANGED` 메시지 타입 추가
- popup에 state change listener 구현
- service-worker에서 상태 변경 시 popup 알림

## 테스트 체크리스트

### 1. 기본 로드 테스트
```bash
# 확장 프로그램 리로드
chrome://extensions/ → Reload

# 콘솔 확인
Service Worker: "Recovering recording session..." 없어야 함
Popup: 기본 UI 정상 표시
```

### 2. 아이콘 테스트
```bash
# 아이콘 파일 확인
ls -la icons/*.png
# 모든 파일 크기 > 0 이어야 함
```

### 3. 녹화 시작 테스트
```bash
# 1. 팝업에서 Start Recording 클릭
# 2. 콘솔 로그 확인:
Service Worker: "[Service Worker] Creating new offscreen document"
Service Worker: "Got stream ID: ..."
Service Worker: "[Service Worker] Offscreen document already exists"
Offscreen: "[Offscreen] Starting recording with streamId: ..."
Offscreen: "[Offscreen] Media stream obtained successfully"
Offscreen: "[Offscreen] MediaRecorder created successfully"
```

### 4. Dock 표시 테스트
```bash
# 녹화 시작 후 Dock 확인
- 붉은색 영역 선택 테두리
- Floating Dock 패널 표시
- Duration 표시 (00:00:00)
- File size 표시 (0.00 MB)
```

### 5. 상태 동기화 테스트
```bash
# 녹화 중 popup 리로드
- UI가 Recording 상태로 자동 변경
- Stop 버튼 활성화
- "Recording" 상태 표시
```

## 디버깅 명령어

### Chrome DevTools 열기
```bash
# Service Worker 디버깅
chrome://extensions/ → Service Worker → inspect

# Popup 디버깅
익스텐션 아이콘 우클릭 → Inspect popup

# Content Script 디버깅
웹페이지 F12 → Console

# Offscreen Document 디버깅
chrome://extensions/ → Offscreen document → inspect
```

### 로그 필터
```
[Service Worker] - background events
[Offscreen] - recording events
[Popup] - UI events
Content Script Ready - injection status
```

## 자주 발생하는 문제들

### 1. 탭 권한 문제
```
Error: Cannot access chrome:// URLs
해결: 일반 웹페이지에서만 녹화 가능
```

### 2. MediaRecorder API 지원
```
Error: MediaRecorder is not available
해결: Chrome 116+ 필요
```

### 3. 메모리 부족
```
Error: Out of memory
해결: 브라우저 재시작, 탭 닫기
```

## 성공 시나리오

### ✅ 정상 작동 시 로그 순서:
1. "Content script ready in tab [id]"
2. "Creating new offscreen document" (첫 번째) 또는 "already exists" (재사용)
3. "Starting recording with streamId: [stream-id]"
4. "Media stream obtained successfully"
5. "MediaRecorder created successfully"
6. Dock 표시됨
7. Stats 업데이트 시작 (100ms 간격)

### ✅ UI 상태 변화:
1. Start → "Loading converter..." → "Converting..."
2. Icon: not-recording.png → recording.png
3. Button: Start → Stop
4. Status: Ready → Recording
5. Dock: 숨김 → 표시