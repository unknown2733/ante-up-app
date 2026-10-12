---
type: working
project_id: solana-colosseum
status: current
created: 2026-10-12
updated: 2026-10-12
source: "현재 대화의 A 착수·저장소 확인·공통 계약 정리·별도 세션 작업 요청; ante-up a11a4edf92287fd6f6425a18c33e34d1301a5a8f; 테스트넷 MVP 구현 명세"
review_question:
---

# A: 저장소 점검과 공통 계약

> Integration revision 0.2: read [CONTRACT_V02.md](CONTRACT_V02.md) first for corrected API, recovery, replay, numeric and evidence boundaries. It supersedes conflicting v0.1 technical details below.

## 1. 요청과 조사 범위

사용자: “A부터 진행하자. 기존 저장소를 확인해서 재사용할 부분이랑 새로 구현할 부분을 나누고, 병렬 구현 전에 맞춰야 할 공통 계약부터 정리해줘. 병렬구현은 지금 이 세션말고 각기 다른 세션들 만들어서 작업 진행했으면 좋겠어.”

이 문서는 저장소 조사 결과와 구현 계약 v0.1, 별도 Codex 세션 인계의 정본이다. 제품/경제 결정은 [구현 명세](<2026-10-12 테스트넷 MVP 구현 명세.md>)가 연결하는 accepted Decisions를 따른다. 필드·단위·폴더·오류 이름·반올림은 이번 A의 기술 기준이며 사용자가 각각 직접 선택했다고 기록하지 않는다. 실제 배포·외부 서비스 작동·경제 안전성의 검증을 뜻하지 않는다.

## 2. 저장소에서 확인한 사실

- GitHub `unknown2733/ante-up`의 원격 HEAD/main은 `a11a4edf92287fd6f6425a18c33e34d1301a5a8f`다. 2026-10-12 `git ls-remote`로 확인했다.
- 로컬 `.codex-work/github-publish/ante-up`도 같은 커밋이며 미커밋 변경이 없었다. 원격 갱신/기존 공유본 수정은 하지 않았다.
- 추적 파일은 **9개 Markdown**이다: AGENTS, README, docs의 START_HERE/CONTEXT/PRODUCT_VISION/DECISIONS/PRD/GLOSSARY/BLOCKCHAIN_BASICS. 소스·package manifest·Anchor/Cargo·API·DB·테스트·CI는 없다. UI가 이미 구현돼 있다는 근거도 없다.
- GitHub 연결 도구는 404였지만 로컬 Git 자격 증명으로 원격 ref 확인에 성공했다. 404를 저장소 부재로 해석하지 않았다.
- 현재 셸에서 Node v24.15.0/npm/Git은 확인했다. cargo/rustc/anchor/solana는 PATH에서 발견되지 않았다. 다른 환경 전체에 설치되지 않았다는 뜻은 아니다. Rust/validator 검증 환경은 B의 선행 조건이다.

### 재사용/수정/신규 대응

| 대상 | 판정 | 후속 구현에서의 취급 |
| --- | --- | --- |
| 제품명·구호·첫 사용자·기록/금전 경로 설명 | 재사용 | README/비전의 제품 맥락 유지 |
| 입문 설명·용어·사용자 사례 | 참고 재사용 | 온보딩 카피 참고. 현재 계약과 다른 TBD는 후속 명세 우선 |
| 기존 PRD·DECISIONS·AGENTS의 기술 미정 표기 | 구현 기준 갱신 필요 | 10월11일 공유본. H3/D7·고정c/Pmax·무료3개·구체 비용/정산 등은 10월12일 후속 결정으로 대체 |
| 브랜드 이미지/슬라이드 | 저장소 외 참고자료 | 자동 UI 자산 복사/외부 공개하지 않음. 이번 저장소에서 코드 자산으로 확인되지 않음 |
| 컨트랙트·수집·API·모바일·증명·배포 | 신규 | 기존 실행 코드 마이그레이션 비용은 없으나 골격부터 필요 |

