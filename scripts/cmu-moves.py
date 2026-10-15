"""Bake CMU mocap BVH clips into The Dancer's moves.json (new-format entries).
   python3 scripts/cmu-moves.py <cmu-repo>/data public/dancer/moves.json

Each entry keeps per-bone *world* rotations as deltas from the CMU rest pose (all locals zero),
plus each bone's rest direction in CMU (`restDir`), so the page can align every bone's rest
direction to the dancer's own before applying the motion (CMU's legs rest angled out, the
dancer's hang straight). Hips travel is stored in leg lengths (`hipUnit: 'leg'`).
A loop is cut where the pose and velocity at the end best match the start, the last frames are
blended into the start, and net travel is removed so the loop doesn't jump.
Motion data: CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), BVH by B. Hahne."""
import sys, json, math, os
import numpy as np
from scipy.spatial.transform import Rotation as R, Slerp

# dancer bone <- CMU joint
MAP = {'Hips': 'Hips', 'Spine': 'LowerBack', 'Spine1': 'Spine', 'Spine2': 'Spine1', 'Neck': 'Neck', 'Head': 'Head',
       'LeftShoulder': 'LeftShoulder', 'LeftArm': 'LeftArm', 'LeftForeArm': 'LeftForeArm', 'LeftHand': 'LeftHand',
       'RightShoulder': 'RightShoulder', 'RightArm': 'RightArm', 'RightForeArm': 'RightForeArm', 'RightHand': 'RightHand',
       'LeftUpLeg': 'LeftUpLeg', 'LeftLeg': 'LeftLeg', 'LeftFoot': 'LeftFoot', 'LeftToeBase': 'LeftToeBase',
       'RightUpLeg': 'RightUpLeg', 'RightLeg': 'RightLeg', 'RightFoot': 'RightFoot', 'RightToeBase': 'RightToeBase'}
# the joint whose direction from this one defines the bone (CMU names)
CHILD = {'LowerBack': 'Spine1', 'Spine': 'Spine1', 'Spine1': 'Neck', 'Neck': 'Head', 'LeftShoulder': 'LeftArm', 'LeftArm': 'LeftForeArm',
         'LeftForeArm': 'LeftHand', 'RightShoulder': 'RightArm', 'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand',
         'LeftUpLeg': 'LeftLeg', 'LeftLeg': 'LeftFoot', 'LeftFoot': 'LeftToeBase', 'RightUpLeg': 'RightLeg', 'RightLeg': 'RightFoot', 'RightFoot': 'RightToeBase'}

def parse(path):
    toks = open(path).read().split()
    i = 0; joints = []; stack = []
    while toks[i] != 'MOTION':
        t = toks[i]
        if t in ('ROOT', 'JOINT'):
            joints.append({'name': toks[i + 1], 'parent': stack[-1] if stack else -1, 'ch': []}); i += 2
        elif t == 'End':
            joints.append({'name': None, 'parent': stack[-1], 'ch': []}); i += 2
        elif t == '{': stack.append(len(joints) - 1); i += 1
        elif t == '}': stack.pop(); i += 1
        elif t == 'OFFSET': joints[stack[-1]]['off'] = np.array(list(map(float, toks[i + 1:i + 4]))); i += 4
        elif t == 'CHANNELS':
            n = int(toks[i + 1]); joints[stack[-1]]['ch'] = toks[i + 2:i + 2 + n]; i += 2 + n
        else: i += 1
    nf = int(toks[i + 2]); ft = float(toks[i + 5]); vals = np.array(list(map(float, toks[i + 6:])), dtype=np.float64).reshape(nf, -1)
    return joints, vals, ft

def solve(joints, vals, ft, fps=30):
    step = max(1, round(1 / ft / fps)); vals = vals[::step]; n = len(vals)
    names = [j['name'] for j in joints]; col = 0
    W = [None] * len(joints); P = [None] * len(joints)
    rest = [None] * len(joints)
    for k, j in enumerate(joints):
        ch = j['ch']; p = j['parent']
        rest[k] = (rest[p] if p >= 0 else np.zeros(3)) + j['off']
        loc = R.identity(n); pos = np.tile(j['off'], (n, 1))
        if ch:
            v = vals[:, col:col + len(ch)]; col += len(ch)
            rc = [c for c in ch if c.endswith('rotation')]; pc = [c for c in ch if c.endswith('position')]
            if pc: pos = v[:, [ch.index(c) for c in pc]]
            if rc: loc = R.from_euler(''.join(c[0] for c in rc), v[:, [ch.index(c) for c in rc]], degrees=True)
        if p < 0: W[k] = loc; P[k] = pos
        else: W[k] = W[p] * loc; P[k] = P[p] + W[p].apply(j['off'])
    return names, W, P, rest, n

