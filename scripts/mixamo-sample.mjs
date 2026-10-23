// Sample Mixamo FBX animations (downloaded "without skin") into world-space joint rotations and
// positions at 30 fps, for scripts/cmu-moves.py --mixamo. Runs three's FBXLoader in headless Chromium.
//   node scripts/mixamo-sample.mjs <out-dir> <file.fbx> [...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const [outDir, ...files] = process.argv.slice(2);
const THREE = path.resolve('node_modules/three');
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script><script type="module">import * as THREE from 'three'; import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'; window.THREE = THREE; window.FBXLoader = FBXLoader; window.ready = true;</script>` });
  if (u.pathname.startsWith('/three/')) return route.fulfill({ path: THREE + u.pathname.slice(6), contentType: 'application/javascript' });
  if (u.pathname.startsWith('/file/')) return route.fulfill({ path: decodeURIComponent(u.pathname.slice(6)), contentType: 'application/octet-stream' });
  return route.abort();
});
await page.goto('http://local.test/');
await page.waitForFunction(() => window.ready);
const JOINTS = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
for (const f of files) {
  const res = await page.evaluate(async ([url, JOINTS]) => {
    const { THREE, FBXLoader } = window;
    const buf = await (await fetch(url)).arrayBuffer();
    const root = new FBXLoader().parse(buf, '');
    const clip = root.animations[0];
    const bone = (n) => root.getObjectByName('mixamorig' + n) || root.getObjectByName('mixamorig:' + n);
    const B = Object.fromEntries(JOINTS.map((n) => [n, bone(n)]));
    root.updateMatrixWorld(true);
    const rest = {}, restQ = {}; for (const n of JOINTS) { rest[n] = B[n].getWorldPosition(new THREE.Vector3()).toArray(); restQ[n] = B[n].getWorldQuaternion(new THREE.Quaternion()).toArray(); }
    const mixer = new THREE.AnimationMixer(root), act = mixer.clipAction(clip); act.play();
    const fps = 30, n = Math.floor(clip.duration * fps), q = {}, p = {};
    for (const nm of JOINTS) { q[nm] = []; p[nm] = []; }
    for (let i = 0; i < n; i++) {
      mixer.setTime(i / fps); root.updateMatrixWorld(true);
      for (const nm of JOINTS) { q[nm].push(...B[nm].getWorldQuaternion(new THREE.Quaternion()).toArray()); p[nm].push(...B[nm].getWorldPosition(new THREE.Vector3()).toArray()); }
    }
    return { joints: JOINTS, rest, restQ, frames: n, q, p, duration: clip.duration, missing: JOINTS.filter((j) => !B[j]) };
  }, ['http://local.test/file/' + encodeURIComponent(path.resolve(f)), JOINTS]);
  const out = path.join(outDir, path.basename(f, '.fbx') + '.json');
  fs.writeFileSync(out, JSON.stringify(res));
  console.log(path.basename(f), res.frames, 'frames', res.duration.toFixed(2) + 's', res.missing.length ? 'missing ' + res.missing : '');
}
await browser.close();
