# 📊 Codyssey 동료평가 트래커 (Peer Evaluation Tracker)

> codyssey_Jail_Tracker와 같은 패턴으로 만드는 Codyssey 동료평가 분석 대시보드

codyssey.kr의 동료평가 데이터를 GitHub Actions가 주기적으로 수집해
월별 JSON으로 저장하고, GitHub Pages 정적 대시보드로 시각화합니다.

## ⚠️ 시작하기 전에 (중요)

- **이 대시보드는 실명 기반의 "누가 누구를 기피하는지" 분석을 포함합니다.**
  출입 시간 집계와 달리 대인관계 민감 정보이므로 **공개 Pages 배포는 권장하지 않습니다.**
  최소한 저장소를 Private로 두고 로컬/사내 배포로 사용하세요. (GitHub Pages는 Private 저장소도 기본적으로 공개 URL이 됩니다.)
- 평가 이력/취소 조회 API는 **공식 공개 API가 아닌 사이트 날부 호출을 재사용**합니다.
  사용 전 운영정책/약관을 확인하고, 반드시 본인 계정 세션 범위에서만 사용하세요.

## 제공 기능

| 기능 | 화면 위치 | 필요 데이터 |
|---|---|---|
| 월간 캘린더 (일별 평가수/취소수/활동 멤버) | 메인 | events |
| 평가 횟수 / 피평가 횟수 랭킹 | 랭킹 테이블 | events + members |
| 평가 취소 / 피평가 취소 횟수 | 랭킹 테이블 + 요약 카드 | cancel 정보가 있는 events |
| 날짜 클릭 → 시간·평가자·피평가자·과제 목록 | 일별 모달 | events |
| 이벤트 클릭 → 평가 상세(점수/코멘트) | 상세 모달 | detail 수집 시 |
| 시간대×요일 히트맵 (평가 몰리는 시간) | 히트맵 | slotDateTime |
| 슬롯 오픈 분석 (누가 언제 슬롯을 여는지) | 슬롯 패널 | timeList (reqYn=Y면 매칭) |
| 기피 분석 (취소 주체×상대방 페어) | 기피 분석 패널 | cancel.byId + 상대방 식별 |

## 프로젝트 구조

```
├── .devcontainer/
│   └── devcontainer.json    # Codespace: 포트 3000 포워딩 + GH_PAT_SYNC 선언
├── .github/workflows/
│   └── collect.yml          # 30분 주기 수집 + data/ 커밋 (최초 1회 설정에서 등록)
├── docs/                    # ★ Pages 소스 폴더 (Deploy from a branch: main /docs)
│   ├── index.html           # 평가 트래커 대시보드 (바닐라 JS)
│   ├── styles.css
│   ├── app.js               # 렌더링 + MOCK 모드(데이터 없으면 가상 데이터)
│   ├── data/                # 수집기가 쓰는 월별 JSON (YYYY-MM.json)
│   └── API_DISCOVERY.md     # 실측 확정 API 명세
├── dashboard/               # Codespace 세션-싱크 서버 (Pages 배포 아님)
│   ├── server.js            # 로그인 폼 + Secret 등록
│   ├── lib/github-sync.js   # Secret 암호화(libsodium) + 업로드 + workflow dispatch
│   ├── public/login.html    # Codespace 로그인/상태 화면
│   ├── package.json
│   └── package-lock.json
├── collect_eval.js          # 수집기 (Actions에서 실행, CODYSSEY_SESSION 사용)
└── README.md
```

## 동작 흐름 (세션-싱크 루프)

```
[Codespace 3000번 포트]                    [저장소 Secrets]        [GitHub Actions]
로그인 폼에서 Codyssey 로그인
  → JSESSIONID 확보 (비밀번호 미저장)
  → libsodium으로 암호화 ────PUT────▶ CODYSSEY_SESSION 생성/갱신
  └─ workflow_dispatch ───────────────────▶ collect.yml 즉시 실행
                                             └ 이후 30분 cron 반복 수집
                                               → data/YYYY-MM.json 커밋 → Pages 배포
```

1. Codespace를 열으면 devcontainer가 포트 3000으로 세션-싱크 서버를 자동 실행합니다.
2. 로그인 폼에서 Codyssey 계정으로 로그인하면 서버가 `JSESSIONID`를 받습니다.
3. 서버가 저장소 공개키로 암호화해 Actions Secret `CODYSSEY_SESSION`을 생성/갱신합니다.
4. 시크릿이 등록/갱신되면 `collect.yml`을 workflow_dispatch로 즉시 실행합니다.
5. 이후 Actions는 30분마다 반복되고, 세션 만료 시 폼에서 재로그인하면 루프가 다시 돕니다.
6. 데이터 파일이 없으면 대시보드는 **MOCK 모드**로 가상 데이터를 보여줍니다.

