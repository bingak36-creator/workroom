# 0.3.0-rc.1 검증 기록

실행일: 2026-09-25 · macOS Apple Silicon · Node.js v26.5.0 · Electron 44.4.4.

이 문서는 실제 로컬 실행 결과를 기록합니다. 다른 OS/기기, 실제 ChatGPT 워크스페이스 인증, 공증 성공까지 검증한 것으로 확대 해석하지 않습니다.

## 조사 범위

초기 자작 소스·테스트·설정·스크립트·문서 31개를 기준으로 읽고 점검했습니다. 파일별 원본 해시와 백업은 `artifacts/release-audit/baseline-1790301963085/manifest.json`에 있습니다. `node_modules`의 모든 구현을 전수 감사했다는 뜻은 아닙니다. 의존성은 lockfile·실제 빌드·npm audit·패키지 구성을 점검했습니다. WCC의 다른 프로젝트와 사용자의 실제 앱 데이터는 수정 대상이 아닙니다.

수정 전 타입검사와 기존 테스트 29개가 통과했지만, 다음 항목은 별도 개선이 필요했습니다.

| 발견 항목 | 수정·검증 |
|---|---|
| 삭제 명령 문자열 검사만으로 프로젝트 밖 접근을 차단한다고 표시 | 잘못된 보장 제거. 명령 수동 확인을 기본값으로 하고 모두 자동을 명시적 고급 모드로 분리 |
| 완료 원문을 제거한 뒤 동일 파일 요청 재시도 판정 실패 | 원문 없는 SHA-256 요청 영수증을 저장. 정리·재시작 이후 동일성 검사 |
| 기록 한도 도달 시 대기·실행 중 요청까지 제거 가능 | 종료 상태의 표시 기록만 정리. 활성 요청은 보존 |
| 긴 명령 완료까지 MCP 응답 지연 | 접수와 결과를 분리하고 queued/running을 명확히 표시 |
| 권한을 껐다 켤 때 대기 작업이 다시 실행될 위험 | 대기·실행 작업을 취소·중지하고 자동 재실행 금지 |
| 지연 기록 저장 실패와 종료 처리의 불명확성 | 저장 오류 통지·실행 일시 정지, flush와 종료 대기, 타이머 정리 |
| 파일 경계와 특수 파일·Unicode 처리 | FIFO·링크·NUL·잘못된 Unicode 차단, BOM/한글/이모지 보존 |
| 일반 UI 스냅샷의 MCP 비밀 주소 노출 | UI 스냅샷에서 제거; 명시적 복사 동작만 유지 |
| 파일 UI의 불필요한 반복 갱신과 많은 실행 카드 | 갱신 병합·숨은 창 제한·40개씩 표시·터널 상태 캐시 |
| SDK가 응답 보안 헤더를 덮어씀 | 최종 writeHead 단계의 보호 헤더 강제 및 실제 HTTP 검증 |
| 빌드·런타임 버전 및 배포 검증 부족 | 0.3.0-rc.1 버전 일치 검사, lockfile 검사, DMG/ZIP 및 패키지 UI 검사 |

## 실제 성공한 검사

2026-09-25 11:48 KST에 `npm run package:mac` 전체 파이프라인이 종료 코드 0으로 완료되었습니다.

| 검사 | 결과 | 증거 파일 |
|---|---|---|
| TypeScript 타입검사 | 통과 | `artifacts/release-audit/verify.json` |
| Vitest 전체 테스트 | 44개 통과 — workspace 37, tunnel 7 | `artifacts/release-audit/tests.json` |
| 프로덕션 빌드 | main/preload/renderer 통과 | `artifacts/release-audit/verify.json` |
| 소스 앱 Electron UI + HTTP/STDIO MCP | 통과 | `artifacts/release-audit/ui-smoke.json` |
| 모의 터널 UI 수명주기 | 통과 | `npm run smoke:tunnel` 실행 결과 |
| 설치된 공식 tunnel-client + 로컬 모의 제어 서버 | 준비 상태·필수 poll 확인 통과 | `artifacts/native-tunnel-smoke-result.json` |
| 패키징된 Workroom.app UI + MCP | 통과 | `artifacts/release-audit/packaged-smoke.json` |
| ad-hoc 코드 서명 무결성 | codesign 검증 통과 | `npm run package:mac` 실행 결과 |
| 패키지 구성 검사 | ASAR 931개 항목; 소스·테스트·백업 디렉터리 제외; 제거한 토큰 API 없음 | `artifacts/release-audit/package-audit.json` |
| 정식 배포 사전 조건 | 서명 자격증명 없이 정식 경로 중단 확인 | `artifacts/release-audit/package-audit.json` |
| npm audit | 등록된 취약점 0건 | `artifacts/release-audit/npm-audit.json` |

