# 현맥 (HYEONMAEK, 玄脈) — C2 지휘소 웹

> 분대를 끊김 없이 잇는 검고 깊은 줄기. *The dark vein that keeps a squad connected.*

D4D × EDTH SEOUL 2026 해커톤 출품작의 C2(지휘소) 화면과 서버. 기지국(NU-87)이 올린 분대 보고를 기록하고 지도에 띄우며, 분대에 명령을 내린다.

## 화면

- **지도**: 보고 위치(날짜·시각·도로명 주소·좌표), 적 방위선(진북 기준 직선 + ±15° 부채꼴, 100m)
- **아군 현황**: 기지국이 지금 듣고 있는 병사, 배터리·신호 세기
- **보고**: 교전 / 긴급구호 / 메시지
- **명령**: 전체 또는 통신 중인 병사 개별 지정

## 명령 전달 방식

명령은 바로 나가지 않고 대기한다. 분대 중 누구든 송신(사격개시·긴급구호·폰에서 중앙으로 메시지)하면 그때 대기 명령을 모두 내려보낸다. 전체 명령은 분대 전체에, 개별 명령은 지정한 병사에게 간다. 평소 전파 방출을 줄이기 위한 설계.

## 실행

Node.js 18 이상, Docker.

```sh
npm install
docker compose up -d     # PostgreSQL 16 (포트 5433)
node server.js           # http://localhost:8090
npm test                 # 방위선 교차 계산 시험
```

기지국은 켜지면 `POST /hello`로 주소를 알려 오고, 서버는 3초마다 기지국 `/data`를 물어 실제 연결 상태를 표시한다.

주소 변환: OpenStreetMap Nominatim(행정구역) + Overpass(가까운 도로명), 결과는 DB에 저장.

## API

| | |
|---|---|
| `POST /report` | 기지국 보고 1건 기록 → 대기 명령 하달 |
| `POST /hello` | 기지국 부팅 인사 |
| `POST /command` | 명령 추가(대기) `{to, text}` |
| `GET /state` | 화면 데이터 |

## 관련 저장소

- 단말·기지국 펌웨어: [hyeonmaek/firmware](https://github.com/hyeonmaek/firmware)
- 아이폰 앱: [hyeonmaek/app](https://github.com/hyeonmaek/app)