특히 이전 DECISIONS의 ‘고정5c를 사용하지 않는다’ 문구를 새 구현에 적용하면 최신 결정과 충돌한다. **MVP는 c/Pmax를 졸업 시 고정**한다. 주간 표시 기준 변경이 가격 재배율을 뜻하지 않는다.

## 3. 작업공간과 소유 경계

A의 기준 복제본: `.codex-work/implementation/ante-up-a`. 기존 공유본을 보존한 로컬 개발 산출물이다. 정본 지식은 이 문서/기존 Decisions에 남긴다. 원격 push는 이번 요청에 포함하지 않는다. 코드의 지속 작업은 별도 세션의 프로젝트 없는 외부 작업공간으로 복제해 진행하고, 통합 때 각 로컬 커밋을 가져온다.

| 소유 | 경로 | 다른 작업에서 다루는 방법 |
| --- | --- | --- |
| A 통합 | `contracts/`, `docs/implementation/`, 루트 공통 설정/안내 | 읽기 전용 소비. 변경은 제안과 영향 목록으로 인계 |
| B 온체인 | `programs/`, `tests/chain/`, `clients/chain/`, Anchor/Cargo 설정 | 생성 클라이언트가 공개 인터페이스. 공유 금고 회계 소유 |
| C/E 데이터·증명 | `services/data/`, `services/evidence/`, 해당 모듈 테스트 | observation/snapshot/manifest 계약 생산 |
| D API·조회 | `services/api/`, `services/indexer/`, `services/keeper/`, DB migration | 공개 DTO/인덱싱/인증/조회/실행 요청 조립 |
| F 웹 | `apps/web/` | 공통 DTO와 클라이언트를 소비, 경제 계산 재작성 금지 |

7개 서비스 배포를 강제하지 않는다. 작업별 package manifest/lockfile을 자기 경로에 두어 첫 분할의 충돌을 줄인다. 루트 workspace 전환/공통 lockfile은 A 통합에서 결정한다. 각 세션은 독립 clone에서 작업하며 원본 및 다른 세션 파일을 수정하지 않는다.

## 4. 공통 계약 v0.1

### 4.1 단위와 버전

- 결제/키워드 토큰/내부 지분 단위는 소수6자리 정수. 체인 수량 u64, 중간 계산 checked wide integer; 오버플로면 거래 거절. 내부 지분은 추가 유통 토큰 발행을 뜻하지 않는다.
- API의 정수는 십진 문자열. 시간은 UTC Unix 초 정수, 버킷은 `[start,end)`이고 정확히60초. 금액을 JS Number로 계산하지 않는다.
- EWMA 활동률 `S`는 일 환산 건수, Q12(1e12) 정수 문자열. C는 반감기3일의 분 단위 반복식을 결정적으로 구현하고 오차/상수 생성 검증을 제출한다. `r`의 표시용 반올림을 금전 계산에 쓰지 않는다.
- 지표 비율은 `(S_now,S_7d)`의 유리수. 시장 가격은 졸업 시 `(P_G,S_G,S_G7)` 앵커로 계산한다. 중간 c를 잘라 반복 곱하지 않고 한 번만 가격 최소 단위로 내린다. 상한 가격 예약은 위로 올린 경계로 확보한다.
- 실제 거래가격 `priceAtoms=floor(P_G*S_G7/S_G*min(S_now/S_7d,5))`, `maxPriceAtoms=ceil(5*P_G*S_G7/S_G)`. 표시 c는 정보용. 주간 h=0에서도 나눗셈으로 가격을 재설정하지 않고 원 앵커를 유지한다.
- 실제 S=0과 결측/분모0은 다르다. 유효한0가격은 기존 지급식의 평가에 사용할 수 있지만 신규 Pro/0기준 무료 성과 분모는 허용하지 않는다. 정밀도 때문에 양수가0으로 잘리는 경우 `PRECISION_UNDERFLOW`로 중단하고 실제0으로 취급하지 않는다.
- `schemaVersion`, `formulaVersion`, `configVersion`, `queryVersion`은 별도. 체인/시장 identity는 cluster+programId+marketAddress. fixture ID는 실주소가 아니며 라이브 모드에 사용할 수 없다.