Electron 검사는 실제 창에서 프로젝트 추가, 권한 설정, 파일 생성·해시 읽기·재시도, 명령 승인·거절, 자동 실행 모드의 네이티브 취소/동의, 테스트 파일 삭제, 실행 중지, 기록 정리와 재시작을 수행합니다. 임시 프로젝트와 임시 앱 데이터만 사용합니다. UI 캡처는 같은 디렉터리의 `ui-smoke.png`, `packaged-smoke.png`에 있습니다.

패키지 검사에서 측정한 파일 제안 접수는 한 번의 로컬 샘플에서 13ms였습니다. 이는 전체 ChatGPT 응답 시간, 모델 추론 시간, 네트워크 지연이나 일반적인 성능 향상 배율을 의미하지 않습니다. 기존 성능과 동일 조건으로 반복 비교한 벤치마크는 수행하지 않았습니다.

## 생성된 배포 후보

`release-candidate/`에 다음 파일을 생성했습니다.

| 파일 | 크기(byte) | SHA-256 |
|---|---:|---|
| `Workroom-0.3.0-rc.1-arm64-preview.dmg` | 131940886 | `32370d8c648939a892f05c62e5e4b4c1b998eb33a736bd3223b66d65fa727b41` |
| `Workroom-0.3.0-rc.1-arm64-preview.zip` | 127515076 | `01800abec6bee0c1c733ed0fb2b542565ff1add84c6e1d19d75030c412bb758f` |

`release-candidate/release-manifest.json`에는 `signing: ad-hoc preview`, `notarized: false`, `published: false`가 기록되어 있습니다. 위 해시는 이번 산출물의 값이며 다시 빌드하면 달라질 수 있습니다. 새 빌드에서는 생성된 manifest와 `SHA256SUMS.txt`를 기준으로 확인합니다.

## 2026-09-27 미출시 변경 검증

소스 앱 기준입니다. 패키지·DMG는 다시 만들지 않았고, 실행 중인 `release-candidate` 앱은 교체하지 않았습니다.

| 검사 | 결과 |
|---|---|
| `npm run verify` | 타입검사·빌드 통과, Vitest 50개 통과 — workspace 43, tunnel 7 |
| `npm run smoke` (소스 Electron UI + HTTP/STDIO MCP) | 통과. 자동 파일 변경 한 번의 호출로 `done`(40ms), `resultHash`로 `file_patch` 연쇄, UI 중지 시 대기 중인 호출이 `cancelled`로 종료, 로케일 없는 실행에서 `printf '한글' \| wc -m` = 2 |
| 로케일 수정 제거 후 `npm run smoke` | 예상대로 실패(`commands need a UTF-8 character locale`). 복원 후 통과 |
| `npm run smoke:tunnel`, `npm run check:release` | 통과 |
| 17초 명령 대기 경계(임시 스크립트, HTTP와 STDIO 각각) | 제안 응답 15.04초에 `running`, 이어진 `job_get` 약 2초 뒤 `done`. STDIO 브리지 30초 제한 안에서 끝남 |
| 긴 명령 카드(임시 스크립트, 80줄 명령) | 명령 영역 높이 240px·스크롤, 승인 버튼이 화면 안에 보임 |

실제 ChatGPT 계정·터널로 새 도구를 호출하는 확인은 하지 않았습니다.

## 2026-09-28 비밀 경로·환경변수 변경 검증

macOS Apple Silicon · Node.js v26.4.0 · 소스 0.3.0-rc.3의 미배포 변경 기준입니다. 실제 사용자 비밀파일이나 환경변수 값 대신 임시 프로젝트와 가짜 값만 사용했습니다.

