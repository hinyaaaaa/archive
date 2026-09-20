/* ============================================================
   task-field.js — 「タスク」ページの浮遊天体フィールド(module script)
   ------------------------------------------------------------
   solar-system.js(「今日」ページの恒星系)と対を成すが、性格は正反対:
   恒星系が「軌道という秩序に沿って周回する、今日消化する分だけの
   小さな宇宙」であるのに対し、ここは「手つかずの案件がまだ整理
   されないまま漂う、無造作で広い深宇宙」というイメージ。

   【今日の恒星系との違い】
   - 軌道円・公転・傾斜面を一切持たない。各天体は自身のハッシュ値
     から決まる固定座標(±のドリフトのみ)で静止して漂う。
   - 太陽(中心の恒星)を置かない。すべての天体が対等に散らばる。
   - タップ操作は「即完了」ではなく、天体からリーダーラインが
     上方へ伸びてHUD Calloutタブが現れ、そこで「達成」「編集」を
     選ぶ2段階の操作にする(誤操作防止よりも、操作の実在感を優先)。

   TaskNOVA本体・solar-system.jsとはwindow.TaskFieldインターフェース
   経由でのみ連携する疎結合構成(依存の向きを持たない設計)。
   ============================================================ */
import * as THREE from 'three';

/* ------------------------------------------------------------
   フィールドの物理定数
   ------------------------------------------------------------ */
const FIELD_RADIUS_MIN = 3.2;   // 天体が散らばる球殻の内側半径
const FIELD_RADIUS_MAX = 9.6;   // 外側半径(締切が近いほど内側に寄せ、緊急度を距離感で伝える)
const FIELD_DAYS_CAP = 45;
const PLANET_MIN_R = 0.34;
const PLANET_MAX_R = 1.05;
const LOAD_MIN = 0.5;
const LOAD_MAX = 5;
const WEEKLY_RING_INNER_MULT = 1.5;
const WEEKLY_RING_OUTER_MULT = 2.15;
const DRIFT_RADIUS = 0.16;      // 固定座標を中心にした無造作な漂い(振幅。旧0.34から半減以下に抑制)
const DRIFT_SPEED_MIN = 0.025;
const DRIFT_SPEED_MAX = 0.06;

const TEXTURE_KEYS = ['rockA', 'rockB', 'rockC', 'bandedA', 'bandedB', 'iceA', 'iceB'];

function hashStr(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
// ハッシュ値2つから[0,1)の疑似乱数を安定して作る(タスクIDが同じなら
// 毎回同じ配置になる=リロードしても天体がジャンプしない)。
function hashUnit(seedA, seedB) {
  return (hashStr(seedA + '_' + seedB) % 100000) / 100000;
}
function daysUntilToFieldRadius(days) {
  if (days == null) return FIELD_RADIUS_MAX;
  const clamped = Math.max(0, Math.min(FIELD_DAYS_CAP, days));
  const t = Math.log(clamped + 1) / Math.log(FIELD_DAYS_CAP + 1);
  return FIELD_RADIUS_MIN + (FIELD_RADIUS_MAX - FIELD_RADIUS_MIN) * t;
}
function loadToPlanetRadius(load) {
  const l = Math.max(LOAD_MIN, Math.min(LOAD_MAX, load || 1));
  const t = (l - LOAD_MIN) / (LOAD_MAX - LOAD_MIN);
  return PLANET_MIN_R + (PLANET_MAX_R - PLANET_MIN_R) * t;
}
function pickTexture(taskId) { return TEXTURE_KEYS[hashStr(taskId) % TEXTURE_KEYS.length]; }
function pickSpinSpeed(taskId) { return 0.12 + (hashStr(taskId + '_spin') % 100) / 100 * 0.3; }

// タスクの負荷値からHSL経由でTHREE.Colorを作る。app.js側のloadColor()と
// 同じ緑→橙→赤→紫のグラデーションを、Three.js(0x hex)向けに再実装した
// もの。UIの罫線リスト側と天体側で色の意味が食い違わないようにする。
// タスクの分類(LOGIC/MEMORY/CREATIVE/READING/PRACTICE。app.js側の
// inferLearningType()と対応)から固有色を返す。距離=締切の近さ、
// 大きさ=負荷、色=分類、という3つの軸それぞれに独立した意味を
// 持たせる設計(方位角には意味を持たせず均等・無造作のまま)。
const TYPE_COLORS = {
  LOGIC: [110, 168, 230],    // 青 - 論理思考(数学・物理など)
  MEMORY: [214, 168, 74],    // 琥珀 - 暗記
  CREATIVE: [200, 100, 190], // マゼンタ - 創作
  READING: [96, 200, 150],   // 緑 - 読解
  PRACTICE: [170, 130, 220], // 紫 - 演習
};
const TYPE_COLOR_FALLBACK = [130, 150, 170];
function typeToColor(learningType) {
  const rgb = TYPE_COLORS[learningType] || TYPE_COLOR_FALLBACK;
  return new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
}
function colorToCss(c) {
  return 'rgb(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ')';
}

