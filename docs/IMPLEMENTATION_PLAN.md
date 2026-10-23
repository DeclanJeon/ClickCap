# ClickCap 개선 작업지시서

본 문서는 `docs/PRODUCT_DESIGN.md`의 실행 작업 목록이다. ClickCap은 WebM으로만 다운로드하고, 다른 포맷 변환은 제공하지 않는다.

## 완료된 이번 변경
- [x] 녹화 시작 시 Chrome Side Panel을 열고, 전체/영역 시작과 pause/resume/stop 조작을 패널로 분리한다.
- [x] Side Panel 녹화에서 페이지 도크/crop 표시를 숨기고, 정지 후 WebM 다운로드가 끝날 때까지 finalizing 상태를 유지한다.
- [x] Chrome downloads API 완료/중단 상태에 따라 object URL을 다운로드 완료 후 정리한다.
- [x] 팝업에 Original/1080p/720p/480p 출력 해상도 상한 선택기를 추가한다.
- [x] `DEFAULT_PREFERENCES`와 저장/복원/실시간 설정 갱신에 `outputResolution`을 반영한다.
- [x] Offscreen 출력 캔버스에서 종횡비 유지, 확대 금지로 출력 크기를 산출한다.

## 후속 구현 작업

### A. 산출물 포맷 신뢰성
- [x] 실제 앱에서 사용되지 않으며 잘못된 MP4/GIF 산출물을 만들던 `src/worker/format-converter.js`를 제거한다.
- [x] 팝업에서 GIF 등 인앱 출력 포맷 선택을 제거하고 WebM 저장 및 외부 변환 안내만 제공한다.
- `MediaRecorder.isTypeSupported()`의 결과에 따라 WebM 코덱을 선택하며 선택 MIME, Blob MIME, 파일 확장자를 일치시킨다.
- WebM 녹화 파일을 다운로드하며 변환은 사용자 선택의 외부 도구에 맡긴다. MP4/MKV 변환기나 관련 대용량/GPL 의존성을 추가하지 않는다.

### B. 결과 확인 및 다운로드
- 인코딩 중 취소/진행률/오류를 상태 모델에 연결하고 중복 stop 호출을 안전하게 처리한다.
- 완료 파일에 대해 이름/크기/해상도/길이/포맷 정보를 표시한다. 사용자가 요청한 단일 다운로드 행동을 유지한다.
- [x] Chrome downloads API의 완료/중단 이벤트를 처리하고 완료 후 object URL을 해제한다.
- 실제 ClickCap WebM 파일을 Linux 기본 플레이어에서 재생해 코덱/컨테이너 호환성을 E2E 검증한다.

### C. 녹화 제어와 설정
- [x] Side Panel의 pause/resume/stop UI와 finalizing 상태를 녹화 상태에 연결한다.
- 실제 Chrome에서 Side Panel 열기, pause/resume/stop, 영역 선택 및 페이지 도크 숨김을 E2E 확인한다.
- 녹화 FPS/비트레이트/해상도/오디오 옵션 조합의 검증을 입력 경계에 둔다. 유효하지 않은 저장값은 기본값으로 정규화한다.
- 실제 출력 차원이 표시된 녹화 상태와 예상 파일 용량 경고를 제공한다.

### D. 안정성 및 품질
- 스트림 트랙, timer, recorder event, object URL을 종료·실패·취소 경로마다 정리하는 통합 cleanup 경로를 검증한다.
- crop 좌표 계산에서 DPR, visualViewport, 페이지 스크롤, 화면 경계 및 10px 이하 선택을 테스트한다.
- 배경 서비스 워커 재시작/탭 닫힘/네비게이션 중 상태 복원 및 정리를 확인한다.
- 메시지 타입/데이터의 경계 검증과 실패 응답 계약을 통일한다. 외부 페이지에서 전달된 데이터는 신뢰하지 않는다.

## 테스트 작업지시
1. `npm test` 기존 테스트 기준선을 실행한다.
2. 해상도 계산의 단위 테스트를 유지한다: 원본보다 큰 상한에서도 확대되지 않음, landscape/portrait에서 종횡비 유지, 경계값 적용.
3. 팝업 저장/복원과 offscreen 설정 전달을 테스트한다.
4. Browser E2E: 영역 선택 후 WebM 녹화/정지/다운로드, 실제 파일 디코딩, Side Panel UI 및 오류 경로를 수행한다. (현재 자동화 브라우저 연결이 없어 미실행)
5. 각 구현 작업 후 `npm test`, `npm run lint` 실행. 현 package manifest의 lint/test 범위가 빠진 모듈을 포함하는지 확인한다.
6. Chrome 116+에서 전체 화면, 선택 영역, 1080/720/480/source, 세로/가로 화면 및 audio on/off를 수동 확인한다.

## 인수 조건
- 사용자가 선택한 영역 외의 픽셀이 결과물에 포함되지 않는다.
- 선택한 최대 높이보다 출력 높이가 크지 않고 원본 비율이 유지된다.
- 출력은 재생 가능하며 확장자/MIME이 실제 컨테이너와 일치한다.
- 잘못된 포맷/미지원 코덱/인코딩 실패를 성공으로 표시하지 않는다.
- 녹화 정지/취소/실패 후 리소스 및 녹화 UI가 남지 않는다.
- 기존 클릭 줌, 단축키, PonsLink는 회귀하지 않는다.

## 참고 구현 조사
- 저장소의 `src/offscreen/offscreen.js`가 실제 WebM 다운로드 경로의 기준이다.
- 잘못된 미사용 변환기 `src/worker/format-converter.js`는 제거했다. 검증 없이 새 포맷을 사용자에게 약속하지 않는다.
- 공개 레포 소스 복사는 하지 않는다. 필요 시 원본 라이선스, 유지보수, MV3/offscreen 제약을 확인하고 패턴만 참고하며 출처/라이선스를 기록한다.
