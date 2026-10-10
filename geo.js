// 방향선 교차 = 적 추정 위치 계산 (서버 test.js와 브라우저 기록판이 공용으로 쓴다)
// 좁은 영역이라 위경도를 평면으로 근사한다. bearing은 정북(0)=북, 시계방향, 90=동.
// 각 보고는 자기 위치에서 bearing 방향으로 뻗어 나가는 "반직선(ray)"이다.
// 두 반직선이 둘 다 앞쪽(t>0)에서 만나면 그 교점이 적 추정 위치.
(function (root) {
  const DEG = Math.PI / 180;
  const M_PER_DEG_LAT = 111320; // 위도 1도 ≈ 111.32km

  // 위경도를 기준점(lat0) 중심의 로컬 평면(미터)으로. 경도는 cos(lat)로 줄어든다.
  function toMeters(lat, lon, lat0) {
    return {
      x: (lon - 0) * Math.cos(lat0 * DEG) * M_PER_DEG_LAT, // 동(east)
      y: (lat - 0) * M_PER_DEG_LAT,                        // 북(north)
    };
  }
  function toLatLon(x, y, lat0) {
    return {
      lat: y / M_PER_DEG_LAT,
      lon: x / (Math.cos(lat0 * DEG) * M_PER_DEG_LAT),
    };
  }

  // 반직선 A(위치 a, 방위 ba)와 반직선 B(위치 b, 방위 bb)의 교점.
  // 반환: null(평행/뒤쪽/겹침) 또는 {lat, lon, ta, tb}  ta/tb는 각 관측자 앞으로의 거리(m)
  function intersectRays(a, b) {
    const lat0 = (a.lat + b.lat) / 2;
    const A = toMeters(a.lat, a.lon, lat0);
    const B = toMeters(b.lat, b.lon, lat0);
    // 방향 벡터 (east=sin, north=cos)
    const da = { x: Math.sin(a.bearing * DEG), y: Math.cos(a.bearing * DEG) };
    const db = { x: Math.sin(b.bearing * DEG), y: Math.cos(b.bearing * DEG) };
    // A.xy + ta*da = B.xy + tb*db  →  2x2 연립
    const det = da.x * (-db.y) - da.y * (-db.x);
    if (Math.abs(det) < 1e-9) return null; // 평행(교차 없음)
    const rx = B.x - A.x, ry = B.y - A.y;
    const ta = (rx * (-db.y) - ry * (-db.x)) / det;
    const tb = (da.x * ry - da.y * rx) / det;
    if (ta <= 0 || tb <= 0) return null; // 둘 중 하나라도 뒤쪽이면 적이 아님
    const px = A.x + ta * da.x, py = A.y + ta * da.y;
    const ll = toLatLon(px, py, lat0);
    return { lat: ll.lat, lon: ll.lon, ta, tb };
  }

  // 교전 보고 목록(위치+방위 있는 것)에서 가능한 모든 쌍의 교점을 적 추정 위치로.
  // reports: [{from, lat, lon, bearing, ...}]
  function enemyEstimates(reports) {
    const usable = reports.filter(
      (r) => typeof r.lat === 'number' && typeof r.lon === 'number' && typeof r.bearing === 'number'
    );
    const out = [];
    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        const hit = intersectRays(usable[i], usable[j]);
        if (hit) out.push({ lat: hit.lat, lon: hit.lon, by: [usable[i].from, usable[j].from] });
      }
    }
    return out;
  }

  const api = { intersectRays, enemyEstimates, toMeters, toLatLon };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof window !== 'undefined' ? window : this);