### 4.2 반올림과 회계

| 계산 | 규칙 |
| --- | --- |
| 커브 buy/sell | 정확한 R(q1)-R(q0)를 구해 매수 대금 ceil, 매도 대금 floor. 표시 단가×수량 사용 금지 |
| 현물 | 매수 대금 ceil(qP), 매도 floor(qP) |
| Pro 총지급 | signed 전체식 max(0, C+d*N*(P/P0-1)) 이후 floor. 손익만 먼저 반올림 금지 |
| 최대 예약 | 롱 M ceil, 숏 C+N; 현물 Rs ceil(Q*Pmax). 롱숏 상계 없음 |
| 체결 비용 | 성공 대금/N의10bps를 ceil, 프로토콜20% floor, 나머지 볼트 |
| 시간 비용 | 자본/보호 각 원만기 총액 ceil. 누적 발생액은 실제 경과초까지 floor(총 선납액 이내), 원만기면 선납 전액. 미사용=선납-발생. 반복 tick 반올림 금지 |
| LP | 예치 지분 floor(d*S/E), 상환 지급 floor(s*E/S). 0지분 발급/0지급 거래 거절. 초기 잠금 지분=초기 E의6자리 수량, E<=0 또는 초기화 외 총지분0이면 신규 LP 거절 |

소수 자릿수와 한 최소단위 내 반올림은 구현 선택이다. 기존 요율/권리를 변경하지 않는다. 가격/예약의 반올림 차이는 재원 여유로 남기며 NAV와 가용F를 혼동하지 않는다. 고정가격 round-trip·미세 반복매매·나눠 실행하는 테스트를 B가 필수로 제출한다.

`H`는 미경과 비용·프로토콜 귀속 미송금액·확정 미지급 사용자 청구로 구성한다. 포지션 종료에서 Rp의M을 해제할 때 확정 지급/환급을 동시에 H로 이동한다. 실제 claim 지급에서는 A와H를 같이 줄인다. NAV의D는 그 시점 실제 부채이며 최대예약/버퍼를 다시 빼지 않는다.

### 4.3 공통 데이터와 정본

| 계약 | 생산자 → 소비자 | 핵심 의미 |
| --- | --- | --- |
| Observation | C → 계산/근거 | market/query,1분구간,count 또는 missing,수신/검증시각,revision,rawHash |
| SnapshotCandidate | C → B 게시 | 연속 dataThrough,S현재/S7,준비/활동상태,근거해시,수식/쿼리/설정 버전 |
| PublishedSnapshot | B/indexer → D/F/E | candidate와 체인 수용 버전/slot/tx/finality. candidate만으로 거래 가격 갱신 금지 |
| MarketView | D → F | 생애주기/데이터/운영 상태, 현재 가격 종류, 허용행동과 거절 사유 |
| FreeRecord | B/D → F/E | 진입·종료 실행시각과 실제 snapshot 참조, 결과 또는 N/A, finalized 여부 |
| Quote | D → F → B | 사용자·시장·단계·스냅샷/설정·금액·보호·만기·최대납부/최소수령·견적 만료 |
| Claim | B → D/F | 계약별 고정 지급·환급, 소유자, claim 1회, 정산 기준 참조 |
| ProofManifest | E → 저장/SAS/F | 원래 결과·규칙·관측 참조, 내용해시, 보관/SAS/정정 연결 |

