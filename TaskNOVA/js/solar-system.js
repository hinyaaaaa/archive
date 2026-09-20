/* ============================================================
   solar-system.js — 「今日」ページの架空恒星系(module script)
   ------------------------------------------------------------
   TaskNOVA本体(通常script、ES5寄りの記法)とは別のtype=moduleとして
   読み込む。連携はwindow.SolarSystemインターフェース経由のみとし、
   本体側のグローバル変数(S, CFG等)には一切触れない疎結合構成にする。

   【設計方針の要点(会話ログより)】
   - 実在の太陽系配置は使わない。恒星系そのものが毎回タスクデータから
     組み立てられる架空の宇宙(名前・軌道・大きさすべてタスク由来)。
   - 惑星の"質感"(縞模様・クレーター等)だけは実在惑星のテクスチャ
     (Solar System Scope、CC BY 4.0)を流用するが、どのテクスチャが
     どのタスクに割り当たるかはタスクIDのハッシュ値で決定的に決まる
     架空の対応であり、実在の惑星とは無関係。
   - 軌道半径 = 締切までの残り日数(対数圧縮、近いほど内側)
   - 天体の大きさ = 負荷値(load)
   - 週次タスク = 環を持つ特別な天体として区別(通常タスクと同格に
     恒星系の一員として扱うが、見た目だけ差別化する)
   - タップで選択(リング状ハイライト+情報カード)、完了操作で
     パーティクル爆発演出。
   - カメラはOrbitControls不使用(three r128相当の制約を踏襲し、
     このプロジェクト全体の技術的一貫性に合わせた)。指1本のドラッグに
     よる自作の球面座標カメラ回転、ピンチでズームのみのシンプルな実装。
   ============================================================ */
import * as THREE from 'three';

/* ------------------------------------------------------------
   架空恒星系の物理定数(すべてこのファイル内で完結)
   ------------------------------------------------------------ */
const ORBIT_MIN = 2.4;
const ORBIT_MAX = 9.8;
const ORBIT_DAYS_CAP = 45;
const PLANET_MIN_R = 0.30;
const PLANET_MAX_R = 0.95;
const LOAD_MIN = 0.5;
const LOAD_MAX = 5;
const SUN_RADIUS = 1.15;
const WEEKLY_RING_INNER_MULT = 1.5;
const WEEKLY_RING_OUTER_MULT = 2.15;

const TEXTURE_KEYS = ['rockA', 'rockB', 'rockC', 'bandedA', 'bandedB', 'iceA', 'iceB'];

