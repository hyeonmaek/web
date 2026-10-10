// 데모 전 기록 비우기: 보고·FRAGO 전부 삭제(부대 호출부호·기지국 주소는 유지). 실행: npm run reset
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://toc:toc@127.0.0.1:5433/toc' });
pool.query('TRUNCATE reports, commands RESTART IDENTITY')
  .then(() => { console.log('보고·FRAGO 기록을 비웠습니다.'); return pool.end(); })
  .catch((e) => { console.error('실패:', e.message); process.exit(1); });
