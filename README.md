# TICKET LAB · 티케팅 테스트 사이트

가상 공연·가상 계정·모의 결제로 **로그인 → 대기열 → 좌석 확보 → 결제 → 조회·취소**를 테스트합니다.

- 웹 화면: https://jungminlim-ggms.github.io/macro_tester/
- GitHub Pages: `web/`만 배포하며 서버·암호·DB는 포함하지 않습니다.
- 개인 PC 서버: Node.js 24 + PostgreSQL 17, Docker Compose로 실행합니다.
- 서버 없이 열면 **브라우저 데모**입니다. 같은 브라우저의 탭은 Web Locks와 localStorage를 공유하지만, 다른 PC와 상태를 공유하거나 실제 서버 부하를 검증하지 않습니다. 데모의 방어 설정·지연은 서버 동작을 보장하지 않습니다.

## 개인 PC에 배포하기

Node.js 24 이상과 Docker Desktop(또는 Docker Engine + Compose)을 설치합니다. Docker Desktop을 실행한 뒤:

```powershell
git clone https://github.com/jungminlim-ggms/macro_tester.git
cd macro_tester
node scripts/setup.mjs
docker compose up -d --build
```

1. `http://localhost:8080`에 접속합니다.
2. 우측 위 **로컬 데모 → 개인 PC 서버**를 선택하고 API 주소에 `http://localhost:8080`을 입력합니다.
3. `.env` 파일을 로컬 편집기로 열어 `TEST_PASSWORD`를 확인합니다. 기본 계정은 `user00001`~`user01000`입니다.
4. 테스트 계정 로그인에 `TEST_PASSWORD`, 테스트 콘솔 연결에 `ADMIN_TOKEN`을 사용합니다.
5. `docker compose logs --tail 100 api`로 로그를 확인하고, 중지는 `docker compose stop`, 재시작은 `docker compose up -d`를 사용합니다.

`setup.mjs`는 임의 암호를 생성하고 이미 존재하는 `.env`는 덮어쓰지 않습니다. `.env`는 Git에서 제외됩니다. DB 데이터는 `postgres-data` 볼륨에 보존됩니다. `docker compose down -v`는 DB를 삭제하므로 반복 테스트 초기화에는 **콘솔의 새 실행 생성**을 사용하세요. PC 배포 작업은 아직 실행하지 않았습니다.

### GitHub Pages에서 개인 PC 서버 연결

GitHub Pages는 HTTPS이므로, 다른 기기에서도 접근 가능한 **PC API의 HTTPS 주소**가 필요합니다. 개인 도메인의 HTTPS 리버스 프록시 또는 사용자가 선택한 터널을 `127.0.0.1:8080`에 연결한 뒤, 웹사이트의 연결 설정에 그 주소를 입력하세요. 서버의 `ALLOWED_ORIGINS`에는 `https://jungminlim-ggms.github.io`가 기본 포함되어 있습니다.

PC의 HTTP 주소를 HTTPS 페이지에 직접 입력하면 브라우저가 혼합 콘텐츠를 차단합니다. 외부 연결 전에는 로컬 서버 화면을 이용하면 됩니다. 현재 Compose는 루프백에만 API를 바인딩하며 DB 포트는 외부로 공개하지 않습니다. 특정 터널·도메인은 자동 생성하지 않았습니다. 프록시 뒤에서는 IP가 프록시 주소로 집계되므로 계정·세션 제한을 기준으로 비교하세요. 클라이언트가 보낸 `X-Forwarded-For`는 신뢰하지 않습니다.

## 화면 사용