function hashStr(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function daysUntilToOrbitRadius(days) {
  if (days == null) return ORBIT_MAX;
  const clamped = Math.max(0, Math.min(ORBIT_DAYS_CAP, days));
  const t = Math.log(clamped + 1) / Math.log(ORBIT_DAYS_CAP + 1);
  return ORBIT_MIN + (ORBIT_MAX - ORBIT_MIN) * t;
}
function loadToPlanetRadius(load) {
  const l = Math.max(LOAD_MIN, Math.min(LOAD_MAX, load || 1));
  const t = (l - LOAD_MIN) / (LOAD_MAX - LOAD_MIN);
  return PLANET_MIN_R + (PLANET_MAX_R - PLANET_MIN_R) * t;
}
function pickTexture(taskId) { return TEXTURE_KEYS[hashStr(taskId) % TEXTURE_KEYS.length]; }
function pickInclinationDeg(taskId) { return ((hashStr(taskId + '_incl') % 500) / 500 - 0.5) * 46; }
function pickPhaseDeg(taskId) { return hashStr(taskId + '_phase') % 360; }
function pickSpinSpeed(taskId) { return 0.15 + (hashStr(taskId + '_spin') % 100) / 100 * 0.35; }
function pickOrbitSpeed(orbitRadius) { return 0.06 / Math.max(1, orbitRadius); }

/* ------------------------------------------------------------
   状態
   ------------------------------------------------------------ */
let renderer = null, scene = null, camera = null, canvasEl = null, stageEl = null;
let sunMesh = null, starfield = null;
let bodies = [];
let rafId = null;
let disposed = true;
let texturesLoaded = false;
let loadedTextures = {};

/* ------------------------------------------------------------
   カメラ状態(OrbitControls.js(three/examples/jsm)の設計原理を移植):
   OrbitControlsは固定の原点ではなく可変の`target`(注視点)を中心に
   球面座標で回転し、target自体もdampingFactorで滑らかに追従させる。
   これにより「対象を選ぶとカメラがそこへ寄っていく」体験を、
   カメラ位置と注視点の両方を同時になめらかに補間するだけで実現できる。
   ここではOrbitControls本体は導入せず(モバイル負荷とこのプロジェクトの
   自作カメラとの整合を優先)、その中心原理だけを軽量に再実装している。
   ------------------------------------------------------------ */
const camState = {
  azimuth: 0.5, polar: 1.05, distance: 15, targetDistance: 15,
  // 注視点(focus target)。既定は恒星系の中心(太陽=原点)。
  // 天体を選択すると、この値がその天体の現在位置へ滑らかに遷移する。
  target: new THREE.Vector3(0, 0, 0),
  targetGoal: new THREE.Vector3(0, 0, 0),
};
const CAM_POLAR_MIN = 0.35, CAM_POLAR_MAX = 2.6;
const CAM_DIST_MIN = 3.2, CAM_DIST_MAX = 26;
const CAM_DIST_OVERVIEW = 15; // 未選択時(恒星系全体を見渡す)の既定距離。選択解除時にここへ戻す。
const FOCUS_DISTANCE_MARGIN = 3.4; // 選択天体へ寄る時、天体半径に対してこれだけ余裕を持たせた距離にする(下限はCAM_DIST_MINが兼ねる)

let selectedBody = null;
let raycaster = null;
const pointerNdc = new THREE.Vector2();

const gesture = { mode: null, lastX: 0, lastY: 0, startDist: 0, startDistance: 15, moved: false, downX: 0, downY: 0 };
// iOS Safariはtouchendの直後に合成mouseupイベントを発火することがあり、
// window側のmouseupリスナーがそれを拾ってonPointerUpを二重に実行してしまう
// (惑星タップ→completeBody()が2回走り、タップした瞬間に天体が消えたように
// 見える不具合の原因)。touchendが発火した時刻を記録し、その直後の短い時間
//窓の中で発火したmouseupは合成イベントとみなして無視する。
let lastTouchEventTime = 0;
const SYNTHETIC_MOUSE_SUPPRESS_MS = 800;

/* ------------------------------------------------------------
   テクスチャ読込(遅延fetch)
   ------------------------------------------------------------
   旧実装は<head>内にbase64テクスチャ(910KB)を直接埋め込み、
   window.__SOLAR_TEXTURES__として同期的に参照していた。これは
   HTMLパース自体をブロックし、初回起動でタブバーすら表示される
   前に910KBの巨大な文字列を解析し終える必要があった。

   分割後は、テクスチャをdist/js/textures-data.json という独立した
   静的ファイルに切り出し、「今日」ページへ実際に遷移した瞬間
   (init()呼び出し時)にfetch()で取得する。これにより:
     - 初期HTML/CSS/コアJSの読み込みはテクスチャに一切ブロックされない
     - ブラウザの通常HTTPキャッシュがそのまま効く(2回目以降の起動は
       ディスクキャッシュから即座に読み込まれる)
     - 将来テクスチャの追加/差し替えをしても、コアロジックの
       キャッシュが無効化されない(ファイルが分離しているため)
   という3つの利点がある。
   ------------------------------------------------------------ */
let texturesDataPromise = null;
function fetchTexturesJson() {
  // task-field.js(タスクタブの浮遊フィールド)と同じテクスチャ画像セットを
  // 使う。どちらが先に開かれても892KBのJSONを二重フェッチしないよう、
  // windowグローバルにPromiseをキャッシュして共有する。
  if (window.__taskEngineTexturesPromise) return window.__taskEngineTexturesPromise;
  if (!texturesDataPromise) {
    texturesDataPromise = fetch(new URL('./textures-data.json', import.meta.url))
      .then((r) => r.json())
      .catch((e) => { console.warn('[solar-system] texture fetch failed', e); return {}; });
  }
  window.__taskEngineTexturesPromise = texturesDataPromise;
  return texturesDataPromise;
}

function loadAllTextures() {
  // 画像→THREE.Textureへのデコード結果もwindowにキャッシュする。
  // THREE.TextureはWebGLコンテキストではなくデータ本体なので、
  // 「今日」と「タスク」で別々のrenderer/sceneを使っていても
  // 同じTextureインスタンスをそのまま使い回せる。Promise自体を
  // キャッシュすることで、ほぼ同時に両ページが開かれた場合の
  // 二重デコードも防ぐ。
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
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          out[key] = tex;
          if (--remaining <= 0) resolve(out);
        },
        undefined,
        () => { if (--remaining <= 0) resolve(out); }
      );
    });
  }));
  window.__taskEngineTexturesLoadPromise = p;
  return p;
}

