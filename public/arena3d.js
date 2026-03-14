'use strict';
// ─────────────────────────────────────────────────────
// Arena3D — Three.js r128 fighting arena
// Uses CylinderGeometry ONLY (no CapsuleGeometry)
// ─────────────────────────────────────────────────────

const _GUARD = {
  'hips.position.x': 0,
  'hips.position.y': 1.0,
  'hips.position.z': 0,
  'hips.rotation.x': 0,
  'hips.rotation.y': 0.2,
  'hips.rotation.z': 0,
  'headGroup.rotation.x': 0,
  'headGroup.rotation.y': 0,
  'headGroup.rotation.z': 0,
  'leftArmGroup.rotation.x': -1.2,
  'leftArmGroup.rotation.y': 0,
  'leftArmGroup.rotation.z': 0.3,
  'leftForearmGroup.rotation.x': -1.5,
  'leftForearmGroup.rotation.y': 0,
  'leftForearmGroup.rotation.z': 0,
  'rightArmGroup.rotation.x': -1.0,
  'rightArmGroup.rotation.y': 0,
  'rightArmGroup.rotation.z': -0.3,
  'rightForearmGroup.rotation.x': -1.8,
  'rightForearmGroup.rotation.y': 0,
  'rightForearmGroup.rotation.z': 0,
  'leftLegGroup.rotation.x': 0.15,
  'leftLegGroup.rotation.y': 0,
  'leftLegGroup.rotation.z': 0,
  'leftCalfGroup.rotation.x': 0.1,
  'leftCalfGroup.rotation.y': 0,
  'leftCalfGroup.rotation.z': 0,
  'rightLegGroup.rotation.x': -0.1,
  'rightLegGroup.rotation.y': 0,
  'rightLegGroup.rotation.z': 0,
  'rightCalfGroup.rotation.x': 0.15,
  'rightCalfGroup.rotation.y': 0,
  'rightCalfGroup.rotation.z': 0,
};

// hips.position.y values in phases are OFFSETS from 1.0 base height
// All other values are absolute
function _resolveProps(props) {
  if (!props || props === 'guard') return {..._GUARD};
  const r = {};
  for (const [k, v] of Object.entries(props)) {
    r[k] = (k === 'hips.position.y') ? 1.0 + v : v;
  }
  return r;
}