/* ------------------------------------------------------------
   状態
   ------------------------------------------------------------ */
let renderer = null, scene = null, camera = null, canvasEl = null, stageEl = null;
let starfield = null;
let bodies = [];
let rafId = null;
let disposed = true;
let texturesLoaded = false;
let loadedTextures = {};

const camState = {
  azimuth: 0.6, polar: 1.42, distance: 13, targetDistance: 13,
  target: new THREE.Vector3(0, 0, 0),
};
const CAM_POLAR_MIN = 0.35, CAM_POLAR_MAX = 2.6;
const CAM_DIST_MIN = 2.6, CAM_DIST_MAX = 20;
const CAM_DIST_OVERVIEW = 13;

let selectedBody = null;
let raycaster = null;
const pointerNdc = new THREE.Vector2();

const gesture = { mode: null, lastX: 0, lastY: 0, startDist: 0, startDistance: 13, moved: false, downX: 0, downY: 0 };
// solar-system.jsと同じ、iOS Safariの合成mouseup対策(詳細はそちらのコメント参照)。
let lastTouchEventTime = 0;
const SYNTHETIC_MOUSE_SUPPRESS_MS = 800;

/* ------------------------------------------------------------
   テクスチャ読込 — solar-system.jsとwindowグローバル経由で共有する。
   どちらのページが先に開かれても、892KBのJSONと画像デコードは
   1回で済ませる(詳細な設計意図はsolar-system.js側のコメントを参照)。
   ------------------------------------------------------------ */
function fetchTexturesJson() {
  if (window.__taskEngineTexturesPromise) return window.__taskEngineTexturesPromise;
  const p = fetch(new URL('./textures-data.json', import.meta.url))
    .then((r) => r.json())
    .catch((e) => { console.warn('[task-field] texture fetch failed', e); return {}; });
  window.__taskEngineTexturesPromise = p;
  return p;
}
function loadAllTextures() {
  if (window.__taskEngineTexturesLoadPromise) return window.__taskEngineTexturesLoadPromise;
  const p = fetchTexturesJson().then((src) => new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    const keys = Object.keys(src || {});
    let remaining = keys.length;
    if (remaining === 0) { resolve({}); return; }
    const out = {};
    keys.forEach((key) => {
      loader.load(
        src[key],
        (tex) => { tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; out[key] = tex; if (--remaining <= 0) resolve(out); },
        undefined,
        () => { if (--remaining <= 0) resolve(out); }
      );
    });
  }));
  window.__taskEngineTexturesLoadPromise = p;
  return p;
}

/* ------------------------------------------------------------
   星屑パーティクル(達成演出) — solar-system.jsのspawnBurstと同一設計。
   ------------------------------------------------------------ */