체인 계정 배열 배치·PDA seed 바이트·IDL은 B가 정하되 위 의미/ID 연속성을 지킨다. 해시 대상은 별도 canonical JSON payload(숫자 문자열/키 정렬/UTF-8/SHA-256)이고 전송 envelope나 content hash 자신은 해시 입력에 넣지 않는다. 타임스탬프는 이미 타입화된 정수로 직렬화하며 임의 키 생략을 허용하지 않는다.

### 4.4 상태와 실행 계약

- phase: CURVE / GRADUATION_WAIT / INDEXED. 데이터: PREPARING / VALID / LOW_ACTIVITY / OUTAGE. 시간 상태: INITIAL_LP / PRO_OPEN / OPEN_CUTOFF / SETTLING / LP_WINDOW. 운영 중단 이유는 별도 축.
- 단일 paused로 기존 무료 종료·기존 청구·증명 재시도까지 차단하지 않는다. `capabilities`는 행동별 허용/사유를 전달하며 컨트랙트가 최종 검사한다.
- 무료 종료는 OPEN→CLOSED_RESULT 또는 CLOSED_NA. 슬롯 반환과 증명 완료를 분리한다. 원래 N/A를 복구 뒤 숫자로 채우지 않는다.
- 거래 실행 상태: AWAITING_SIGNATURE / SUBMITTED / CONFIRMED / FINALIZED / FAILED / UNKNOWN. RPC 타임아웃은 UNKNOWN이며 체인에서 signature·계약 ID를 먼저 조회한다.
- 증명 상태: QUEUED / UPLOADED / CONFIRMING / READY_TO_ISSUE / ISSUED / INVALID / REPLACED. retry/error는 별도 필드;20확인과 참조 전체 내용/포함 검증 이전 SAS 발급 금지.
- 오류 코드 최소 집합: WRONG_PHASE, DATA_NOT_READY, DATA_STALE, LOW_ACTIVITY, INVALID_DENOMINATOR, PRECISION_UNDERFLOW, VERSION_MISMATCH, REQUOTE_REQUIRED, LIMIT_REACHED, INSUFFICIENT_FREE_CAPITAL, LP_WINDOW_CLOSED, ALREADY_EXECUTED, UNAUTHORIZED, PENDING_CONFIRMATION, BUDGET_EXHAUSTED, STORAGE_BACKLOG, INVALID_INPUT.

### 4.5 견적·재시도·권한

- 견적 TTL은 v0.1 기술 기본30초이며 스냅샷/설정/단계가 달라지면 재견적한다. 기본 자동 슬리피지0, 사용자가 서명한 maxPayment/minReceive와 deadline을 체인에서 검사한다. 예약된 자본이 아니며 동시 주문의 성공을 보장하지 않는다.
- 주간 만기 시각에 도달하면 현재가 중도 종료로 재시도하지 않고 해당 epoch 공통 정산으로 전환한다. Claim 참조는 원만기 평가와 고정 정산 버전을 유지한다.
- GET 조회는 X/SAS/유료 보관 호출을 유발하지 않는다. 사용자 쓰기는 지갑 서명 검증, 관리자 액션은 별도 인증/권한/감사 이력. 메시지 서명은 domain+cluster+wallet+nonce+expiresAt에 묶는다.
- requestId는 UUID, API 재시도 중복키는 (wallet,action,requestId). 체인 결과 중복키는 (cluster,program,signature,eventIndex); finalized 조회가 완료 정본. 공개 프로필에는 무료 기록만 노출한다. 온체인 Pro/LP 자체가 비공개라는 보장은 하지 않는다.
- 무료 비용 한도는 백엔드만의 카운터로 끝내지 않는다. B/D가 단일사용 admission 승인 또는 온체인 원자 카운터 중 강제 방식을 제출한다. 그 연결이 없으면 공개 무료 신규 개방은 미완료다. 기존 무료 종료는 신규 admission을 요구하지 않는다.

## 5. API와 화면이 먼저 맞출 최소 경계

