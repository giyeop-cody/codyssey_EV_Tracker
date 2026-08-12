# Codyssey 평가 API 명세 (2026-07-16 실측, 2026-08-02 정리)

수집기 `collect_eval.js`는 아래 명세를 반영 완료했습니다. 추가 발견 시 이 문서에 누적합니다.

> 본 명세는 이 수집기가 사용하는 요청 계약과 응답 해석 규칙만 담습니다.
> 개인 식별자 값(mbrId 등)은 예시에도 싣지 않고 `<자리표시자>`로 표기합니다.

## 1. 평가 이력 (핵심) — 확정 ✅

```
POST ${CODYSSEY_API_BASE}/schedule/scheduleAllList/
     ?mbrId=<조회_대상_mbrId>&instCd=00021&bgngYmd=YYYY.MM.DD&endYmd=YYYY.MM.DD&scheduleType=request
Content-Type: application/json
Cookie: JSESSIONID=...
Body: null   (추가 파라미터 없음, 모두 쿼리스트링)
```

응답: `result.reqList[]` / `result.timeList[]` / `result.academicList[]` (우리는 reqList만 사용)

### reqList 행 의미

| 조건 | 의미 |
|---|---|
| `scdlGubunCd === "EV"` | 평가 일정 (나머지 `\"AM\"` 학사일정 등은 버림) |
| `reqDetail`이 `"R\|\|..."` | **조회 대상 멤버가 피평가자(요청자)**인 평가 |
| `reqDetail`이 `"A\|\|..."` | **조회 대상 멤버가 평가자**인 평가. 상대방(피평가자) 이름은 `scdlReqUsr` |

### 상태 코드 (fixedCd)

| 코드 | fixedNm | 트래커 status | 취소 주체 |
|---|---|---|---|
| `00006` | 평가완료 | COMPLETED | - |
| `00005` | 평가요청취소 | CANCELLED | **피평가자(요청자)** |
| `00004` | 평가거절 | CANCELLED | **평가자** |
| 그 외 | (요청/예정 등) | REQUESTED | - |

- 취소 사유: `evlDmndRtrcnRsnCd` (코드값만)
- 시간: `bgngYmd`(YYYY.MM.DD) + `bgngTm`/`endTm`
- 과제: `title` / 트랙: `divNm`
- `scdlId` = 평가 고유 ID. 같은 평가가 평가자 스케줄(A행)과 피평가자 스케줄(R행) 양쪽에 나타남
  → 전 멤버 순회 + `scdlId` 병합으로 양쪽 식별자 확정

## 2. 평가 가능(오픈) 슬롯 — `scheduleAllList` 응답에 포함 ✅

```
result.timeList[]: 멤버가 "평가 가능"으로 열어둔 슬롯
  - scdlId: 슬롯 ID, evlPsblYmdTm: "2026-07-16 14:00" (없으면 bgngYmd + fixedNm "14:00 ~ 14:30")
  - reqYn === "Y" 이면 평가와 매칭된 슬롯 (reqGu: "evl")
```

별도 호출 없이 같은 요청의 timeList에서 자동 수집되며 `data/YYYY-MM.json`의 `slots[]`에 저장됩니다.

## 3. 멤버 명부 — 길드 상세 API

```
GET ${CODYSSEY_API_BASE}/guild/{guildId}/detail?guildSeasonId={season}&weekNo={week}
→ result.members[]: mbrId, mbrNm, level ... (연락처 등 부가 필드는 수집·저장하지 않음)
```

수집기는 `--guilds 3,4,5,6 --season 5 --week 9` (환경변수 GUILDS/GUILD_SEASON/GUILD_WEEK)를 사용합니다.

## 4. 멤버별 평가 목록/상세 (현재 수집 경로)

- `ev/request/mbrSearch/searchList` (POST form) — 멤버별 평가 목록. 멤버별 조회 경로만 존재(전체 일괄 조회 없음, 08-02 확인).
  - 지원 파라미터: mbrId, instCd, evlStusCd, projectNm, evlBgngDt/evlEndDt, orderBy, page/pagePerRows(200 수용), pstartSn, kwajungStr
  - 응답 = `result.list`. 상태 코드: 00001=요청/진행, 00003=완료 계열 (txn 체계 00004/00005/00006과 별개)
  - ⚠️ 기간 파라미터는 `YYYY.MM.DD` 형식으로 본 낸 값은 0건 반환 — 포맷 다름 (미사용)
- `ev/request/mtlEvlTxnDtoByPkList` (form: evlNo+evlDegr) — 평가 "케이스"의 txn 전부(수락 후 취소/거절 포함): 평가자 식별자/이름, 상태, 점수, 요청시각(regDt), 취소사유(본문), 수정시각.
- `ev/request/mbrSearch/evlDetail` (form: projectNo+lcorsNo+uqstnNo+instCd+mbrId+lrnTmcnt) — 멤버×과제 상세.
  `result.mtlEvlDataTxnDtoList`를 주지만 최근 유효 시도만(완료 위주) → pkList의 하위호환.

## 알려진 한계 / 주의

1. 일부 API는 `mbrId` 파라미터를 무시하고 세션 소유자 데이터만 반환할 수 있다 — 수집기는 실행 시 자동 검증(R행 소유권 충돌 감지) 후 `meta.selfOnlyWarning` 경고를 낸다. 정상이면 `false`.
2. `regDt`가 null → 평가 "요청" 시각은 없고 슬롯(수행) 시각만 사용. 히트맵·캘린더는 슬롯 시각 기준.
3. **취소 시각 없음** — 상태(거절/요청취소)와 주체 역할만 확정.
4. 상대방은 이름만 오는 경우가 있어(명부에 없는 사람), 이름이 명부 내에서 고유할 때만 식별자로 연결. 동명이인은 이름 표기로 남음.
5. **수락 전 요청 단계 거절/취소는 수집 불가** — txn이 만들어지기 전에 끊긴 요청은 어떤 목록 응답에도 포함되지 않는다(모든 멤버에게 대칭으로 적용). 수집 가능 범위는 "수락 후 취소/거절"까지.
6. `instCd=00021`(이노베이션아칵미) 확인. 다른 기관이면 `INST_CD` 환경변수나 `--inst`로 변경.

## 로컬 검증 순서

```bash
# 1) 본인만 먼저 (명부 없이, 동작 확인)
CODYSSEY_SESSION="JSESSIONID=..." node collect_eval.js --month 7 --members <본인_mbrId> --dry-run

# 2) 멤버 추가 지정 (명부 연결 검증)
CODYSSEY_SESSION="JSESSIONID=..." node collect_eval.js --month 7 --members <mbrId1>,<mbrId2> --dry-run

# 3) 문제 없으면 길드 전체
CODYSSEY_SESSION="JSESSIONID=..." node collect_eval.js --month 7 --guilds 3,4,5,6

# 4) 출력 확인 후 워크플로 수동 실행
```
