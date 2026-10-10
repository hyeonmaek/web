// 방향선 교차(적 추정 위치) 계산 검증. 실행: node server/test.js
const Geo = require('./geo');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  통과: ${name}`); }
  else { fail++; console.log(`  실패: ${name}${extra ? '  ' + extra : ''}`); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-4); }

console.log('방향선 교차 테스트');

// 1) 동쪽을 보는 A와 남쪽을 보는 B → 축에 정렬되어 교점 위경도가 자명 (스케일 무관)
//    A: (37.50, 127.00) 정동(90°)  → lat 고정 37.50
//    B: (37.51, 127.05) 정남(180°) → lon 고정 127.05
//    교점 = (37.50, 127.05), 둘 다 앞쪽
{
  const a = { from: 'A', lat: 37.50, lon: 127.00, bearing: 90 };
  const b = { from: 'B', lat: 37.51, lon: 127.05, bearing: 180 };
  const hit = Geo.intersectRays(a, b);
  check('교차함(앞쪽)', !!hit);
  check('교점 위도 ≈ 37.50', hit && near(hit.lat, 37.50), hit && `lat=${hit.lat}`);
  check('교점 경도 ≈ 127.05', hit && near(hit.lon, 127.05), hit && `lon=${hit.lon}`);
  check('두 관측자 모두 앞쪽(t>0)', hit && hit.ta > 0 && hit.tb > 0);
}

// 2) 같은 방위로 나란히(평행) → 교차 없음
{
  const a = { from: 'A', lat: 37.50, lon: 127.00, bearing: 45 };
  const b = { from: 'B', lat: 37.50, lon: 127.02, bearing: 45 };
  check('평행이면 null', Geo.intersectRays(a, b) === null);
}

// 3) 교점이 뒤쪽(둘 다 반대 방향을 봄) → null
//    A:(37.50,127.05) 정서(270°), B:(37.51,127.00) 정북(0°)
//    두 직선은 (37.50,127.00)에서 만나지만 둘 다 그 반대쪽을 보고 있음 → 적 아님
{
  const a = { from: 'A', lat: 37.50, lon: 127.05, bearing: 270 }; // 서쪽을 봄, 교점은 더 서쪽이어야 앞
  const b = { from: 'B', lat: 37.49, lon: 127.00, bearing: 180 }; // 남쪽을 봄, 교점은 더 남쪽이어야 앞
  // 직선 교점은 (37.50,127.00): A 기준 서쪽(앞, 정상) / B 기준 북쪽(뒤) → null
  check('한쪽이 뒤쪽이면 null', Geo.intersectRays(a, b) === null);
}

// 4) enemyEstimates: 위치/방위 없는 보고는 제외하고 쌍만 교차
{
  const reports = [
    { from: 'A', lat: 37.50, lon: 127.00, bearing: 90 },
    { from: 'B', lat: 37.51, lon: 127.05, bearing: 180 },
    { from: 'C', text: '위치 불명' },           // lat/lon 없음 → 제외
  ];
  const est = Geo.enemyEstimates(reports);
  check('추정 1건', est.length === 1, `len=${est.length}`);
  check('보고자 A·B가 만든 교차', est[0] && est[0].by.includes('A') && est[0].by.includes('B'));
}

// 5) 세 명이 한 적을 보면 3쌍 교차(세 점이 거의 모임) — 개수 검증
{
  const reports = [
    { from: 'A', lat: 37.495, lon: 127.00, bearing: 45 },
    { from: 'B', lat: 37.495, lon: 127.01, bearing: 315 },
    { from: 'C', lat: 37.505, lon: 127.005, bearing: 180 },
  ];
  const est = Geo.enemyEstimates(reports);
  check('세 명 → 3쌍 교차', est.length === 3, `len=${est.length}`);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