def build(path, name, label, t0=None, t1=None):
    joints, vals, ft = parse(path)
    names, W, P, rest, n = solve(joints, vals, ft)
    ix = {nm: k for k, nm in enumerate(names) if nm}
    a = ix['LeftUpLeg']; legLen = np.linalg.norm(rest[ix['LeftLeg']] - rest[a]) + np.linalg.norm(rest[ix['LeftFoot']] - rest[ix['LeftLeg']])
    hips = P[ix['Hips']]
    s0 = int((t0 or 0) * 30); s1 = int(t1 * 30) if t1 else n
    # per-frame pose vector for loop matching: world quats of the main bones
    keys = ['Hips', 'LowerBack', 'Spine1', 'Head', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg']
    Q = np.stack([W[ix[k]].as_quat() for k in keys], 1)  # n x K x 4
    def pdist(i, j):
        d = np.abs(np.einsum('kc,kc->k', Q[i], Q[j])).clip(0, 1); return float(np.sum(2 * np.arccos(d)))
    speed = np.array([pdist(i, i + 1) for i in range(n - 1)] + [0])
    best = None
    for L in range(36, min(181, s1 - s0 - 2)):
        for s in range(s0, s1 - L - 1, 2):
            e = s + L
            act = speed[s:e].mean()
            if act < 0.08: continue  # standing around
            sc = pdist(s, e) + 0.5 * abs(speed[s] - speed[e]) * 10 + 0.4 * np.linalg.norm((hips[e] - hips[s])[[0, 2]]) / legLen - 0.6 * act * 10
            if best is None or sc < best[0]: best = (sc, s, L)
    sc, s, L = best
    fr = list(range(s, s + L))
    # yaw: face the camera on average over the loop
    fwd = W[ix['Hips']][fr].apply([0, 0, 1]); yaw = math.atan2(fwd[:, 0].mean(), fwd[:, 2].mean())
    Y = R.from_euler('y', -yaw)
    out = {'name': name, 'label': label, 'fps': 30, 'frames': L, 'hipUnit': 'leg', 'bones': {}, 'restDir': {}}
    blend = 6  # frames blended into the start at the seam
    for mb, cb in MAP.items():
        if cb not in ix: continue
        k = ix[cb]; q = (Y * W[k][fr]).as_quat()
        qs = (Y * W[k][[s]]).as_quat()[0]; qe = (Y * W[k][[s + L]]).as_quat()[0]
        # blend the tail toward the frame after the loop's end mapped onto the start
        seam = R.from_quat(qs) * R.from_quat(qe).inv()  # carries the frame after the loop onto its start
        for t in range(blend):
            f = L - blend + t; w = (t + 1) / (blend + 1)
            target = (seam * R.from_quat(q[f])).as_quat()
            q[f] = Slerp([0, 1], R.from_quat([q[f], target]))([w]).as_quat()[0]
        for f in range(1, L):
            if np.dot(q[f], q[f - 1]) < 0: q[f] = -q[f]
        out['bones'][mb] = [round(float(x), 5) for x in q.reshape(-1)]
        if cb in CHILD and CHILD[cb] in ix:
            d = rest[ix[CHILD[cb]]] - rest[k]; d = d / (np.linalg.norm(d) + 1e-9); out['restDir'][mb] = [round(float(x), 5) for x in d]
    h = Y.apply(hips[fr] - hips[fr].mean(0)) / legLen
    floor = float(np.percentile(np.minimum(P[ix['LeftFoot']][fr, 1], P[ix['RightFoot']][fr, 1]), 3))
    # standing with straight legs: the hip-joint drop plus the leg length (CMU's rest legs splay out)
    standHips = floor + (rest[ix['Hips']][1] - rest[ix['LeftUpLeg']][1]) + legLen
    h[:, 1] = (hips[fr][:, 1] - standHips) / legLen
    # remove net travel so the loop closes
    drift = h[-1] - h[0] + (h[1] - h[0]); ramp = np.linspace(0, 1, L)[:, None]
    h[:, [0, 2]] -= ramp * drift[[0, 2]]
    out['hips'] = [round(float(x), 5) for x in h.reshape(-1)]
    out['seamScore'] = round(sc, 3)
    return out

if __name__ == '__main__':
    data, outp = sys.argv[1], sys.argv[2]
    clips = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
    moves = json.load(open(outp))
    have = {m['name'] for m in moves}
    for c in clips:
        sub = c['id'].split('_')[0]
        p = os.path.join(data, sub.zfill(3), c['id'] + '.bvh')
        mv = build(p, c['id'], c['label'], c.get('t0'), c.get('t1'))
        mv['pool'] = c.get('pool', 'groove')
        moves = [m for m in moves if m['name'] != mv['name']] + [mv]
        print(c['id'], c['label'], 'frames', mv['frames'], 'seam', mv['seamScore'])
    json.dump(moves, open(outp, 'w'), separators=(',', ':'))