## 최초 1회 설정

### 0. 워크플로 등록 + Pages 활성화 (웹 UI, 클릭 몇 번)

> 셋업용 PAT에 `Workflows` 권한이 없어도 되도록, 이 두 단계는 GitHub 웹 UI에서 진행합니다.

1. **collect.yml 등록**: 저장소에서 `.staging-workflows/collect.yml` 파일을 열고
   ✏️(Edit) → 파일명을 `.github/workflows/collect.yml`로 변경 → **Commit changes**.
   (웹에서 커밋하면 토큰 workflow 권한 제한이 적용되지 않습니다.)
2. **Pages 활성화**: 저장소 **Settings → Pages → Source = "Deploy from a branch"**
   → Branch: `main`, 폴더: `/docs` → **Save**.
   몇 분 뒤 `https://<user>.github.io/codyssey_EV_Tracker/` 에서 대시보드가 열립니다.

### 1. Fine-grained PAT 발급 (Codespace 자동 싱크용)

GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:

- **Repository access**: `Only select repositories` → 이 저장소
- **Permissions**:
  - `Actions`: Read and write (workflow dispatch)
  - `Secrets`: Read and write (CODYSSEY_SESSION 등록/갱신)
  - `Contents`: Read (dispatch ref 확인용)

### 2. Codespaces Secret 등록

GitHub **Settings → Codespaces → Codespaces secrets → New secret**:

- Name: `GH_PAT_SYNC` / Value: 위 PAT
- Repository access: 이 저장소만 선택

> `GH_PAT_SYNC`는 **Codespaces(계정) 시크릿**이라 Codespace 컨테이너에만 주입되고,
> Actions에는 노출되지 않습니다. `CODYSSEY_SESSION`은 서버가 대신 등록하는 **저장소 Actions 시크릿**입니다.

### 3. 실행

1. 저장소에서 **Code → Codespaces → Create codespace on main**
2. 포트 3000 미리보기가 열리면 로그인 폼에서 Codyssey 로그인
3. 상태 카드에서 "최근 Secret 동기화 / 워크플로 실행 요청됨" 확인
4. 수동 확인이 필요하면: Secret `CODYSSEY_SESSION`에 `JSESSIONID` 값을 직접 넣고
   `Collect Evaluation Data` 워크플로를 workflow_dispatch로 직접 실행할 수도 있습니다(코드스페이스 없이도 가능).
5. 수집기는 **실측 확정 API(`schedule/scheduleAllList/`)를 이미 반영**했습니다. 잔여 한계(상세 점수 미확정, 취소 시각 없음 등)는 `docs/API_DISCOVERY.md` 참조.

## 보안 모델

| 값 | 위치 | 비고 |
|---|---|---|
| Codyssey 비밀번호 | 어디에도 저장 안 함 | 로그인 요청 시 메모리에서만 사용 |
| `JSESSIONID` | Codespace `.session-cookies.json`(gitignore) + Actions Secret | 만료 시 재로그인 |
| `GH_PAT_SYNC` | Codespaces 계정 Secret | Actions 가 아닌 컨테이너에만 주입 |
| `CODYSSEY_SESSION` | 저장소 Actions Secret | 수집 워크플로에서만 사용 |

## 데이터 스키마 (data/YYYY-MM.json)

```json
{
  "meta": { "generatedAt": "...", "year": 2026, "month": 7, "mock": false, "selfOnlyWarning": false },
  "members": [ { "mbrId": "1000271067", "name": "홍길동", "level": 2, "guild": "3길드" } ],
  "events": [
    {
      "evalId": "630003",
      "slotDateTime": "2026-07-14T09:00:00+09:00",
      "endTime": "09:30",
      "evaluatorId": "1000271067", "evaluatorName": "홍길동",
      "evaluateeId": "1000270000", "evaluateeName": "김철수",
      "projectName": "Mini Redis 구축",
      "trackName": "C Language",
      "fixedCd": "00006",
      "status": "COMPLETED | CANCELLED | REQUESTED",
      "cancel": {
        "by": "EVALUATOR | EVALUATEE",
        "byId": "1000270000", "byName": "김철수",
        "reasonCd": "00001", "reasonNm": "평가요청취소", "at": null
      },
      "detail": null
    }
  ]
}
```

- `status`는 원본 `fixedCd` 매핑 (`00006`→COMPLETED, `00005`/`00004`→CANCELLED, 그 외→REQUESTED)
- 취소 주체 규칙: `00005`(평가요청취소)=피평가자, `00004`(평가거절)=평가자
- 같은 평가가 양쪽 멤버 스케줄에 `R||`/`A||`로 나타나므로 `scdlId` 병합으로 평가자·피평가자 mbrId를 모두 확정합니다. 명부에 없는 상대는 `*Name` 필드로만 남습니다.