// 21 move definitions as phase keyframes
// Each phase: { at: 0-1, set: {...props} | 'guard', hit: true (optional) }
// 'at' is fraction of total duration
// 'set' targets: reached by time of NEXT event (trigger or set)
// hips.position.y is relative offset from 1.0
const _MOVES = {
  jab: { duration: 400, phases: [
    { at: 0, set: { 'leftArmGroup.rotation.x': -0.3, 'leftForearmGroup.rotation.x': -0.2, 'hips.position.z': 0.15 } },
    { at: 0.4, hit: true },
    { at: 0.6, set: 'guard' }
  ]},
  cross: { duration: 500, phases: [
    { at: 0, set: { 'rightArmGroup.rotation.x': -0.2, 'rightForearmGroup.rotation.x': -0.1, 'hips.rotation.y': -0.4, 'hips.position.z': 0.2 } },
    { at: 0.4, hit: true },
    { at: 0.6, set: 'guard' }
  ]},
  hook: { duration: 550, phases: [
    { at: 0, set: { 'rightArmGroup.rotation.x': -0.8, 'rightArmGroup.rotation.z': -1.2, 'rightForearmGroup.rotation.x': -1.5, 'hips.rotation.y': -0.6 } },
    { at: 0.45, hit: true },
    { at: 0.65, set: 'guard' }
  ]},
  uppercut: { duration: 600, phases: [
    { at: 0, set: { 'hips.position.y': -0.1, 'rightArmGroup.rotation.x': 0.3 } },
    { at: 0.3, set: { 'hips.position.y': 0.1, 'rightArmGroup.rotation.x': -1.8, 'rightForearmGroup.rotation.x': -0.5 } },
    { at: 0.5, hit: true },
    { at: 0.7, set: 'guard' }
  ]},
  body_shot: { duration: 450, phases: [
    { at: 0, set: { 'rightArmGroup.rotation.x': -0.3, 'rightArmGroup.rotation.z': -0.8, 'hips.rotation.y': -0.3, 'hips.position.y': -0.05 } },
    { at: 0.4, hit: true },
    { at: 0.6, set: 'guard' }
  ]},
  low_kick: { duration: 600, phases: [
    { at: 0, set: { 'rightLegGroup.rotation.x': -0.8, 'rightCalfGroup.rotation.x': 0.5, 'hips.rotation.y': -0.3 } },
    { at: 0.4, hit: true },
    { at: 0.65, set: 'guard' }
  ]},
  high_kick: { duration: 800, phases: [
    { at: 0, set: { 'rightLegGroup.rotation.x': -2.0, 'rightCalfGroup.rotation.x': 0.8, 'hips.rotation.y': -0.5, 'hips.position.y': 0.05 } },
    { at: 0.4, hit: true },
    { at: 0.7, set: 'guard' }
  ]},
  body_kick: { duration: 650, phases: [
    { at: 0, set: { 'rightLegGroup.rotation.x': -1.3, 'rightCalfGroup.rotation.x': 0.5, 'hips.rotation.y': -0.5 } },
    { at: 0.4, hit: true },
    { at: 0.65, set: 'guard' }
  ]},
  knee: { duration: 500, phases: [
    { at: 0, set: { 'rightLegGroup.rotation.x': -1.5, 'rightCalfGroup.rotation.x': 1.5, 'hips.position.z': 0.2 } },
    { at: 0.4, hit: true },
    { at: 0.6, set: 'guard' }
  ]},
  elbow: { duration: 450, phases: [
    { at: 0, set: { 'rightArmGroup.rotation.x': -1.5, 'rightForearmGroup.rotation.x': -2.5, 'hips.rotation.y': -0.5, 'hips.position.z': 0.15 } },
    { at: 0.35, hit: true },
    { at: 0.6, set: 'guard' }
  ]},
  spinning_kick: { duration: 1000, phases: [
    { at: 0, set: { 'hips.rotation.y': 3.14 } },
    { at: 0.3, set: { 'rightLegGroup.rotation.x': -2.0, 'rightCalfGroup.rotation.x': 0.5, 'hips.rotation.y': 6.28 } },
    { at: 0.5, hit: true },
    { at: 0.75, set: 'guard' }
  ]},
  takedown: { duration: 1200, phases: [
    { at: 0, set: { 'hips.position.y': -0.3, 'hips.position.z': 0.5, 'hips.rotation.x': 0.5 } },
    { at: 0.3, hit: true },
    { at: 0.4, setDefender: { 'hips.position.y': -0.5, 'hips.rotation.x': -1.2 } },
    { at: 0.5, set: { 'hips.position.y': -0.3, 'hips.rotation.x': 0.3 } },
    { at: 0.8, set: 'guard', setDefender: 'guard' }
  ]},
  clinch: { duration: 800, phases: [
    { at: 0, set: { 'hips.position.z': 0.4, 'leftArmGroup.rotation.x': -0.5, 'leftArmGroup.rotation.z': 0.8, 'rightArmGroup.rotation.x': -0.5, 'rightArmGroup.rotation.z': -0.8 } },
    { at: 0.3, hit: true },
    { at: 0.6, set: 'guard' }
  ]},
  slam: { duration: 1500, phases: [
    { at: 0, set: { 'hips.position.y': 0.2 }, setDefender: { 'hips.position.y': 0.5, 'hips.rotation.x': 0.5 } },
    { at: 0.4, set: { 'hips.position.y': -0.1 }, setDefender: { 'hips.position.y': -0.5, 'hips.rotation.x': -1.5 } },
    { at: 0.5, hit: true },
    { at: 0.8, set: 'guard', setDefender: 'guard' }
  ]},
  armbar: { duration: 2000, phases: [
    { at: 0, set: { 'hips.position.y': -0.5, 'hips.rotation.x': -1.2, 'hips.rotation.z': 0.5 }, setDefender: { 'hips.position.y': -0.5, 'hips.rotation.x': -1.0 } },
    { at: 0.3, set: { 'leftArmGroup.rotation.z': 1.0 }, setDefender: { 'rightArmGroup.rotation.x': 0.5, 'rightArmGroup.rotation.z': -1.0 } },
    { at: 0.5, hit: true },
    { at: 0.8, set: 'guard', setDefender: 'guard' }
  ]},
  rear_naked: { duration: 2000, phases: [
    { at: 0, set: { 'hips.position.z': 0.5, 'leftArmGroup.rotation.x': -0.5, 'leftArmGroup.rotation.z': 1.2, 'rightArmGroup.rotation.x': -0.5, 'rightArmGroup.rotation.z': -1.2 } },
    { at: 0.2, setDefender: { 'headGroup.rotation.x': 0.3 } },
    { at: 0.5, hit: true },
    { at: 0.8, set: 'guard', setDefender: 'guard' }
  ]},
  triangle: { duration: 2000, phases: [
    { at: 0, set: { 'hips.position.y': -0.5, 'hips.rotation.x': -1.5, 'leftLegGroup.rotation.x': -1.5, 'rightLegGroup.rotation.x': -1.5 }, setDefender: { 'hips.position.y': -0.3, 'hips.rotation.x': 0.5 } },
    { at: 0.5, hit: true },
    { at: 0.8, set: 'guard', setDefender: 'guard' }
  ]},
  guillotine: { duration: 1800, phases: [
    { at: 0, set: { 'leftArmGroup.rotation.x': -0.8, 'leftArmGroup.rotation.z': 1.0, 'rightArmGroup.rotation.x': -0.8 }, setDefender: { 'hips.rotation.x': 0.5, 'headGroup.rotation.x': 0.5 } },
    { at: 0.3, set: { 'hips.position.y': -0.2 }, setDefender: { 'hips.position.y': -0.3 } },
    { at: 0.5, hit: true },
    { at: 0.8, set: 'guard', setDefender: 'guard' }
  ]},
  block: { duration: 600, phases: [
    { at: 0, set: { 'leftArmGroup.rotation.x': -1.8, 'leftForearmGroup.rotation.x': -2.0, 'rightArmGroup.rotation.x': -1.8, 'rightForearmGroup.rotation.x': -2.0, 'hips.position.y': -0.05 } },
    { at: 0.7, set: 'guard' }
  ]},
  dodge: { duration: 500, phases: [
    { at: 0, set: { 'hips.position.x': 0.4, 'hips.position.y': -0.1, 'hips.rotation.z': 0.3 } },
    { at: 0.6, set: 'guard' }
  ]},
  sprawl: { duration: 700, phases: [
    { at: 0, set: { 'hips.position.y': -0.3, 'leftLegGroup.rotation.x': 0.8, 'rightLegGroup.rotation.x': 0.8 } },
    { at: 0.7, set: 'guard' }
  ]},
};

