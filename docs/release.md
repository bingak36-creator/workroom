# 릴리스 절차

대상은 macOS Apple Silicon입니다. Windows/Linux/Intel Mac은 검증된 배포 대상으로 표시하지 않습니다. 버전 `0.3.0-rc.2`는 배포 후보이며, 서명·공증 없는 프리뷰를 정식 출시본으로 안내하면 안 됩니다.

## 개발 환경 준비

Node.js 22.12 이상이 필요합니다. 프로젝트 루트에서 실행합니다.

```sh
npm ci
# npm 정책이 Electron 설치 스크립트를 차단한 경우, 이 스크립트만 실행합니다.
node node_modules/electron/install.js
npm run verify
npm run smoke
npm run smoke:tunnel
```

설치 스크립트를 전부 자동 허용하지 마세요. GUI 앱에서 Node/npm을 찾지 못하는 경우 Homebrew 설치 위치와 실제 Node 설치를 확인하세요. Workroom은 셸 환경을 최소화하므로 nvm 등 사용자 셸 초기화 파일을 자동 실행하지 않습니다.

`verify`는 타입검사, 전체 테스트, 프로덕션 빌드 결과를 `artifacts/release-audit/verify.json`과 `tests.json`에 기록합니다. `smoke`는 임시 데이터 폴더와 임시 프로젝트로 실제 Electron 창, 승인 모드, 파일 작업, MCP HTTP/STDIO와 재시작을 검사합니다. `smoke:tunnel`은 모의 클라이언트로 터널 UI를 검사하며 실제 OpenAI 인증 성공을 의미하지 않습니다.

## 로컬 배포 후보

```sh
npm run package:mac
```

순서: 릴리스 정적 검사 → 타입검사·테스트·빌드 → 실제 소스 앱 UI 검사 → 모의 터널 UI 검사 → DMG/ZIP 패키징 → 패키지 앱 UI 검사 → ad-hoc 서명 무결성 검사 → SHA-256 및 manifest 생성.

기본 출력은 기존 `release/`와 분리한 `release-candidate/`입니다. 이번 rc.2 검증 후보는 `WORKROOM_OUTPUT_DIR=release-rc2 npm run package:mac`으로 별도 경로에 만들었습니다.

```text
release-rc2/
  mac-arm64/Workroom.app
  Workroom-0.3.0-rc.2-arm64-preview.dmg
  Workroom-0.3.0-rc.2-arm64-preview.zip
  SHA256SUMS.txt
  release-manifest.json
```

이 후보는 로컬 ad-hoc 서명이며 Developer ID와 Apple 공증을 갖춘 정식 배포본이 아닙니다. Gatekeeper가 차단하거나 경고할 수 있습니다. 보안 기능을 전역 해제하거나 검역 속성을 무조건 제거하도록 안내하지 마세요. 불특정 사용자에게 배포하려면 아래 정식 경로를 완료합니다.

## 정식 서명 릴리스

배포자는 Apple Developer Program과 해당 앱을 배포할 권한이 있는 Developer ID 인증서, Apple 공증 자격증명을 준비해야 합니다. 비밀값은 소스·채팅·스크립트에 넣지 말고 로컬 키체인 또는 CI의 보호된 비밀 저장소에서 환경 변수로 주입합니다.

릴리스 스크립트는 `CSC_LINK` 또는 `CSC_NAME`과 공증 설정을 요구합니다. 공증은 `APPLE_ID`·`APPLE_APP_SPECIFIC_PASSWORD`·`APPLE_TEAM_ID`, 또는 App Store Connect API 키의 `APPLE_API_KEY`·`APPLE_API_KEY_ID`·`APPLE_API_ISSUER`, 또는 `APPLE_KEYCHAIN_PROFILE` 설정을 사용할 수 있습니다. 사용하는 electron-builder 버전에서 실제 선택한 방식이 지원되는지 확인합니다. 파일 경로나 환경 변수 존재만으로 자격증명이 유효한지는 알 수 없습니다.

```sh
node scripts/release.mjs --signed --check-credentials
npm run release:mac
```

정식 경로는 Developer ID 서명 강제, hardened runtime, 공증을 켭니다. 패키징 후 `codesign --verify`, Gatekeeper `spctl --assess`, `xcrun stapler validate`까지 통과해야 manifest를 생성합니다. 출력은 `release-public/`입니다. 어떤 경로에서도 `--publish never`를 사용하므로 이 명령이 앱을 인터넷에 게시하지 않습니다.

정식 빌드는 디버깅 CLI fuse를 끄므로 Playwright 검증은 프리뷰 패키지에서 수행합니다. 정식 서명 바이너리는 별도 깨끗한 Mac 계정/기기에서도 설치·실행·권한·업그레이드를 확인해야 합니다. 공개 배포 전 실제 지원·개인정보·비공개 취약점 신고 채널도 확정해야 합니다.

## 업그레이드와 롤백

현재 실행 중인 Workroom을 임의로 재시작하거나 사용자 데이터 위에 테스트 앱을 실행하지 않습니다. 앱을 종료한 상태에서 `~/Library/Application Support/Workroom`을 사용자가 선택한 안전한 위치에 백업합니다. 새 앱 시작 시 권한은 읽기 전용으로 초기화하며, 모두 자동 모드는 해제합니다. 작업·체크포인트는 보존하되 미완료 요청은 취소합니다.

문제가 있으면 앱을 종료하고 이전 앱과 해당 버전에서 백업한 데이터로 복원합니다. 새 형식의 데이터를 검증 없이 이전 앱에 덮어넣지 마세요. 원본 소스 점검 백업은 `artifacts/release-audit/baseline-*`에 있으며 패키지에는 포함되지 않습니다.

## 최종 체크

배포 시점에 다시 `npm audit`, 타입검사·테스트·빌드·UI 검증을 수행하고 결과를 보관합니다. 현재 기기의 성공만으로 모든 OS 버전과 사용자 계정에서의 동작을 보장하지 않습니다. 패키지에 소스 백업, 작업 기록, 자격증명, 실제 프로젝트 파일이 포함되지 않았는지도 확인합니다.

일반 ChatGPT의 Private Tunnel 연결과 앱/플러그인 공개 배포는 다릅니다. Secure MCP Tunnel은 비공개 연결용이며 공개 플러그인 제출용 연결 방식으로 사용할 수 없습니다. 공개 플러그인에는 별도의 안정적인 공개 HTTPS MCP 엔드포인트와 해당 배포 심사가 필요합니다. 이 프로젝트의 로컬 서버를 인증 없이 인터넷에 노출하지 마세요.

참고: [Electron 보안](https://www.electronjs.org/docs/latest/tutorial/security), [electron-builder v26 macOS](https://www.electron.build/v26/docs/mac/), [Vite 7 Node.js 요구사항](https://v7.vite.dev/guide/migration), [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [플러그인 연결 및 테스트](https://developers.openai.com/plugins/deploy/connect-chatgpt).
