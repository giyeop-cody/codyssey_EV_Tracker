# Codyssey 평가 API 명세 (2026-07-16 실측 확정)

수집기 `collect_eval.js`는 아래 명세를 반영 완료했습니다. 추가 발견 시 이 문서에 누적합니다.

## 1. 평가 이력 (핵심) — 확정 ✅

```
POST https://api.usr.codyssey.kr/schedule/scheduleAllList/
     ?mbrId=1000271067&instCd=00021&bgngYmd=2026.06.29&endYmd=2026.08.02&scheduleType=request
Content-Type: application/json
Cookie: JSESSIONID=...
Body: null   (추가 파라미터 없음, 모두 쿼리스트링)
```

응답: `result.reqList[]` / `result.timeList[]` / `result.academicList[]` (우리는 reqList만 사용)

### reqList 행 의미

| 조건 | 의미 |
|---|---|
| `scdlGubunCd === "EV"` | 평가 일정 (나머지 `"AM"` 학사일정 등은 버림) |
| `reqDetail`이 `"R\|\|..."` | **조회 대상 멤버가 피평가자(요청자)** 인 평가 |
| `reqDetail`이 `"A\|\|..."` | **조회 대상 멤버가 평가자** 인 평가. 상대방(피평가자) 이름은 `scdlReqUsr` |

### 상태 코드 (fixedCd)

| 코드 | fixedNm | 트래커 status | 취소 주체 |
|---|---|---|---|
| `00006` | 평가완료 | COMPLETED | - |
| `00005` | 평가요청취소 | CANCELLED | **피평가자(요청자)** |
| `00004` | 평가거절 | CANCELLED | **평가자** |
| 그 외 | (요청/예정 등) | REQUESTED | - |

- 취소 사유: `evlDmndRtrcnRsnCd` (코드값만, 예: `"00001"`)
- 시간: `bgngYmd`(YYYY.MM.DD) + `bgngTm`/`endTm`
- 과제: `title` / 트랙: `divNm`
- `scdlId` = 평가 고유 ID. **같은 평가가 평가자 스케줄(A행)과 피평가자 스케줄(R행) 양쪽에 나타남**
  → 전 멤버 순회 + `scdlId` 병합으로 양쪽 mbrId 확정

## 2. 평가 가능(오픈) 슬롯 — `scheduleAllList` 응답에 포함 ✅

```
result.timeList[]: 멤버가 "평가 가능"으로 열어둔 슬롯
  - scdlId: 슬롯 ID, evlPsblYmdTm: "2026-07-16 14:00" (없으면 bgngYmd + fixedNm "14:00 ~ 14:30")
  - reqYn === "Y" 이면 평가와 매칭된 슬롯 (reqGu: "evl")
```

별도 호출 없이 **같은 요청의 timeList에서 자동 수집**되며 `data/YYYY-MM.json`의 `slots[]`에 저장됩니다.
`POST /schedule/psblScheduleList/?mbrId=&instCd=&evlPsblYmd=YYYY-MM-DD`도 확인됐으나(일별 단건 조회,
`result.list[]`), timeList가 동일 정보를 기간 범위로 제공하므로 수집기는 사용하지 않습니다.

## 3. 멤버 명부 — 레퍼런스와 동일 패턴으로 확정 ✅

```
GET https://api.usr.codyssey.kr/guild/{guildId}/detail?guildSeasonId=5&weekNo=9
→ result.members[]: mbrId(--include-private일 때), mbrNm, level ...
```

수집기는 `--guilds 3,4,5,6 --season 5 --week 9` (환경변수 GUILDS/GUILD_SEASON/GUILD_WEEK)를 사용합니다.

## 알려진 한계 / 주의

1. **타 멤버 mbrId 조회 가능 여부는 실행 시 자동 검증**합니다. API가 `mbrId` 파라미터를 무시하고 세션 사용자 스케줄만 반환하면, R행 소유권 충돌로 감지해 `selfOnlyWarning` 경고를 냅니다. 정상이면 `meta.selfOnlyWarning: false`.
2. `regDt`가 null → **평가 "요청" 시각은 없고 슬롯(수행) 시각만** 사용합니다. 히트맵·캘린더는 슬롯 시각 기준.
3. **취소 시각 없음** — 상태(거절/요청취소)와 주체 역할만 확정됩니다.
4. 상대방은 이름만 오는 경우가 있어(명부에 없는 사람), 이름이 명부 내에서 **고유할 때만** mbrId로 연결합니다. 동명이인은 이름 표기로 남습니다.
5. **점수/코멘트 상세 미확정** — 평가 결과 상세 화면의 XHR을 추가로 캡처하면 `detail`을 채울 수 있습니다. (없어도 랭킹/캘린더/기피 분석은 전부 동작)
6. `instCd=00021`(이노베이션아카데미) 확인. 다른 기관이면 `INST_CD` 환경변수나 `--inst`로 변경.

## 로컬 검증 순서

```bash
# 1) 본인만 먼저 (명부 없이, 동작 확인)
CODYSSEY_SESSION="JSESSIONID=..." node collect_eval.js --month 7 --members <본인_mbrId> --dry-run

# 2) 타인 1명 추가 (교차 조회 허용 여부 확인 — 경고 없으면 OK)
CODYSSEY_SESSION="JSESSIONID=..." node collect_eval.js --month 7 --members <본인_mbrId>,<타인_mbrId> --dry-run

# 3) 문제 없으면 길드 전체
CODYSSEY_SESSION="JSESSIONID=..." node collect_eval.js --month 7 --guilds 3,4,5,6

# 4) 출력 확인 후 워크플로 수동 실행
```

## 부록. 레퍼런스 레포(codyssey_Jail_Tracker) 운영 검증 엔드포인트

아래 3개는 같은 서비스 계열에서 실운영 중인 동작 확인된 API입니다 (30분 주기 수집에 사용 중).

```
# 인증 — JSESSIONID 발급. 이 트래커의 세션-싱크 서버와 동일 엔드포인트 사용
POST https://api.ams.codyssey.kr/authenticate
Content-Type: application/x-www-form-urlencoded
Body: userId=...&password=...
응답: Set-Cookie에 JSESSIONID (성공 판정: 쿠키 수신 또는 /main  리다이렉트)

# 길드 상세(명부) — 이 트래커의 멤버 수집과 동일. 세션 유효성 프로브로도 사용
GET https://api.usr.codyssey.kr/guild/{guildId}/detail?guildSeasonId={season}&weekNo={week}
응답: result.guildInfo{guildNm,currentRanking,totalScore} + result.members[]{mbrId,mbrNm,level,emlAddr,personalScore,...}

# SECOM 출입 상세 — ★ mbrId를 파라미터로 받아 타인 데이터 조회 가능 (실운영 증거)
GET https://api.usr.codyssey.kr/rest/secom/detail?mbrId={mbrId}&year={year}&month={month}
```

시사점: `/rest/secom/detail`이 `mbrId`를 받아 타인까지 조회되므로,
우리가 쓰는 `schedule/scheduleAllList/?mbrId=...`도 **타인 교차 조회가 허용될 가능성이 높습니다.**
그래도 수집기의 `selfOnlyWarning`(R행 소유권 충돌 감지)은 그대로 둡니다 — 실제 거부 시 자동 경고.
세션 유효성 프로브는 이 부록의 길드 상세 API를 쓰도록 서버를 맞춰뒀습니다 (`dashboard/server.js`의 `validateSession`).