class Arena3D {
  constructor(container) {
    this.container = container;
    this.width = container.clientWidth || 640;
    this.height = container.clientHeight || 360;
    this._anims = [];     // active animation objects { update(deltaMs):bool }
    this._particles = []; // active particle objects
    this._sprites = [];   // active damage text sprites
    this._running = true;

    this._initScene();
    this._createOctagon();
    const isMobile = this.width < 600;
    this._createCrowd(isMobile ? 20 : 60);

    this.fighterA = this._createFighter(0x4895ef, -1.5);
    this.fighterB = this._createFighter(0xe63946,  1.5);
    this.fighterB.group.rotation.y = Math.PI;
    this._applyGuard(this.fighterA);
    this._applyGuard(this.fighterB);

    this._clock = new THREE.Clock();
    this._animate();
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);
  }

  // ── Helpers ──────────────────────────────────────────────
  static _get(fighter, path) {
    const [part, prop, axis] = path.split('.');
    const obj = fighter.parts[part];
    if (!obj) return 0;
    return obj[prop][axis];
  }
  static _set(fighter, path, value) {
    const [part, prop, axis] = path.split('.');
    const obj = fighter.parts[part];
    if (obj) obj[prop][axis] = value;
  }
  static _ease(t) { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; }

  // ── Scene Init ────────────────────────────────────────────
  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a12);
    this.scene.fog = new THREE.Fog(0x0a0a12, 15, 30);

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 100);
    this.camera.position.set(0, 4, 8);
    this.camera.lookAt(0, 1, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Ambient
    this.scene.add(new THREE.AmbientLight(0x404060, 0.5));

    // Main spot (center)
    const spotMain = new THREE.SpotLight(0xffffff, 1.5, 20, Math.PI / 4, 0.5);
    spotMain.position.set(0, 10, 0);
    spotMain.castShadow = true;
    spotMain.shadow.mapSize.width = 512;
    spotMain.shadow.mapSize.height = 512;
    this.scene.add(spotMain);
    this.scene.add(spotMain.target);

    // Blue corner
    const spotBlue = new THREE.SpotLight(0x4895ef, 0.8, 15, Math.PI / 6, 0.5);
    spotBlue.position.set(-5, 8, 2);
    this.scene.add(spotBlue);

    // Red corner
    const spotRed = new THREE.SpotLight(0xe63946, 0.8, 15, Math.PI / 6, 0.5);
    spotRed.position.set(5, 8, 2);
    this.scene.add(spotRed);
  }

  _createOctagon() {
    // Floor
    const shape = new THREE.Shape();
    const sides = 8, r = 4;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 8;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      i === 0 ? shape.moveTo(x, z) : shape.lineTo(x, z);
    }
    const floorMesh = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.8 })
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.receiveShadow = true;
    this.scene.add(floorMesh);

    // Cage posts
    const postMat = new THREE.MeshStandardMaterial({ color: 0x333355 });
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 8;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3, 8), postMat);
      post.position.set(x, 1.5, z);
      this.scene.add(post);

      // Horizontal ring wire at mid-height
      const ringPost = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 6), postMat);
      ringPost.position.set(x * 0.97, 1.5, z * 0.97);
      this.scene.add(ringPost);
    }

    // Center ring
    const ringGeo = new THREE.RingGeometry(0.8, 0.85, 32);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x333355, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, lineMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(ring);

    // Center line
    const lineGeo = new THREE.PlaneGeometry(0.03, 3.5);
    const lineMesh = new THREE.Mesh(lineGeo, lineMat);
    lineMesh.rotation.x = -Math.PI / 2;
    lineMesh.position.y = 0.01;
    this.scene.add(lineMesh);
  }

  _createCrowd(count) {
    const colors = [0x2a2a4a, 0x3a2a3a, 0x2a3a3a, 0x3a3a2a, 0x3a2a2a, 0x2a3a2a];
    const skinTones = [0x8d5524, 0xc68642, 0xf1c27d, 0xffdbac, 0x3d2b1f];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const row = i % 3;
      const r = 5.5 + row * 0.9;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const yOff = row * 0.4;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const skinColor = skinTones[Math.floor(Math.random() * skinTones.length)];
      const mat = new THREE.MeshStandardMaterial({ color });
      const skinMat = new THREE.MeshStandardMaterial({ color: skinColor });

      // Head
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 7), skinMat);
      head.position.set(x, 1.35 + yOff + Math.random() * 0.08, z);
      this.scene.add(head);

      // Body
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.35, 7), mat);
      body.position.set(x, 1.1 + yOff, z);
      this.scene.add(body);

      // Arms (two small cylinders angled slightly)
      [-0.09, 0.09].forEach(dx => {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.28, 5), mat);
        arm.position.set(x + dx, 1.05 + yOff, z);
        arm.rotation.z = dx > 0 ? 0.3 : -0.3;
        this.scene.add(arm);
      });
    }
  }

  _createFighter(color, posX) {
    const f = { group: new THREE.Group(), parts: {}, color, isInAnimation: false, originalColors: {} };
    const mat    = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0x2a2a3e, roughness: 0.7 });
    f.mat = mat;
    f.skinMat = skinMat;

    // Hips group (pivot of entire body)
    f.parts.hips = new THREE.Group();
    f.parts.hips.position.y = 1.0;
    f.group.add(f.parts.hips);

    // Torso
    f.parts.torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.55, 8), skinMat);
    f.parts.torso.position.y = 0.4;
    f.parts.torso.castShadow = true;
    f.parts.hips.add(f.parts.torso);

    // Head group
    f.parts.headGroup = new THREE.Group();
    f.parts.headGroup.position.y = 0.78;
    f.parts.hips.add(f.parts.headGroup);

    f.parts.head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 10), skinMat);
    f.parts.head.castShadow = true;
    f.parts.headGroup.add(f.parts.head);

    // Neck
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 7), skinMat);
    neck.position.y = -0.12;
    f.parts.headGroup.add(neck);

    // Short (colored)
    f.parts.shorts = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.21, 0.22, 8), mat);
    f.parts.shorts.position.y = 0.06;
    f.parts.hips.add(f.parts.shorts);

    // ── Arms ──
    const uArmGeo = new THREE.CylinderGeometry(0.065, 0.055, 0.36, 6);
    const fArmGeo = new THREE.CylinderGeometry(0.052, 0.042, 0.31, 6);
    const gloveGeo = new THREE.SphereGeometry(0.068, 8, 8);

    ['left', 'right'].forEach(side => {
      const sx = side === 'left' ? -0.3 : 0.3;
      const armGrp = new THREE.Group();
      armGrp.position.set(sx, 0.62, 0);
      f.parts.hips.add(armGrp);
      f.parts[`${side}ArmGroup`] = armGrp;

      const upperArm = new THREE.Mesh(uArmGeo.clone(), skinMat);
      upperArm.position.y = -0.18;
      upperArm.castShadow = true;
      armGrp.add(upperArm);
      f.parts[`${side}UpperArm`] = upperArm;

      const forearmGrp = new THREE.Group();
      forearmGrp.position.y = -0.36;
      armGrp.add(forearmGrp);
      f.parts[`${side}ForearmGroup`] = forearmGrp;

      const forearm = new THREE.Mesh(fArmGeo.clone(), skinMat);
      forearm.position.y = -0.155;
      forearm.castShadow = true;
      forearmGrp.add(forearm);
      f.parts[`${side}Forearm`] = forearm;

      const glove = new THREE.Mesh(gloveGeo.clone(), mat);
      glove.position.y = -0.33;
      forearmGrp.add(glove);
      f.parts[`${side}Glove`] = glove;
    });

    // ── Legs ──
    const uLegGeo = new THREE.CylinderGeometry(0.09, 0.075, 0.46, 6);
    const calfGeo  = new THREE.CylinderGeometry(0.068, 0.052, 0.42, 6);
    const footGeo  = new THREE.CylinderGeometry(0.04, 0.035, 0.12, 6);

    ['left', 'right'].forEach(side => {
      const sx = side === 'left' ? -0.13 : 0.13;
      const legGrp = new THREE.Group();
      legGrp.position.set(sx, 0, 0);
      f.parts.hips.add(legGrp);
      f.parts[`${side}LegGroup`] = legGrp;

      const upperLeg = new THREE.Mesh(uLegGeo.clone(), skinMat);
      upperLeg.position.y = -0.23;
      upperLeg.castShadow = true;
      legGrp.add(upperLeg);
      f.parts[`${side}UpperLeg`] = upperLeg;

      const calfGrp = new THREE.Group();
      calfGrp.position.y = -0.46;
      legGrp.add(calfGrp);
      f.parts[`${side}CalfGroup`] = calfGrp;

      const calf = new THREE.Mesh(calfGeo.clone(), skinMat);
      calf.position.y = -0.21;
      calf.castShadow = true;
      calfGrp.add(calf);
      f.parts[`${side}Calf`] = calf;

      const foot = new THREE.Mesh(footGeo.clone(), mat);
      foot.position.set(0, -0.44, 0.05);
      foot.rotation.x = 0.3;
      calfGrp.add(foot);
    });

    f.group.position.x = posX;
    f.group.castShadow = true;
    this.scene.add(f.group);
    return f;
  }

  _applyGuard(fighter) {
    for (const [path, value] of Object.entries(_GUARD)) {
      Arena3D._set(fighter, path, value);
    }
  }

  // ── Animation engine ───────────────────────────────────────
  // Builds a tween-sequence from a move's phase definition.
  // Returns an object with update(deltaMs) → bool (true = done)
  _buildAnim(attacker, defender, phases, totalMs, onHit) {
    // Resolve 'guard' strings and apply hips.position.y offset rule
    function resolveSet(set) {
      if (!set) return null;
      if (set === 'guard') return {..._GUARD};
      return _resolveProps(set);
    }

    // Split into attacker events, defender events, and hit time
    const atkEvts = [];
    const defEvts = [];
    let hitTimeMs = null;

    for (const p of phases) {
      const tMs = p.at * totalMs;
      if (p.hit) { hitTimeMs = tMs; continue; }
      if (p.set)         atkEvts.push({ t: tMs, props: resolveSet(p.set), starts: null, done: false });
      if (p.setDefender) defEvts.push({ t: tMs, props: resolveSet(p.setDefender), starts: null, done: false });
    }

    // Assign endT: the time at which each event's lerp should complete
    // = min(next event's t for same fighter, hitTimeMs if applicable, totalMs)
    function assignEndT(evts) {
      evts.forEach(evt => {
        let end = totalMs;
        // Check next event in this fighter's list
        const nextEvt = evts.find(e => e.t > evt.t);
        if (nextEvt) end = Math.min(end, nextEvt.t);
        // Hit is also a boundary (fighter should be in attack pose AT hit time)
        if (hitTimeMs !== null && hitTimeMs > evt.t) end = Math.min(end, hitTimeMs);
        evt.endT = end;
      });
    }
    assignEndT(atkEvts);
    assignEndT(defEvts);

    let elapsed = 0;
    let hitFired = false;
    let done = false;

    function updateEvts(evts, fighter) {
      for (const evt of evts) {
        if (evt.done || elapsed < evt.t) continue;
        if (!evt.starts) {
          evt.starts = {};
          for (const k of Object.keys(evt.props)) {
            evt.starts[k] = Arena3D._get(fighter, k);
          }
        }
        const seg = elapsed - evt.t;
        const segDur = Math.max(evt.endT - evt.t, 1);
        if (seg >= segDur) {
          for (const k of Object.keys(evt.props)) Arena3D._set(fighter, k, evt.props[k]);
          evt.done = true;
        } else {
          const t = seg / segDur;
          const ease = Arena3D._ease(t);
          for (const k of Object.keys(evt.props)) {
            Arena3D._set(fighter, k, evt.starts[k] + (evt.props[k] - evt.starts[k]) * ease);
          }
        }
      }
    }

    return {
      update: (deltaMs) => {
        if (done) return true;
        elapsed += deltaMs;
        if (!hitFired && hitTimeMs !== null && elapsed >= hitTimeMs) {
          hitFired = true;
          if (onHit) onHit();
        }
        updateEvts(atkEvts, attacker);
        if (defender) updateEvts(defEvts, defender);
        if (elapsed >= totalMs) {
          done = true;
          attacker.isInAnimation = false;
          if (defender) defender.isInAnimation = false;
        }
        return done;
      }
    };
  }

  // ── Public API ────────────────────────────────────────────
  animateMove(side, moveName, onHit, speed) {
    const sp = speed || 1;
    const attacker = side === 'a' ? this.fighterA : this.fighterB;
    const defender  = side === 'a' ? this.fighterB : this.fighterA;
    const moveDef = _MOVES[moveName] || _MOVES.jab;
    const duration = moveDef.duration / sp;

    attacker.isInAnimation = true;
    const anim = this._buildAnim(attacker, defender, moveDef.phases, duration, onHit);
    this._anims.push(anim);
  }

  animateHitReaction(side, hitZone, damage) {
    const defender = side === 'a' ? this.fighterA : this.fighterB;
    const intensity = Math.min(1, (damage || 5) / 20);
    let reactPhases;

    if (hitZone === 'head') {
      reactPhases = [
        { at: 0, set: { 'headGroup.rotation.x': -0.3 * intensity, 'hips.position.z': -0.1 * intensity } },
        { at: 0.5, set: 'guard' }
      ];
    } else if (hitZone === 'legs') {
      reactPhases = [
        { at: 0, set: { 'rightLegGroup.rotation.x': 0.3 * intensity, 'hips.position.y': -0.05 * intensity } },
        { at: 0.5, set: 'guard' }
      ];
    } else {
      // body
      reactPhases = [
        { at: 0, set: { 'hips.rotation.x': 0.2 * intensity, 'hips.position.y': -0.05 * intensity } },
        { at: 0.5, set: 'guard' }
      ];
    }
    this.flashDamage(defender, intensity);
    const anim = this._buildAnim(defender, null, reactPhases, 400, null);
    this._anims.push(anim);
  }

  animateKO(side) {
    const defender = side === 'a' ? this.fighterA : this.fighterB;
    defender.isInAnimation = true;
    const koPhases = [
      { at: 0, set: { 'hips.position.y': -0.2, 'hips.rotation.x': -0.3 } },
      { at: 0.3, set: { 'hips.position.y': -0.6, 'hips.rotation.x': -1.5,
        'leftArmGroup.rotation.x': 0, 'leftArmGroup.rotation.z': 0.1,
        'rightArmGroup.rotation.x': 0, 'rightArmGroup.rotation.z': -0.1,
        'leftForearmGroup.rotation.x': 0,
        'rightForearmGroup.rotation.x': 0
      } },
    ];
    const anim = this._buildAnim(defender, null, koPhases, 2000, null);
    this._anims.push(anim);
  }

  flashDamage(fighter, intensity) {
    const flashColor = new THREE.Color(1, 0, 0);
    const saved = {};
    for (const [name, part] of Object.entries(fighter.parts)) {
      if (part && part.material) {
        saved[name] = part.material.color.clone();
        part.material.color.lerp(flashColor, intensity * 0.7);
      }
    }
    setTimeout(() => {
      for (const [name, part] of Object.entries(fighter.parts)) {
        if (part && part.material && saved[name]) {
          part.material.color.copy(saved[name]);
        }
      }
    }, 180);
  }

  spawnHitParticles(worldPos, color, count) {
    for (let i = 0; i < (count || 6); i++) {
      const geo = new THREE.SphereGeometry(0.025, 4, 4);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
      const p = new THREE.Mesh(geo, mat);
      p.position.copy(worldPos);
      p.position.y += 1.2;
      this.scene.add(p);
      const vx = (Math.random() - 0.5) * 0.12;
      let vy = 0.04 + Math.random() * 0.12;
      const vz = (Math.random() - 0.5) * 0.12;
      const startMs = performance.now();
      this._particles.push({
        mesh: p, mat,
        vx, vy, vz,
        startMs,
        update: (now) => {
          const t = (now - startMs) / 700;
          if (t > 1) { this.scene.remove(p); geo.dispose(); mat.dispose(); return true; }
          p.position.x += vx; p.position.y += vy; p.position.z += vz;
          vy -= 0.004; // gravity
          mat.opacity = 1 - t;
          return false;
        }
      });
    }
  }

  showDamageText(worldPos, text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 46px "Bebas Neue", Impact, sans-serif';
    ctx.fillStyle = color || '#e63946';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.textAlign = 'center';
    ctx.strokeText(text, 64, 50);
    ctx.fillText(text, 64, 50);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(worldPos);
    sprite.position.y += 1.8;
    sprite.scale.set(0.9, 0.45, 1);
    this.scene.add(sprite);
    const startMs = performance.now();
    this._sprites.push({
      sprite, mat,
      update: (now) => {
        const t = (now - startMs) / 1200;
        if (t > 1) { this.scene.remove(sprite); tex.dispose(); mat.dispose(); return true; }
        sprite.position.y += 0.012;
        mat.opacity = t < 0.3 ? 1 : 1 - (t - 0.3) / 0.7;
        return false;
      }
    });
  }

  setFighterColors(colorA, colorB) {
    if (colorA && this.fighterA) {
      this.fighterA.mat.color.set(colorA);
    }
    if (colorB && this.fighterB) {
      this.fighterB.mat.color.set(colorB);
    }
  }

  // ── Render loop ───────────────────────────────────────────
  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());

    const deltaMs = this._clock.getDelta() * 1000;
    const time = this._clock.getElapsedTime();
    const now = performance.now();

    // Idle breathing (only when not animating)
    if (this.fighterA && !this.fighterA.isInAnimation) {
      this.fighterA.parts.hips.position.y = 1.0 + Math.sin(time * 2.1) * 0.012;
    }
    if (this.fighterB && !this.fighterB.isInAnimation) {
      this.fighterB.parts.hips.position.y = 1.0 + Math.sin(time * 2.1 + 1.1) * 0.012;
    }

    // Run animations
    this._anims = this._anims.filter(a => !a.update(deltaMs));

    // Run particles
    this._particles = this._particles.filter(p => !p.update(now));

    // Run sprites
    this._sprites = this._sprites.filter(s => !s.update(now));

    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    if (this.width < 1) return;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
  }

  destroy() {
    this._running = false;
    window.removeEventListener('resize', this._resizeHandler);
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
  }
}

window.Arena3D = Arena3D;