/* ------------------------------------------------------------
   星屑パーティクル(タスク完了演出)
   ------------------------------------------------------------ */
function spawnBurst(position, color) {
  const count = 26;
  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const speed = 0.06 + Math.random() * 0.10;
    velocities.push(dir.multiplyScalar(speed));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: color || 0x76c0ea, size: 0.12, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  const start = performance.now();
  const DURATION = 900;
  (function tick() {
    const t = (performance.now() - start) / DURATION;
    if (t >= 1) { scene.remove(points); geo.dispose(); mat.dispose(); return; }
    const arr = geo.attributes.position.array;
    for (let i = 0; i < count; i++) {
      arr[i * 3] += velocities[i].x;
      arr[i * 3 + 1] += velocities[i].y;
      arr[i * 3 + 2] += velocities[i].z;
    }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = 1 - t;
    requestAnimationFrame(tick);
  })();
}

/* ------------------------------------------------------------
   天体の生成
   ------------------------------------------------------------ */
function buildBody(task) {
  const orbitRadius = daysUntilToOrbitRadius(task.dueDays);
  const planetRadius = loadToPlanetRadius(task.load);
  const inclDeg = pickInclinationDeg(task.id);
  const phaseDeg = pickPhaseDeg(task.id);
  const spinSpeed = pickSpinSpeed(task.id);
  const orbitSpeed = pickOrbitSpeed(orbitRadius);
  const texKey = task.isWeekly ? 'moon' : pickTexture(task.id);

  const pivot = new THREE.Group();
  pivot.rotation.x = THREE.MathUtils.degToRad(inclDeg);
  scene.add(pivot);

  // 薄い軌道線: 円周上に点を打ってLineLoopで結ぶ。データを表現するのではなく
  // 純粋に視認性のための補助線なので、ごく低いopacityに抑える。
  const ORBIT_SEGMENTS = 96;
  const orbitPts = [];
  for (let i = 0; i <= ORBIT_SEGMENTS; i++) {
    const a = (i / ORBIT_SEGMENTS) * Math.PI * 2;
    orbitPts.push(new THREE.Vector3(Math.cos(a) * orbitRadius, 0, Math.sin(a) * orbitRadius));
  }
  const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPts);
  const orbitMat = new THREE.LineBasicMaterial({ color: 0x76c0ea, transparent: true, opacity: 0.14 });
  const orbitLine = new THREE.LineLoop(orbitGeo, orbitMat);
  pivot.add(orbitLine);

  const geo = new THREE.SphereGeometry(planetRadius, 28, 20);
  const tex = loadedTextures[texKey];
  const mat = new THREE.MeshStandardMaterial({
    map: tex || null,
    color: tex ? 0xffffff : 0x5577aa,
    roughness: 0.92,
    metalness: 0.02,
  });
  const planetMesh = new THREE.Mesh(geo, mat);
  planetMesh.userData.isPlanet = true;
  pivot.add(planetMesh);

  let ringMesh = null;
  if (task.isWeekly) {
    const inner = planetRadius * WEEKLY_RING_INNER_MULT, outer = planetRadius * WEEKLY_RING_OUTER_MULT;
    const ringGeo = new THREE.RingGeometry(inner, outer, 48);
    const uv = ringGeo.attributes.uv;
    const pos = ringGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const r = Math.sqrt(x * x + y * y);
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
    }
    const ringTex = loadedTextures.ring;
    const ringMat = new THREE.MeshBasicMaterial({
      map: ringTex || null, color: ringTex ? 0xffffff : 0x88aabb,
      transparent: true, side: THREE.DoubleSide, opacity: 0.85,
    });
    ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2.15;
    pivot.add(ringMesh);
  }

  const dangerColor = task.isOverdue ? 0xff6b6b : (task.dueDays === 0 ? 0xff9a6b : null);
  if (dangerColor && !task.isDone) {
    const haloGeo = new THREE.SphereGeometry(planetRadius * 1.35, 20, 16);
    const haloMat = new THREE.MeshBasicMaterial({ color: dangerColor, transparent: true, opacity: 0.16, side: THREE.BackSide });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    planetMesh.add(halo);
  }

  return {
    task, pivot, planetMesh, ringMesh, orbitLine,
    orbitRadius, phaseRad: THREE.MathUtils.degToRad(phaseDeg),
    spinSpeed, orbitSpeed, planetRadius,
    exploded: false,
  };
}

