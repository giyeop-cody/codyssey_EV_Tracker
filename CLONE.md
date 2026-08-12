# 이 레포를 clone/fork해서 쓰는 법

이 트래커는 특정 길드들(기본: 길드 3,4,5,6 / 시즌 5 / 9주차)을 대상으로 하드코딩된
기본값을 갖지만, 별도 인프라(로스터 허브·세션 동기화) **없이도** 단독으로 돌아간다.
아래 순서대로 설정하면 된다.

## 1. fork/clone 후 해야 할 일

### (1) Repository Secret 등록 (필수)

| Secret | 값 |
|---|---|
| `CODYSSEY_SESSION` | `JSESSIONID=xxxx` 형태의 쿠키 문자열. usr.codyssey.kr 로그인 후 개발자도구 → Application → Cookies에서 복사 |

- 세션이 만료되면 수집이 안내 메시지와 함께 스킵/실패한다. 새 값으로 교체할 것
  (만료 주기는 실측 없음 — 만료 시점에 갱신하는 수동 모델)
- `HUB_PAT`은 **등록하지 않아도 된다** (비어 있으면 조용히 스킵됨 → 아래 폴 백 경로)

### (2) 대상 길드/시즌 변경 (자기 기수에 맞게)

기본값은 `collect_eval.js` 상단에 있으며 세 가지 방법으로 바꿀 수 있다:

1. **CLI 인자** — 로컬 실행 시: `--guilds 3,4,5,6 --season 5 --week 9`
2. **환경변수** — `GUILDS` / `GUILD_SEASON` / `GUILD_WEEK`
3. Actions에서 바꾸려면 `.github/workflows/collect.yml`의 `Collect evaluations` step
   `env:` 블록에 위 변수를 추가

길드 번호(3,4,5,6 등)는 길드 API의 guildId로, 길드 화면 URL 등에서 확인.

### (3) GitHub Pages 활성화

Settings → Pages → Source를 **GitHub Actions**로 설정. 이후 `docs/` 변경 push 때마다
`Deploy Dashboard` 워크플로가 자동 배포한다. (첫 수집 run 전에는 데이터가 없어
MOCK 데모 데이터가 표시됨)

## 2. 로스터(명부)는 어떻게 얻나 — 허브 없어도 됨

수집 시 명부는 아래 우선순위로 자동 선택된다:

```
로스터 허브(비공개, HUB_PAT 있을 때만)  →  actions/cache 로스터(8시간 이내)  →  길드 API 직접 조회
```

즉 허브가 없는 클로너는 자동으로 캐시→길드 API 경로를 쓰므로 추가 설정이 없다.
길드 API 경로는 모든 멤버의 명부를 수집기가 직접 읽는다 (세션 쿠키 필요).

## 3. 외부 워치독 (선택)

GitHub 스케줄러 정전 대비 외부 점화를 쓰려면
[giyeop-cody/codyssey_watchdog](https://github.com/giyeop-cody/codyssey_watchdog) 를 참고:

- `collect.yml`의 `repository_dispatch(external-collect)` 트리거는 이미 이 레포에 있음
- worker를 fork한 뒤 `OWNER`/`TARGETS` 변수를 자기 레포로 바꾸고 `GH_TOKEN`에
  자기 PAT(Actions: RW, Contents: Read)를 등록해 배포

## 4. 안 되는 것 / 주의

- **세션 자동 갱신 없음** — 원작자는 별도 로스터 허브+로그인 서버로 세션을 자동 동기화하지만,
  클론 환경에는 없다. 세션 만료 시 Secret을 직접 갱신해야 한다.
- 원작자 레포의 데이터·로스터와 무관하게 **완전히 자기 대상만** 수집된다.