`/v1` 읽기: GET markets, markets/:id, markets/:id/snapshots, records/:id, profiles/:wallet, leaderboard?period=7d|all, operations/:requestId. 응답은 schemaVersion, mode(fixture|localnet|devnet), asOf, data, nextCursor를 갖는다. fixture/localnet/devnet를 응답과 화면에서 표시한다.

쓰기: POST quotes, transactions/prepare, faucet/claims. 준비 응답은 action/requestId/unsignedTransaction/lastValidBlockHeight/quoteRef이고 실제서명은 사용자 지갑에서 한다. unsignedTransaction이 준비되지 않은 fixture 응답은 명시적으로 notExecutable이다. 서버가 요청 성공을 체인 완료로 표시하지 않는다. faucet의 지급량/재요청 간격은 설정 입력으로 남기고 실환경 값이 없으면 지급을 열지 않는다.

관리/서명필요 조회: 내 Pro/LP와 관리 경로는 공개 프로필 DTO에서 분리한다. 전체 소셜 피드·Pro/LP 공유 페이지를 추가하지 않는다. API 구체 라우트 확장은 D가 제출하고 F와 계약을 공유한다.

## 6. 첫 병렬 세션의 산출물

이번에 열 세션은 아래 **첫 구현 묶음**을 완료하고 결과를 그 세션에 남긴다. 다른 세션으로 메시지를 보내거나 원격 push/배포/결제하지 않는다. 이후 통합은 이 세션에서 결과/커밋을 읽어 진행한다.

| 세션 | 첫 작업/완료 기준 | 이번 첫 묶음 이후 |
| --- | --- | --- |
| B 온체인·회계 | Anchor 환경 확인, 계정/권한/무료 기록 기본 경로와 순수 지급·예약식/공통 예제 대조, IDL 계획 | 커브→졸업→현물→Pro→LP 실제 자산 연결 |
| C/E 데이터·증명 | fixture counts→EWMA→candidate 재생, 누락/0/저활동/정정 사례; evidence payload/큐 경계 | 실제 X 게시·Arweave/SAS adapter 연결 |
| D API·조회 | 공통 DTO 검증·fixture API·프로필/순위·중복키/정본 경계·실연동 adapter | 인덱서·keeper·체인 transaction 생성·실faucet |
| F 모바일 웹 | 모바일 시장/무료 기록/프로필/순위·공통 상태·fixture flow, 지갑 adapter 경계 | 실제 API/지갑/체인·Pro/LP·운영 화면 |

처음부터 전부 완료하라는 무한 범위가 아니라 I0/I1에 필요한 공통 경계의 첫 구현이다. 금전 모듈은 계속 MVP에 포함된다. 공통 파일 수정이 필요하면 자기 산출물에 변경 제안을 남기고 기존 계약을 몰래 바꾸지 않는다. 스택별 SDK/API 최신성은 구현 세션에서 공식 문서로 확인한다.

## 7. A의 확인 수준과 다음 경계

A에서는 공유 타입·계산 기준·예제와 로컬 참조 검증을 준비한다. Rust/Anchor 빌드·실체인·지갑·X 권한·SAS·Arweave·홈서버 연결은 각 세션의 실제 검증 전까지 미확인이다. 이 사실 때문에 fixture 구현을 막지는 않지만 완료 증거를 구분한다.

전체 A/I0 완료에는 B의 툴체인/IDL 대응과 C의 EWMA 정밀도, B/D의 직접호출 한도 강제·Q 회계·권한 경계가 추가로 필요하다. 각자 기능을 개발할 수 있는 공통 계약은 먼저 전달하되 이 남은 항목을 완료했다고 표시하지 않는다.

별도 Codex 작업은 사용자가 직접 요청한 세션이며 Hermes 실행 Task와 다르다. Task 상태를 이 문서의 체크박스로 중복 관리하지 않는다. 세션 ID/작업 디렉터리·기준 커밋은 생성 결과 확인 후 아래에 연결한다.