- 공연 3개, 공연당 기본 120석, 앞 3개 행은 기본가 +22,000원.
- 계정당 회차별 최대 2석, 점유 180초, 입장 유효 600초, 대기 재접속 유예 60초.
- 관리자 기본값: 활성 입장 300명, 초당 신규 입장 50명.
- 모의 결제: 성공 / 실패 / 15초 지연 / 타임아웃 후 대사 / 중복 알림 / 응답 유실.
- `응답 유실`은 주문 커밋 후 연결을 끊습니다. 예매 내역을 조회하거나 기존 멱등성 키로 재전송하세요. 페이지는 최근 결제 키를 sessionStorage에 보존합니다.
- 실패한 주문의 점유는 해제됩니다. 타임아웃은 `unknown`이고, 지연 작업의 실제 결과가 확인된 후 확정·환불로 전환합니다.
- 콘솔에서 테스트 시작·중지, 입장·신규 판매 중지, 요청 제한, 인증, 지연, 주기적 실패를 제어할 수 있습니다.
- 중지 후 새 실행 생성으로 계정 수·좌석 수·입장 정원·오픈 시간 등을 바꿀 수 있습니다. 기존 결과는 서버 DB에 보존되며 ‘이전 실행 조회’에서 JSON/CSV로 내보낼 수 있습니다.
- 종료는 신규 입장·점유·결제를 막습니다. 이미 접수한 결제와 만료 정리는 계속 처리하여 미결 상태를 정리합니다.

## 정합성 설계와 성능 범위

**정합성 우선 초기 구현**입니다. PostgreSQL의 `active_run` 행 → 실행 행을 동일 순서로 `SELECT … FOR UPDATE`한 뒤, 해당 실행의 상태 JSON을 한 트랜잭션으로 갱신합니다. 대기 중복 확인·순번 발급·입장 정원·좌석 전체 점유·구매 한도·멱등성·취소가 이 잠금 안에서 처리됩니다. 서로 다른 API 인스턴스도 같은 DB를 사용하면 동일 잠금을 획득합니다. 처리 중 예외는 롤백됩니다.

- 고정 발급 순번과 앞 대기 인원을 구분합니다. 순서는 DB 잠금 획득 후 등록 순서입니다.
- 모든 점유·신규 주문은 인증된 계정의 유효 입장과 DB 시각을 검사합니다.
- 한 회차 좌석은 하나의 현재 점유/판매 상태만 가집니다. 서버 점유 성공 응답이 최종 판단입니다.
- 구매 한도에는 확정 예매와 활성 점유를 반영하며 계정·회차당 활성 점유는 하나입니다.
- 사용자+멱등성 키에 요청 내용을 연결합니다. 내용이 다르면 오류, 같으면 기존 주문의 현재 상태를 반환합니다.
- 결제 작업은 DB에 `dueAt`, 이벤트 ID, 처리 여부를 저장합니다. 재시작 후 작업자가 대사하며, 트랜잭션 밖에서 네트워크 지연을 모사합니다.
- DB를 사용할 수 없으면 503으로 판매를 중지하고 DB 복구 후 영속 상태에서 재개합니다.
- PostgreSQL 기본 WAL 및 커밋 내구성을 사용합니다. 단일 PC/디스크 손실까지 보장하지 않으므로 별도 DB 백업이 필요합니다.

**이 구조는 명세의 좌석별 행 잠금·정규화 테이블 기반 고성능 설계와 다릅니다.** 모든 실행 요청이 하나의 잠금을 거치므로 1만 대기 사용자, p95 500ms를 달성했다고 주장하지 않습니다. 대규모 성능 단계에서는 좌석·점유·주문 정규화, 좌석별 잠금, 큐 저장소 분리 및 장애 복구 시험이 필요합니다. Redis는 이 버전에 필요하지 않습니다.

## 테스트

```powershell
npm install
npm test
```

14개 상태 전이 테스트: 1,000 계정의 동일 좌석 경쟁 모델, 중복 대기, 여러 좌석의 전체 성공/실패, 입장 정원과 속도, 우회·오픈 전 차단, 만료/결제 경쟁, 100회 멱등 재요청, 구매 한도, 오래된 점유, 취소 재판매, 결제 시나리오, JSON 복원.

실제 PostgreSQL 테스트(독립된 **테스트 DB** 사용):

```powershell
$env:TEST_DATABASE_URL = 'postgres://user:password@localhost:5432/test_database'
npm run test:postgres
```

GitHub Actions에서는 PostgreSQL 서비스와 서로 다른 두 연결 풀을 이용해 1,000개의 동시 점유 요청 중 1개만 성공, 100회 동시 결제 재전송, 트랜잭션 롤백 및 연결 재생성 후 보존을 확인한 후 Pages를 배포합니다. 이는 두 OS 서버 프로세스의 장애/재시작 부하 시험을 대체하지 않습니다.

화면 자동화는 `data-testid`를 사용하세요:

| 단계 | 식별자 |
|---|---|
| 연결 | `connection-settings`, `api-url` |
| 로그인 | `open-login`, `username`, `password`, `login-submit` |
| 공연 | `book-aurora`, `book-jazz`, `book-orbit` |
| 대기 | `join-queue`, `queue-number`, `queue-ahead` |
| 좌석 | `seat-A01`~`seat-J12`, `hold-submit`, `hold-timer` |
| 결제 | `payment-scenario`, `pay-submit`, `payment-status` |
| 조회·취소 | `order-status`, `cancel-order` |

## API 부하 테스트

GitHub Pages가 아니라 **소유한 PC 테스트 API**에 실행합니다. 먼저 콘솔에서 충분한 계정과 좌석을 만든 뒤:

```powershell
$env:TARGET_URL = 'http://localhost:8080'
$env:TEST_PASSWORD = '<로컬 .env의 테스트 암호>'
$env:USERS = '20'
$env:SECONDS = '30'
$env:RPS = '10'
$env:PATTERN = 'random'
$env:RAMP_SECONDS = '10'
$env:SEED = '2026'
npm run load
```

`PATTERN`: `steady`, `random`, `burst`. `RPS`는 시나리오 시작/초이며 한 시나리오는 2~4개 API 요청입니다. `SAME_SEAT=A01`로 동일 좌석 경쟁을 재현합니다. 로그인은 별도 IP 제한에 맞추어 순차 준비합니다. 실행 시간은 로그인 준비 후부터 계산합니다. 출력은 `test-results/`의 JSON/CSV이며 실제 클라이언트 응답 시간, 오류 분포와 p95를 기록합니다. 콘솔 p95는 최근 5,000건의 서버 처리+주입 지연 추정치로, 네트워크·최종 커밋 시간은 제외합니다.

좌석 선점 실패(`SEAT_TAKEN`)와 서버 장애(`STORAGE_UNAVAILABLE`/`INJECTED`)를 구분해 해석하세요. 일반 사용자·자동화 차단 비율은 요청 기준이며 로그인 시 지정한 테스트 라벨을 사용합니다. 이벤트와 지연 표본은 최근 5,000건을 보존하고 누적 카운터는 유지합니다. 데이터 시드는 현재 고정 좌석 배치의 실행 메타데이터이며 부하 스크립트의 난수 간격·좌석 선택에 사용합니다.

## 주요 API

모든 POST는 JSON. 일반 요청은 `Authorization: Bearer <로그인 토큰>`, 관리자는 `X-Admin-Token`.

| 경로 | 입력 / 기능 |
|---|---|
| `GET /api/health` | PostgreSQL 연결 확인 |
| `POST /api/login` | `{user,password,bot}` |
| `POST /api/state` | 내 예매 및 공연·좌석 상태 |
| `POST /api/queue` | `{show,answer?}` 대기 등록 |
| `POST /api/heartbeat` | `{show}` 재접속 유예 갱신 |
| `POST /api/leave` | `{show}` 대기 이탈 |
| `POST /api/hold` | `{show,seats:["A01"]}` |
| `POST /api/release` | `{holdId}` |
| `POST /api/pay` | `{holdId,scenario,key}` |
| `POST /api/cancel` | `{orderId}` |
| `POST /api/logout` | 현재 토큰 폐기 |
| `GET /api/admin/report?run=<id>` | 실행 결과(생략 시 현재) |
| `GET /api/admin/runs` | 최근 100개 실행 |
| `POST /api/admin/config` | 운용·방어·장애 주입 설정 |
| `POST /api/admin/start`, `/stop` | 신규 예매 실행 제어 |
| `POST /api/admin/reset` | `{config:{...}}`, 중지 후 새 실행 |

공연 ID는 `aurora`, `jazz`, `orbit`. 테스트 인증 문자열은 `TEST`이며 CAPTCHA 방어를 대신하지 않습니다. 실사용자 등록·실제 결제·개인정보 수집 기능은 없습니다.

## 근거 문서

- [GitHub Pages 정적 호스팅](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [PostgreSQL 행 잠금](https://www.postgresql.org/docs/17/explicit-locking.html)
- [Node.js HTTP 서버](https://nodejs.org/api/http.html)