function spawnBurst(position, color) {
  const count = 26;
  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.x; positions[i * 3 + 1] = position.y; positions[i * 3 + 2] = position.z;
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    velocities.push(dir.multiplyScalar(0.06 + Math.random() * 0.10));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: color || 0x76c0ea, size: 0.12, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  const start = performance.now(), DURATION = 900;
  (function tick() {
    const t = (performance.now() - start) / DURATION;
    if (t >= 1) { scene.remove(points); geo.dispose(); mat.dispose(); return; }
    const arr = geo.attributes.position.array;
    for (let i = 0; i < count; i++) { arr[i * 3] += velocities[i].x; arr[i * 3 + 1] += velocities[i].y; arr[i * 3 + 2] += velocities[i].z; }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = 1 - t;
    requestAnimationFrame(tick);
  })();
}

/* ------------------------------------------------------------
   天体の生成 — 無造作配置版
   ------------------------------------------------------------
   締切からフィールド半径(=原点からの距離)を決めるところまでは
   solar-system.jsの軌道半径と同じ考え方だが、ここでは円軌道の
   代わりに球面上の"無造作な"1点に固定する。方位角・仰角は
   タスクIDのハッシュから決定的に、しかし規則性を感じさせない
   ように2つの異なるシードで独立させて散らす。
   ------------------------------------------------------------ */
function buildBody(task) {
  const fieldRadius = daysUntilToFieldRadius(task.dueDays);
  const planetRadius = loadToPlanetRadius(task.load);
  const spinSpeed = pickSpinSpeed(task.id);
  const texKey = task.isWeekly ? 'moon' : pickTexture(task.id);

  // 球面座標(方位角・仰角)を2つの独立したハッシュ乱数から決める。
  // 仰角は±80°程度に抑え、真上・真下への極端な偏りを避けて
  // カメラで見渡しやすい範囲に収める。
  const theta = hashUnit(task.id, 'az') * Math.PI * 2;
  const phi = (hashUnit(task.id, 'el') - 0.5) * Math.PI * 0.82;
  const baseX = fieldRadius * Math.cos(phi) * Math.cos(theta);
  const baseY = fieldRadius * Math.sin(phi);
  const baseZ = fieldRadius * Math.cos(phi) * Math.sin(theta);
  const basePos = new THREE.Vector3(baseX, baseY, baseZ);

  const anchor = new THREE.Group();
  anchor.position.copy(basePos);
  scene.add(anchor);

  const geo = new THREE.SphereGeometry(planetRadius, 26, 18);
  const tex = loadedTextures[texKey];
  const planetColor = typeToColor(task.learningType);
  // テクスチャの質感(陰影・クレーター等)は活かしつつ、色相は分類色に
  // 寄せる。乗算色をそのまま使うとテクスチャの明暗差で暗く沈むため、
  // 乗算前に少し明るく持ち上げて視認性を確保する。
  const tintColor = planetColor.clone().lerp(new THREE.Color(1, 1, 1), 0.28);
  const mat = new THREE.MeshStandardMaterial({ map: tex || null, color: tex ? tintColor : planetColor, roughness: 0.88, metalness: 0.04 });
  const planetMesh = new THREE.Mesh(geo, mat);
  planetMesh.userData.isPlanet = true;
  anchor.add(planetMesh);

  let ringMesh = null;
  if (task.isWeekly) {
    const inner = planetRadius * WEEKLY_RING_INNER_MULT, outer = planetRadius * WEEKLY_RING_OUTER_MULT;
    const ringGeo = new THREE.RingGeometry(inner, outer, 44);
    const uv = ringGeo.attributes.uv, pos = ringGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      uv.setXY(i, (Math.sqrt(x * x + y * y) - inner) / (outer - inner), 0.5);
    }
    const ringTex = loadedTextures.ring;
    const ringMat = new THREE.MeshBasicMaterial({ map: ringTex || null, color: ringTex ? 0xffffff : 0x88aabb, transparent: true, side: THREE.DoubleSide, opacity: 0.85 });
    ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2.15 + (hashUnit(task.id, 'ringtilt') - 0.5) * 0.5;
    ringMesh.rotation.z = hashUnit(task.id, 'ringspin') * Math.PI * 2;
    anchor.add(ringMesh);
  }

  const dangerColor = task.isOverdue ? 0xff6b6b : (task.dueDays === 0 ? 0xff9a6b : null);
  if (dangerColor) {
    const haloGeo = new THREE.SphereGeometry(planetRadius * 1.35, 18, 14);
    const haloMat = new THREE.MeshBasicMaterial({ color: dangerColor, transparent: true, opacity: 0.16, side: THREE.BackSide });
    planetMesh.add(new THREE.Mesh(haloGeo, haloMat));
  }

  return {
    task, anchor, planetMesh, ringMesh,
    basePos, planetRadius, spinSpeed,
    driftSpeed: DRIFT_SPEED_MIN + hashUnit(task.id, 'driftspd') * (DRIFT_SPEED_MAX - DRIFT_SPEED_MIN),
    driftPhase: hashUnit(task.id, 'driftphase') * Math.PI * 2,
    driftAxis: new THREE.Vector3(hashUnit(task.id, 'dax') - 0.5, hashUnit(task.id, 'day') - 0.5, hashUnit(task.id, 'daz') - 0.5).normalize(),
    color: planetColor,
    exploded: false,
  };
}

