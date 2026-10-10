-- TOC 저장소. 컨테이너 첫 실행 때 자동 적용(이후엔 서버가 IF NOT EXISTS로 한 번 더 확인).
CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  type        TEXT NOT NULL,             -- engagement | sos | message | correction
  from_id     TEXT NOT NULL,             -- 보드 ID(16진수, 예: AD)
  lat         DOUBLE PRECISION,
  lon         DOUBLE PRECISION,
  bearing     INTEGER,                   -- 진북 기준 방위(도)
  fire        TEXT,                      -- open | hold
  text        TEXT NOT NULL DEFAULT '',
  msg_id      INTEGER,
  ts          BIGINT NOT NULL,           -- 보고 시각(ms)
  rx_ts       BIGINT NOT NULL            -- TOC 수신 시각(ms)
);
CREATE TABLE IF NOT EXISTS commands (
  id           SERIAL PRIMARY KEY,
  to_id        TEXT NOT NULL,            -- FF=전체, 그 외 보드 ID
  text         TEXT NOT NULL,
  ts           BIGINT NOT NULL,
  delivered    BOOLEAN NOT NULL DEFAULT FALSE,
  delivered_ts BIGINT
);
CREATE TABLE IF NOT EXISTS units (
  board_id  TEXT PRIMARY KEY,            -- 보드 ID(16진수)
  callsign  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO units (board_id, callsign) VALUES ('AD', 'E-1'), ('FA', 'E-2') ON CONFLICT DO NOTHING;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS address TEXT;   -- 좌표로 찾은 주소(행정구역 + 가까운 도로)
CREATE TABLE IF NOT EXISTS geocache (
  key      TEXT PRIMARY KEY,           -- 위도·경도 소수 4자리(약 10m 칸)
  address  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_deliveries (   -- 명령이 어느 병사에게 전달됐는지(전체 명령은 병사마다 따로)
  command_id  INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  board_id    TEXT NOT NULL,
  ts          BIGINT NOT NULL,
  PRIMARY KEY (command_id, board_id)
);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS loc_from TEXT;   -- 폰 없는 병사: 근처 분대원 폰 GPS로 근사한 경우 그 분대원 보드 ID