function clearBodies() {
  bodies.forEach((b) => {
    scene.remove(b.pivot);
    b.planetMesh.geometry.dispose();
    b.planetMesh.material.dispose();
    if (b.ringMesh) { b.ringMesh.geometry.dispose(); b.ringMesh.material.dispose(); }
    if (b.orbitLine) { b.orbitLine.geometry.dispose(); b.orbitLine.material.dispose(); }
  });
  bodies = [];
}

/* ------------------------------------------------------------
   シーン構築(初回のみ)
   ------------------------------------------------------------ */
function buildSceneOnce() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);

  renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const ambient = new THREE.AmbientLight(0xffffff, 0.22);
  scene.add(ambient);
  const sunLight = new THREE.PointLight(0xfff4d6, 3.2, 60, 1.6);
  scene.add(sunLight);

  raycaster = new THREE.Raycaster();
  animate();
}

function applyTexturesToScene() {
  const sunGeo = new THREE.SphereGeometry(SUN_RADIUS, 32, 24);
  const sunTex = loadedTextures.sun;
  const sunMat = new THREE.MeshBasicMaterial({ map: sunTex || null, color: sunTex ? 0xffffff : 0xffce7a });
  sunMesh = new THREE.Mesh(sunGeo, sunMat);
  scene.add(sunMesh);
  const glowGeo = new THREE.SphereGeometry(SUN_RADIUS * 1.5, 24, 18);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffce7a, transparent: true, opacity: 0.18, side: THREE.BackSide });
  sunMesh.add(new THREE.Mesh(glowGeo, glowMat));

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
    b.phaseRad += b.orbitSpeed * dt;
    const x = Math.cos(b.phaseRad) * b.orbitRadius;
    const z = Math.sin(b.phaseRad) * b.orbitRadius;
    b.planetMesh.position.set(x, 0, z);
    if (b.ringMesh) b.ringMesh.position.set(x, 0, z);
    b.planetMesh.rotation.y += b.spinSpeed * dt;
  });
  if (sunMesh) sunMesh.rotation.y += 0.01 * dt;

  // 選択リングの脈動: 「もう一度触れば完了する」という予告を、テキストの
  // 指示ではなく天体自体の動きで伝える(カード・ボタン廃止に伴う代替表現)。
  if (selectedBody && selectedBody.selectRing && !selectedBody.exploded) {
    const pulse = 1 + Math.sin(now * 0.004) * 0.08;
    selectedBody.selectRing.scale.set(pulse, pulse, pulse);
  }
  updateLabelPosition();

  // 選択中の天体は公転を続けるため、注視点のゴールは「その天体の現在の
  // ワールド座標」を毎フレーム追い続ける(OrbitControls.targetの考え方を
  // 「選択対象に自動追従するtarget」へ拡張したもの)。未選択時は原点(太陽)。
  if (selectedBody && !selectedBody.exploded) {
    selectedBody.planetMesh.getWorldPosition(camState.targetGoal);
  } else {
    camState.targetGoal.set(0, 0, 0);
  }
  camState.target.lerp(camState.targetGoal, Math.min(1, dt * 5));

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
   選択・完了演出
   ------------------------------------------------------------ */
function updateSelectionRing() {
  bodies.forEach((b) => {
    if (b.selectRing) { b.planetMesh.remove(b.selectRing); b.selectRing.geometry.dispose(); b.selectRing.material.dispose(); b.selectRing = null; }
  });
  if (!selectedBody) return;
  const r = selectedBody.planetRadius;
  const ringGeo = new THREE.RingGeometry(r * 1.5, r * 1.62, 40);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x76c0ea, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  selectedBody.planetMesh.add(ring);
  selectedBody.selectRing = ring;
}