function clearBodies() {
  bodies.forEach((b) => {
    scene.remove(b.anchor);
    b.planetMesh.geometry.dispose(); b.planetMesh.material.dispose();
    if (b.ringMesh) { b.ringMesh.geometry.dispose(); b.ringMesh.material.dispose(); }
  });
  bodies = [];
}

/* ------------------------------------------------------------
   シーン構築(初回のみ)
   ------------------------------------------------------------ */
function buildSceneOnce() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);

  renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // 太陽(単一光源)を持たないフィールドなので、複数方向からの弱い
  // ライトで立体感だけを出す(特定方向に偏らない、宇宙空間らしい
  // フラットな陰影)。
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const keyLight = new THREE.DirectionalLight(0xdCe8ff, 0.9);
  keyLight.position.set(6, 8, 4);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x76c0ea, 0.35);
  rimLight.position.set(-8, -4, -6);
  scene.add(rimLight);

  raycaster = new THREE.Raycaster();
  animate();
}

function applyTexturesToScene() {
  const starTex = loadedTextures.starfield;
  if (starTex) {
    const starGeo = new THREE.SphereGeometry(90, 32, 24);
    const starMat = new THREE.MeshBasicMaterial({ map: starTex, side: THREE.BackSide, depthWrite: false });
    starfield = new THREE.Mesh(starGeo, starMat);
    scene.add(starfield);
  }
}

/* ------------------------------------------------------------
   毎フレーム更新
   ------------------------------------------------------------ */
let lastT = performance.now();
function animate() {
  if (disposed) return;
  rafId = requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  bodies.forEach((b) => {
    if (b.exploded) return;
    // 軌道は持たず、基準座標を中心にした極めて緩やかな漂いのみ。
    // sin波1つでは単調なので、駆動軸(driftAxis)まわりに回転させた
    // オフセットを足すことで、円軌道には見えない不規則な動きにする。
    const s = Math.sin(now * 0.001 * b.driftSpeed + b.driftPhase);
    const offset = new THREE.Vector3(0, DRIFT_RADIUS * s, 0).applyAxisAngle(b.driftAxis, now * 0.00012 * b.driftSpeed);
    b.anchor.position.copy(b.basePos).add(offset);
    b.planetMesh.rotation.y += b.spinSpeed * dt;
    if (b.ringMesh) b.ringMesh.rotation.z += b.spinSpeed * 0.15 * dt;
  });

  if (selectedBody && selectedBody.selectRing && !selectedBody.exploded) {
    const pulse = 1 + Math.sin(now * 0.004) * 0.08;
    selectedBody.selectRing.scale.set(pulse, pulse, pulse);
  }
  updateCalloutPosition();

  // カメラは常にユーザーの手動操作(ドラッグ/ピンチ)でのみ動く。以前は
  // 天体を選択するたびにカメラが自動でズームイン・追従していたが、
  // 選択中の天体もドリフトで常に揺れているため「視点が絶えず動く」
  // 体験になっていた。視点安定のため、選択によるカメラの自動追従・
  // 自動ズームは廃止する(カメラの中心は常に原点固定)。
  camState.distance += (camState.targetDistance - camState.distance) * Math.min(1, dt * 6);
  const az = camState.azimuth, po = camState.polar, di = camState.distance;
  camera.position.set(
    camState.target.x + di * Math.sin(po) * Math.sin(az),
    camState.target.y + di * Math.cos(po),
    camState.target.z + di * Math.sin(po) * Math.cos(az)
  );
  camera.lookAt(camState.target);

  renderer.render(scene, camera);
}