| 검사 | 결과 |
|---|---|
| `npm run verify` | 타입검사·빌드 통과, Vitest 71개 통과 — workspace 50, tunnel 8, security-boundary 13 |
| 비밀 경로 | 자동·수동 명령에서 읽기·복사·이름 변경·삭제·실행·새 파일 작성 차단. 대소문자 변형, 비밀 경로를 프로젝트 루트로 등록하는 시도, 심볼릭 링크·하드링크 우회 검사 |
| 환경변수 | UI 허용 이름 중 요청한 변수만 전달. 없는 값·미허용 이름·예약 이름·값 객체 거부. stdout/stderr 및 청크에 걸친 원문 값 가리기, 상태 파일에 원문 값 없음 |
| 실제 요청 | 수동 승인 명령이 선택한 가짜 OS 변수로 로컬 HTTP 서버에 인증 요청 성공. 자동 명령의 네트워크 요청은 거부 |
| 권한 취소 | 최종 파일 검사 중 권한 취소 시 명령 시작과 파일 삭제 방지. 부모가 먼저 종료돼도 같은 그룹의 SIGTERM 무시 자식 종료 |
| `npm run smoke` | 실제 Electron UI에서 이름 허용 목록 저장, HTTP/STDIO MCP, 수동 승인 후 .env 읽기 거부, 선택 변수만 전달, 출력 원문 값 가리기, 재시작 후 이름 목록 복원 통과 |
| `npm run check:release` | 버전·lock·릴리스 문서 검사 통과 |

증거는 `artifacts/release-audit/verify.json`, `tests.json`, `ui-smoke.json`, `environment-settings.png`입니다. 새 패키지·설치본은 만들거나 교체하지 않았습니다. Windows 네이티브 실행, 외부 HTTPS 서비스, 실제 ChatGPT 터널은 이번 변경의 검증 범위가 아닙니다.

## 2026-10-02 rc.4 자동승인 편의·보안 통합 검증

macOS Apple Silicon의 rc.4 소스에서 타입검사·빌드와 Vitest 81개를 통과했습니다. 자동승인 빠른 시작·중지, 기존 폴더 범위 유지, 확인 중 변경된 범위 거부, 명시적 재시작 유지, 미완료 요청 취소와 권한 회수까지 10개 회귀 테스트를 추가했습니다. 실제 Electron UI에서도 취소·동의, 두 프로젝트의 서로 다른 재시작 정책, 재시작 후 끄기와 최소 창 너비를 확인했습니다. 환경변수 제한과 비밀파일 차단 검사는 계속 포함됩니다. 배포 직전 `npm audit` 결과는 0건입니다.

소스 검증은 `artifacts/release-audit/{verify,tests,ui-smoke,npm-audit-rc4}.json`, UI 캡처는 `automatic-settings.png`에 있습니다. 패키징 파이프라인은 macOS·Windows별 소스/패키지 UI 검사를 실행하며, 각 배포 파일의 SHA-256과 manifest를 생성합니다. 실제 패키지 검증 완료 여부는 해당 실행의 JSON 보고서와 GitHub Actions 결과에서 확인합니다.

## 아직 완료하지 않은 범위

Developer ID 서명, Apple 공증, Gatekeeper를 통과하는 정식 설치본, 실제 배포자의 지원·개인정보·보안 신고 채널 확정은 별도입니다. 정식 빌드의 별도 깨끗한 Mac 설치·업그레이드 테스트와 독립 보안 검토도 수행하지 않았습니다. Windows x64는 GitHub Actions의 네이티브 검사 결과를 사용하며 Linux/Intel Mac/Windows ARM은 배포 검증 대상이 아닙니다.

터널 테스트는 로컬 모의 제어 서버 또는 모의 클라이언트를 사용했습니다. 사용자의 OpenAI 런타임 키를 대신 읽거나 실제 계정 인증을 수행하지 않았습니다. 일반 ChatGPT에서 새 버전 도구를 등록·호출하는 최종 계정 연결은 별도 확인해야 합니다.

무제한 임의 명령을 OS 샌드박스로 만드는 기능, 같은 OS 사용자 악성 프로세스와의 완전한 격리, 저장 데이터 암호화, 이미 수행한 작업의 자동 롤백은 구현 범위가 아닙니다. 테스트 통과와 npm audit 0건이 취약점 0개를 보장하지는 않습니다.