function showLabel(body) {
  const label = document.getElementById('solar-label');
  const title = document.getElementById('sl-title');
  const meta = document.getElementById('sl-meta');
  if (!label) return;
  title.textContent = body.task.title;
  let metaText = body.task.isWeekly ? '週次' : (body.task.dueDays == null ? '締切なし' : body.task.dueDays <= 0 ? '今日まで' : ('あと' + body.task.dueDays + '日'));
  metaText += ' ・ 負荷' + body.task.load;
  meta.innerHTML = (body.task.isOverdue ? '<span class="sl-urgent">超過・</span>' : '') + metaText;
  label.classList.add('show');
}
function hideLabel() {
  const label = document.getElementById('solar-label');
  if (label) label.classList.remove('show');
}
// 選択中の天体のワールド座標を毎フレーム画面座標へ投影し、ラベルを追従させる。
// CSS2DRenderer(three/examples/jsm/renderers)の投影原理だけを借用した軽量版
// (専用レンダラークラス・二重描画パスは導入しない、モバイル負荷を優先した判断)。
const _labelProjectVec = new THREE.Vector3();
function updateLabelPosition() {
  const label = document.getElementById('solar-label');
  if (!label || !selectedBody || selectedBody.exploded || !stageEl || !camera) return;
  selectedBody.planetMesh.getWorldPosition(_labelProjectVec);
  _labelProjectVec.project(camera);
  if (_labelProjectVec.z > 1) { label.classList.remove('show'); return; } // カメラ背面
  const rect = stageEl.getBoundingClientRect();
  const x = (_labelProjectVec.x * 0.5 + 0.5) * rect.width;
  const y = (-_labelProjectVec.y * 0.5 + 0.5) * rect.height;
  label.style.left = x + 'px';
  label.style.top = y + 'px';
}

function completeBody(body) {
  if (body.exploded) return;
  body.exploded = true;
  const worldPos = new THREE.Vector3();
  body.planetMesh.getWorldPosition(worldPos);
  spawnBurst(worldPos, body.task.isWeekly ? 0x9fb0be : 0x76c0ea);
  body.pivot.visible = false;
  hideLabel();
  if (selectedBody === body) selectedBody = null;
  camState.targetDistance = CAM_DIST_OVERVIEW; // 完了後は視点を引いて全体を見せる
  if (window.SolarSystem && typeof window.SolarSystem.onTaskComplete === 'function') {
    window.SolarSystem.onTaskComplete(body.task.id, body.task.isWeekly);
  }
}

/* ------------------------------------------------------------
   ポインター操作
   ------------------------------------------------------------ */