/* ------------------------------------------------------------
   選択・HUD Callout(達成/編集タブ)
   ------------------------------------------------------------ */
function updateSelectionRing() {
  bodies.forEach((b) => {
    if (b.selectRing) { b.planetMesh.remove(b.selectRing); b.selectRing.geometry.dispose(); b.selectRing.material.dispose(); b.selectRing = null; }
  });
  if (!selectedBody) return;
  const r = selectedBody.planetRadius;
  const ringGeo = new THREE.RingGeometry(r * 1.5, r * 1.62, 40);
  const ringMat = new THREE.MeshBasicMaterial({ color: selectedBody.color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  selectedBody.planetMesh.add(ring);
  selectedBody.selectRing = ring;
}

// HUD Calloutを開く: タイトル・メタ情報を差し込み、天体の負荷色を
// カード全体のアクセントカラー(--callout-c)として反映する。
function showCallout(body) {
  const callout = document.getElementById('field-callout');
  const leader = document.getElementById('field-leader');
  if (!callout || !leader) return;
  const cssColor = colorToCss(body.color);

  document.getElementById('fc-title').textContent = body.task.title;

  // リーダーラインの描画アニメーション(leader-draw)はCSSアニメーションが
  // 要素挿入時に1回だけ走る設計。同じ天体を選び直した場合でも毎回
  // 描き直したいので、要素を複製して差し替え、アニメーションを
  // 強制的に再スタートさせる。
  const oldGlow = document.getElementById('field-leader-glow');
  if (oldGlow) {
    const newGlow = oldGlow.cloneNode(true);
    oldGlow.parentNode.replaceChild(newGlow, oldGlow);
  }

  const meta = document.getElementById('fc-meta');
  let metaHtml = '';
  const loadPct = Math.round(((Math.max(LOAD_MIN, Math.min(LOAD_MAX, body.task.load || 1)) - LOAD_MIN) / (LOAD_MAX - LOAD_MIN)) * 100);
  metaHtml += '<span class="badge" style="background:' + cssColor + '18;color:' + cssColor + ';border-color:' + cssColor + '40">負荷 ' + (body.task.load || 1) + '</span>';
  if (body.task.isWeekly) {
    metaHtml += '<span class="badge badge-weekly">週次</span>';
  } else if (body.task.dueDays == null) {
    metaHtml += '<span class="badge badge-unlock">期限なし</span>';
  } else if (body.task.isOverdue) {
    metaHtml += '<span class="badge badge-overdue">' + Math.abs(body.task.dueDays) + '日超過</span>';
  } else if (body.task.dueDays === 0) {
    metaHtml += '<span class="badge badge-today-dl">今日まで</span>';
  } else if (body.task.dueDays <= 3) {
    metaHtml += '<span class="badge badge-urgent">あと' + body.task.dueDays + '日</span>';
  } else {
    metaHtml += '<span class="badge" style="background:rgba(118,192,234,0.06);color:var(--text3);border-color:var(--line)">あと' + body.task.dueDays + '日</span>';
  }
  meta.innerHTML = metaHtml;

  const completeBtn = document.getElementById('fc-complete-btn');
  const editBtn = document.getElementById('fc-edit-btn');
  completeBtn.onclick = function () { completeBody(body); };
  editBtn.onclick = function () {
    if (window.TaskField && typeof window.TaskField.onEdit === 'function') window.TaskField.onEdit(body.task.id);
  };

  callout.classList.add('show');
  leader.classList.add('show');
}
function hideCallout() {
  const callout = document.getElementById('field-callout');
  const leader = document.getElementById('field-leader');
  if (callout) callout.classList.remove('show');
  if (leader) leader.classList.remove('show');
}
// 選択中の天体のワールド座標を毎フレーム画面座標へ投影し、リーダーライン
// とCalloutカードを追従させる。ラインはSVG pathで、天体の投影点から
// カード基部(カードの少し下、天体の真上)まで緩いカーブを引く。
const _calloutProjectVec = new THREE.Vector3();
let headerClearCache = null;
function getHeaderClear() {
  // ヘッダーは撤去済みのため、カード上端がクリアすべき最小Y座標は
  // 画面上部に重なる#field-legend(左上の凡例)の下端で決まる。
  // CSSカスタムプロパティ経由でsafe-top(env())を読もうとすると、
  // ブラウザによっては未解決の式文字列がそのまま返ることがあるため、
  // 実際のDOM要素の実測位置を使う方が確実。
  const legendEl = document.getElementById('field-legend');
  if (legendEl) {
    const rect = legendEl.getBoundingClientRect();
    if (rect.height > 0) return rect.bottom + 24;
  }
  return 150;
}

function updateCalloutPosition() {
  const callout = document.getElementById('field-callout');
  const leader = document.getElementById('field-leader');
  const glowPath = document.getElementById('field-leader-glow');
  const dot = document.getElementById('field-leader-dot');
  if (!callout || !selectedBody || selectedBody.exploded || !stageEl || !camera) return;
  selectedBody.planetMesh.getWorldPosition(_calloutProjectVec);
  _calloutProjectVec.project(camera);
  if (_calloutProjectVec.z > 1) { hideCallout(); return; }
  const rect = stageEl.getBoundingClientRect();
  const x = (_calloutProjectVec.x * 0.5 + 0.5) * rect.width;
  const y = (-_calloutProjectVec.y * 0.5 + 0.5) * rect.height;

  // カードは transform:translate(-50%, -100%) で配置されるため、
  // style.top に指定する座標(cardBaseY)は「カードの下端」であり、
  // カード本体はそこから上向きに積み上がる。ヘッダーとの干渉を防ぐ
  // には、cardBaseYそのものではなく「cardBaseY - カード実測高さ」が
  // ヘッダー下端をクリアしている必要がある(この実測を怠っていたのが
  // 前回カードがヘッダーに食い込んでいた直接の原因)。
  const headerClear = getHeaderClear();
  const cardH = callout.getBoundingClientRect().height || 150;
  const gap = 14; // カード下端からリーダーライン終端までの余白(CSSのtranslate補正量と合わせる)

  const minLeaderLen = 150, maxLeaderLen = 260;
  const leaderLen = Math.min(maxLeaderLen, Math.max(minLeaderLen, y - headerClear - cardH - gap));
  let cardBaseY = y - leaderLen;
  // cardBaseYを、カード上端(cardBaseY - cardH - gap)がheaderClearを
  // 下回らない範囲にclampする。
  cardBaseY = Math.max(headerClear + cardH + gap, cardBaseY);

  // カード自体の実寸を測り、X方向も画面内に収まるようclampする。
  const cardRect = callout.getBoundingClientRect();
  const halfW = (cardRect.width || 224) / 2;
  const margin = 12;
  const clampedX = Math.min(rect.width - halfW - margin, Math.max(halfW + margin, x));

  callout.style.left = clampedX + 'px';
  callout.style.top = cardBaseY + 'px';
  if (dot) { dot.setAttribute('cx', x); dot.setAttribute('cy', y); }
  if (glowPath) {
    // カードがclampでX方向にズレた場合のみ緩いカーブを持たせ、それ
    // 以外(大半のケース)は天体からまっすぐ上に伸びる素直な線にする。
    const d = 'M ' + x + ' ' + y + ' Q ' + x + ' ' + (y - leaderLen * 0.5) + ' ' + clampedX + ' ' + cardBaseY;
    glowPath.setAttribute('d', d);
  }
}

function completeBody(body) {
  if (body.exploded) return;
  body.exploded = true;
  const worldPos = new THREE.Vector3();
  body.planetMesh.getWorldPosition(worldPos);
  spawnBurst(worldPos, body.color.getHex());
  body.anchor.visible = false;
  hideCallout();
  if (selectedBody === body) selectedBody = null;
  if (window.TaskField && typeof window.TaskField.onComplete === 'function') {
    window.TaskField.onComplete(body.task.id, body.task.isWeekly);
  }
}

/* ------------------------------------------------------------
   ポインター操作 — solar-system.jsと同一パターン(2タップ完了は
   廃止し、1タップ目の選択でCalloutを開くところまでで完結させる)。
   ------------------------------------------------------------ */
function screenToNdc(x, y) {
  const rect = stageEl.getBoundingClientRect();
  pointerNdc.x = ((x - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((y - rect.top) / rect.height) * 2 + 1;
}
function pickAt(x, y) {
  screenToNdc(x, y);
  raycaster.setFromCamera(pointerNdc, camera);
  const meshes = bodies.filter((b) => !b.exploded).map((b) => b.planetMesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  return bodies.find((b) => b.planetMesh === hits[0].object) || null;
}
function onPointerDown(e) {
  const touches = e.touches || [e];
  gesture.moved = false;
  if (touches.length === 1) {
    gesture.mode = 'rotate';
    gesture.lastX = touches[0].clientX; gesture.lastY = touches[0].clientY;
    gesture.downX = touches[0].clientX; gesture.downY = touches[0].clientY;
  } else if (touches.length >= 2) {
    gesture.mode = 'pinch';
    gesture.startDist = Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
    gesture.startDistance = camState.targetDistance;
  }
}
function onPointerMove(e) {
  const touches = e.touches;
  if (gesture.mode === 'rotate' && touches && touches.length === 1) {
    const dx = touches[0].clientX - gesture.lastX, dy = touches[0].clientY - gesture.lastY;
    gesture.lastX = touches[0].clientX; gesture.lastY = touches[0].clientY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) gesture.moved = true;
    camState.azimuth -= dx * 0.006;
    camState.polar = THREE.MathUtils.clamp(camState.polar - dy * 0.006, CAM_POLAR_MIN, CAM_POLAR_MAX);
    const hint = document.getElementById('field-hint'); if (hint) hint.classList.add('hide');
  } else if (gesture.mode === 'pinch' && touches && touches.length >= 2) {
    const dist = Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
    const ratio = gesture.startDist > 0 ? gesture.startDist / dist : 1;
    camState.targetDistance = THREE.MathUtils.clamp(gesture.startDistance * ratio, CAM_DIST_MIN, CAM_DIST_MAX);
  }
}
function onPointerUp(e) {
  const isTouchEvent = !!(e && e.changedTouches);
  if (isTouchEvent) {
    lastTouchEventTime = Date.now();
  } else if (Date.now() - lastTouchEventTime < SYNTHETIC_MOUSE_SUPPRESS_MS) {
    gesture.mode = null;
    return;
  }
  if (gesture.mode === 'rotate' && !gesture.moved) {
    const hit = pickAt(gesture.downX, gesture.downY);
    if (hit) {
      selectedBody = hit;
      updateSelectionRing();
      showCallout(hit);
    } else {
      selectedBody = null;
      updateSelectionRing();
      hideCallout();
    }
  }
  gesture.mode = null;
}
function onWheel(e) {
  e.preventDefault();
  camState.targetDistance = THREE.MathUtils.clamp(camState.targetDistance + e.deltaY * 0.01, CAM_DIST_MIN, CAM_DIST_MAX);
}
let windowListenersAttached = false;
function onWindowMouseMove(e) { if (gesture.mode === 'rotate') onPointerMove({ touches: [e] }); }
function onWindowMouseUp(e) { onPointerUp(e); }
function attachInteraction() {
  // stageEl/canvasElは同一ページ内の再遷移(タスク編集後の再navigateToなど)
  // のたびにDOMごと作り直されるため、要素側のリスナーは毎回付け直して
  // 問題ない(古いDOMごと消える)。一方windowは作り直されないので、
  // mousemove/mouseupは一度だけ登録し、多重登録によるハンドラ累積を防ぐ。
  stageEl.addEventListener('touchstart', onPointerDown, { passive: true });
  stageEl.addEventListener('touchmove', onPointerMove, { passive: true });
  stageEl.addEventListener('touchend', onPointerUp, { passive: true });
  stageEl.addEventListener('mousedown', (e) => onPointerDown({ touches: [e] }));
  stageEl.addEventListener('wheel', onWheel, { passive: false });
  if (!windowListenersAttached) {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    windowListenersAttached = true;
  }
}

function handleResize() {
  if (!renderer || !stageEl) return;
  const w = stageEl.clientWidth, h = stageEl.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// #field-stageはinnerHTML差し替え直後にDOMへ挿入されるため、
// handleResize()を即座に1回呼ぶだけだとレイアウト計算がまだ確定して
// おらず、stageEl.clientWidth/clientHeightが実際の表示サイズと異なる
// 値を返すことがある(結果としてcamera.aspectがズレ、天体が縦や横に
// 潰れて見える不具合の主因)。ResizeObserverはレイアウトが確定した
// 正確なタイミングで発火するため、window resizeイベントより確実。
let resizeObserver = null;
function attachResizeObserver() {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => handleResize());
  resizeObserver.observe(stageEl);
}
function detachResizeObserver() {
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
}

/* ------------------------------------------------------------
   公開API
   ------------------------------------------------------------ */
async function init(tasks) {
  stageEl = document.getElementById('field-stage');
  canvasEl = document.getElementById('field-canvas');
  if (!stageEl || !canvasEl) return;

  const emptyEl = document.getElementById('field-empty');
  const loadingEl = document.getElementById('field-loading');
  const hasAny = tasks && tasks.length > 0;
  if (emptyEl) emptyEl.classList.toggle('show', !hasAny);

  disposed = false;
  // navigateTo('tasks')は同一ページ内の再遷移(タスクの編集・削除後など)
  // でも呼ばれる。その際main-content.innerHTMLが丸ごと差し替わるため、
  // 前回rendererが束縛した<canvas>要素はDOMから既に取り除かれている。
  // scene有無だけでなく「rendererが今も生きたcanvasを指しているか」も
  // 見て、ズレていれば全体を作り直す。
  const canvasIsStale = renderer && renderer.domElement !== canvasEl;
  if (!scene || canvasIsStale) {
    if (renderer) {
      window.removeEventListener('resize', handleResize);
      detachResizeObserver();
      if (rafId) cancelAnimationFrame(rafId);
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      renderer = null; scene = null; camera = null; starfield = null;
      clearBodies();
    }
    buildSceneOnce();
    attachInteraction();
    window.addEventListener('resize', handleResize);
  }
  // stageEl自体が新しいDOM要素に差し替わっている可能性があるため、
  // ResizeObserverは(sceneの再構築有無に関わらず)毎回付け直す。
  // 同一要素への再observe()は無害(ResizeObserver仕様上、重複登録には
  // ならない)。
  detachResizeObserver();
  attachResizeObserver();
  handleResize();

  if (!texturesLoaded) {
    loadedTextures = await loadAllTextures();
    texturesLoaded = true;
    applyTexturesToScene();
  }

  clearBodies();
  selectedBody = null;
  hideCallout();
  (tasks || []).forEach((t) => { bodies.push(buildBody(t)); });

  if (loadingEl) loadingEl.classList.add('hide');
  handleResize();
}

function dispose() {
  disposed = true;
  if (rafId) cancelAnimationFrame(rafId);
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
  windowListenersAttached = false;
  detachResizeObserver();
  if (scene) clearBodies();
  if (renderer) { renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); }
  renderer = null; scene = null; camera = null; starfield = null;
  texturesLoaded = false; loadedTextures = {};
}

window.TaskField = {
  ready: true,
  init: init,
  dispose: dispose,
  onComplete: null,
  onEdit: null,
};