function screenToNdc(x, y) {
  const rect = stageEl.getBoundingClientRect();
  pointerNdc.x = ((x - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((y - rect.top) / rect.height) * 2 + 1;
}
function pickAt(x, y) {
  screenToNdc(x, y);
  raycaster.setFromCamera(pointerNdc, camera);
  const meshes = bodies.filter(function (b) { return !b.exploded; }).map(function (b) { return b.planetMesh; });
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  return bodies.find(function (b) { return b.planetMesh === hits[0].object; }) || null;
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
    const hint = document.getElementById('solar-hint'); if (hint) hint.classList.add('hide');
  } else if (gesture.mode === 'pinch' && touches && touches.length >= 2) {
    const dist = Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
    const ratio = gesture.startDist > 0 ? gesture.startDist / dist : 1;
    camState.targetDistance = THREE.MathUtils.clamp(gesture.startDistance * ratio, CAM_DIST_MIN, CAM_DIST_MAX);
  }
}
function onPointerUp(e) {
  // touchendから発火した呼び出しはここで時刻を記録する。mouseup経由の
  // 呼び出しがその直後(SYNTHETIC_MOUSE_SUPPRESS_MS以内)に来た場合は、
  // iOS Safariが送る合成mouseupとみなして処理をスキップする。
  const isTouchEvent = !!(e && e.changedTouches);
  if (isTouchEvent) {
    lastTouchEventTime = Date.now();
  } else if (Date.now() - lastTouchEventTime < SYNTHETIC_MOUSE_SUPPRESS_MS) {
    gesture.mode = null;
    return;
  }
  if (gesture.mode === 'rotate' && !gesture.moved) {
    const hit = pickAt(gesture.downX, gesture.downY);
    if (hit && hit === selectedBody) {
      // 選択中の同じ天体を再タップ → 完了(カード・ボタンを経由しない、
      // 天体そのものをタップする行為だけで完結させる設計)。
      completeBody(hit);
      return;
    }
    selectedBody = hit;
    updateSelectionRing();
    if (hit) {
      showLabel(hit);
      // 天体の大きさに応じて「近すぎず遠すぎない」距離まで自動で寄る
      // (OrbitControls.js的な「targetを切り替えてdampingで追従させる」
      // 原理を、ズーム量の自動調整にも適用したもの)。
      camState.targetDistance = THREE.MathUtils.clamp(
        hit.planetRadius * FOCUS_DISTANCE_MARGIN, CAM_DIST_MIN, CAM_DIST_OVERVIEW
      );
    } else {
      hideLabel();
      camState.targetDistance = CAM_DIST_OVERVIEW;
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
  // stageEl/canvasElはhomeへの再遷移(今日の予定を再計算した時など、
  // 既にhomeにいる状態でnavigateTo('home')が呼ばれるケースが複数ある)
  // のたびにDOMごと作り直されるため、要素側のリスナーは毎回付け直して
  // 問題ない(古いDOMごと消える)。一方windowは作り直されないので、
  // mousemove/mouseupは一度だけ登録し、多重登録によるハンドラ累積を防ぐ。
  stageEl.addEventListener('touchstart', onPointerDown, { passive: true });
  stageEl.addEventListener('touchmove', onPointerMove, { passive: true });
  stageEl.addEventListener('touchend', onPointerUp, { passive: true });
  stageEl.addEventListener('mousedown', function (e) { onPointerDown({ touches: [e] }); });
  stageEl.addEventListener('wheel', onWheel, { passive: false });
  if (!windowListenersAttached) {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    windowListenersAttached = true;
  }
}

/* ------------------------------------------------------------
   リサイズ
   ------------------------------------------------------------ */
function handleResize() {
  if (!renderer || !stageEl) return;
  const w = stageEl.clientWidth, h = stageEl.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// #solar-stageはinnerHTML差し替え直後にDOMへ挿入されるため、
// handleResize()を即座に1回呼ぶだけだとレイアウト計算がまだ確定して
// おらず、stageEl.clientWidth/clientHeightが実際の表示サイズと異なる
// 値を返すことがある(結果としてcamera.aspectがズレ、天体が縦や横に
// 潰れて見える不具合の主因)。ResizeObserverはレイアウトが確定した
// 正確なタイミングで発火するため、window resizeイベントより確実。
let resizeObserver = null;
function attachResizeObserver() {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(function () { handleResize(); });
  resizeObserver.observe(stageEl);
}
function detachResizeObserver() {
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
}

/* ------------------------------------------------------------
   公開API
   ------------------------------------------------------------ */
async function init(tasks) {
  stageEl = document.getElementById('solar-stage');
  canvasEl = document.getElementById('solar-canvas');
  if (!stageEl || !canvasEl) return;

  const emptyEl = document.getElementById('solar-empty');
  const loadingEl = document.getElementById('solar-loading');
  const hasAny = tasks && tasks.length > 0;
  if (emptyEl) emptyEl.classList.toggle('show', !hasAny);

  disposed = false;
  // navigateTo('home')はhomeに既にいる状態でも呼ばれる(今日の予定を
  // 再計算した時、休日設定を切り替えた時など)。その際main-content.innerHTML
  // が丸ごと差し替わり、前回rendererが束縛した<canvas>要素はDOMから
  // 既に取り除かれている。scene有無だけでなく「rendererが今も生きた
  // canvasを指しているか」も見て、ズレていれば全体を作り直す。
  const canvasIsStale = renderer && renderer.domElement !== canvasEl;
  if (!scene || canvasIsStale) {
    if (renderer) {
      window.removeEventListener('resize', handleResize);
      detachResizeObserver();
      if (rafId) cancelAnimationFrame(rafId);
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      renderer = null; scene = null; camera = null; sunMesh = null; starfield = null;
      clearBodies();
    }
    buildSceneOnce();
    attachInteraction();
    window.addEventListener('resize', handleResize);
  }
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
  hideLabel();
  (tasks || []).forEach(function (t) {
    if (t.isDone) return;
    bodies.push(buildBody(t));
  });

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
  renderer = null; scene = null; camera = null; sunMesh = null; starfield = null;
  texturesLoaded = false; loadedTextures = {};
}

window.SolarSystem = {
  ready: true,
  init: init,
  dispose: dispose,
  onTaskComplete: null,
};

