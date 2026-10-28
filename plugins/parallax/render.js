// Parallax Studio renderer, shared by the studio preview and the export so the two
// always match. Exposes window.ParallaxRender.
//
// Model: two 3D planes in front of a pinhole camera. The background is at distance
// D, the person `gap` in front of it. Zoom dollies the camera forward; focal length
// is the lens (50 mm = neutral). At zoom 1 and no pan or rotation both layers line
// up exactly as in the still, whatever the lens. A wide lens puts the camera
// closer, so moves shift the person more than the background (stronger parallax);
// a long lens flattens it. Pan X/Y move the camera sideways. Turn (around the
// vertical axis), tilt (around the horizontal axis) and roll (around the view
// axis) rotate both planes in 3D around the person, so the background swings past
// behind them in true perspective. Captions that follow the camera sit on their
// own plane that turns, tilts and rolls the same way.
//
// Perspective needs WebGL: the planes (and following captions) are drawn as
// textured quads on a WebGL canvas, then composited onto the 2D canvas, where the
// caption blend modes are applied.
(function () {
  // Background distance in world units (frame widths). At 50 mm the frame then spans
  // a ~40° field of view, like a real 50 mm lens, so turning and tilting the planes
  // shows natural perspective. The depth gap control is in quarters of D (its
  // original scale), so pans and zooms are unaffected by this choice.
  const D = 1.4;
  const GAP = D / 4;
  const PAN = 0.12; // pan 1.0 moves the background by 12% of the frame

  // Everything is keyframed. group "camera" moves the camera; group "scene" sets up
  // the layers and the point the camera orbits (see layout() and planes()).
  const PARAMS = {
    turn: { hint: "Orbit around the orbit point, left/right (positive brings the left side nearer)", label: "Orbit \u2194", min: -25, max: 25, step: 0.1, def: 0, fmt: (v) => v.toFixed(1) + "°" },
    tilt: { hint: "Orbit around the orbit point, up/down (positive brings the top nearer)", label: "Orbit \u2195", min: -25, max: 25, step: 0.1, def: 0, fmt: (v) => v.toFixed(1) + "°" },
    zoom: { label: "Dolly", min: 1, max: 2.5, step: 0.01, def: 1, fmt: (v) => v.toFixed(2) + "×" },
    panX: { label: "Slide X", min: -1, max: 1, step: 0.01, def: 0, fmt: (v) => v.toFixed(2) },
    panY: { label: "Slide Y", min: -1, max: 1, step: 0.01, def: 0, fmt: (v) => v.toFixed(2) },
    roll: { label: "Roll", min: -30, max: 30, step: 0.1, def: 0, fmt: (v) => v.toFixed(1) + "°" },
    focal: { label: "Lens", min: 24, max: 135, step: 1, def: 50, fmt: (v) => Math.round(v) + " mm" },
    gap: { group: "scene", label: "Depth gap", hint: "How far the background is behind the person", min: 0, max: 3, step: 0.05, def: 1, fmt: (v) => v.toFixed(2) },
    orbitX: { group: "scene", label: "Orbit point X", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    orbitY: { group: "scene", label: "Orbit point Y", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    orbitZ: {
      group: "scene", label: "Orbit depth", hint: "Where the orbit point is in depth: 0 = the person, 1 = the background", min: -0.5, max: 1.5, step: 0.01, def: 0,
      fmt: (v) => (Math.abs(v) <= 0.005 ? "person" : Math.abs(v - 1) <= 0.005 ? "backgr." : v.toFixed(2)),
    },
    bgX: { group: "scene", label: "Background X", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    bgY: { group: "scene", label: "Background Y", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    fgX: { group: "scene", label: "Person X", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    fgY: { group: "scene", label: "Person Y", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    bgSize: { group: "scene", label: "Background size", min: 1, max: 3, step: 0.01, def: 1, fmt: (v) => v.toFixed(2) + "×" },
    fgSize: { group: "scene", label: "Person size", min: 0.3, max: 3, step: 0.01, def: 1, fmt: (v) => v.toFixed(2) + "×" },
    framing: {
      group: "scene", label: "Framing", hint: "Which part of a cropped photo shows: 0% = its top, 100% = its bottom", min: 0, max: 1, step: 0.01, def: 0.2,
      fmt: (v) => Math.round(v * 100) + "%",
    },
    // bullet time: where in the captured action the person is (0 = first frame,
    // 1 = last); ramping it slowly over the clip is the slow motion
    action: {
      group: "action", label: "Action", hint: "Where in the captured second the person is: 0% = first frame, 100% = last", min: 0, max: 1, step: 0.001, def: 0,
      fmt: (v) => Math.round(v * 100) + "%",
    },
  };
  const PARAM_KEYS = Object.keys(PARAMS);

  const EASES = {
    linear: (u) => u,
    in: (u) => u * u * u,
    out: (u) => 1 - Math.pow(1 - u, 3),
    inout: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
    hold: () => 0,
  };

  // Cubic Bézier timing curves, as in CSS cubic-bezier(x1, y1, x2, y2): the curve
  // runs from (0, 0) to (1, 1) with control points (x1, y1) and (x2, y2); x is
  // time, y progress (y may go outside 0..1 for overshoot). A keyframe with
  // ease "custom" and bez [x1, y1, x2, y2] uses one for the move to the next.
  function bezier([x1, y1, x2, y2]) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (s) => ((ax * s + bx) * s + cx) * s;
    const Y = (s) => ((ay * s + by) * s + cy) * s;
    return (u) => {
      if (u <= 0) return 0;
      if (u >= 1) return 1;
      // x is monotonic for 0 <= x1, x2 <= 1: bisect for the s with X(s) = u
      let lo = 0, hi = 1, s = u;
      for (let i = 0; i < 30; i++) {
        s = (lo + hi) / 2;
        if (X(s) < u) lo = s;
        else hi = s;
      }
      return Y(s);
    };
  }

  // Bézier handles that draw each preset (in-out is an approximation of its
  // two-part cubic), used when a preset is turned into a custom curve.
  const PRESET_BEZ = {
    linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3], in: [1 / 3, 0, 2 / 3, 0], out: [1 / 3, 1, 2 / 3, 1],
    inout: [0.65, 0, 0.35, 1], hold: [1 / 3, 0, 2 / 3, 0],
  };

  // The progress function for a keyframe's move to the next one.
  function easeOf(k) {
    if (k.ease === "custom" && k.bez) return bezier(k.bez);
    return EASES[k.ease] || EASES.inout;
  }

  // Caption animation, keyframed per caption (times relative to the caption's start).
  // Position is an offset from the caption's placement, in frame widths/heights.
  const CAPTION_PARAMS = {
    x: { label: "Position X", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    y: { label: "Position Y", min: -1, max: 1, step: 0.005, def: 0, fmt: (v) => Math.round(v * 100) + "%" },
    scale: { label: "Scale", min: 0.1, max: 5, step: 0.01, def: 1, fmt: (v) => v.toFixed(2) + "×" },
    opacity: { label: "Opacity", min: 0, max: 1, step: 0.01, def: 1, fmt: (v) => Math.round(v * 100) + "%" },
    rotate: { label: "Rotation", min: -180, max: 180, step: 0.5, def: 0, fmt: (v) => v.toFixed(1) + "°" },
  };
  const CAPTION_KEYS = Object.keys(CAPTION_PARAMS);

  // A smoothed value: a monotone cubic (Fritsch-Carlson) through the keyframes, so
  // it flows through them without stopping, never overshoots a neighbouring
  // keyframe's value, and starts and ends gently. kfs are sorted by time.
  function smoothValue(kfs, t, key, def) {
    const xs = kfs.map((k) => k.t);
    const ys = kfs.map((k) => k[key] ?? def);
    const n = xs.length;
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    const d = [];
    for (let i = 0; i + 1 < n; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
    const m = new Array(n).fill(0); // flat at both ends
    for (let i = 1; i + 1 < n; i++) {
      if (d[i - 1] * d[i] <= 0) continue; // a peak or valley: flat there
      m[i] = (d[i - 1] + d[i]) / 2;
      const a = m[i] / d[i - 1];
      const b = m[i] / d[i];
      if (a * a + b * b > 9) m[i] *= 3 / Math.sqrt(a * a + b * b);
    }
    let i = 0;
    while (i + 2 < n && t > xs[i + 1]) i++;
    const hgt = xs[i + 1] - xs[i];
    const s = (t - xs[i]) / hgt;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * hgt * m[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * hgt * m[i + 1];
  }

  // Values of params at time t. Keys are per value, as in an NLE: a keyframe holds
  // only the values keyed at its time, and each value moves through just the
  // keyframes that hold it (a value with no keys stays at its default). The ease of
  // the keyframe a move starts from shapes it, except for values listed in smooth
  // ({key: true}), which use smoothValue().
  function interpolate(keyframes, t, params, smooth) {
    const all = (keyframes || []).slice().sort((a, b) => a.t - b.t);
    const out = {};
    for (const k of Object.keys(params)) {
      const kfs = all.filter((x) => x[k] != null);
      if (!kfs.length) {
        out[k] = params[k].def;
        continue;
      }
      if (smooth && smooth[k] && kfs.length > 1) {
        out[k] = smoothValue(kfs, t, k, params[k].def);
        continue;
      }
      let a = kfs[0];
      let b = kfs[0];
      for (let i = 0; i < kfs.length; i++) {
        if (kfs[i].t <= t) a = kfs[i];
        if (kfs[i].t >= t) { b = kfs[i]; break; }
        b = kfs[i];
      }
      const span = b.t - a.t;
      const u = span > 0 ? easeOf(a)(Math.min(1, Math.max(0, (t - a.t) / span))) : 0;
      out[k] = a[k] + (b[k] - a[k]) * u;
    }
    return out;
  }

  // smooth: the project's smoothed values ({key: true})
  function cameraAt(keyframes, t, smooth) {
    return interpolate(keyframes, t, PARAMS, smooth);
  }

  function captionAt(cap, t) {
    return interpolate(cap.keyframes, t - cap.start, CAPTION_PARAMS, cap.smooth);
  }

  // An image cover-fitted to the frame: half-extents in frame widths/heights (>= 0.5)
  // and the offset (bx, by) that frames it. anchorY 0 shows the top of a tall image,
  // 0.5 its middle, 1 its bottom (like CSS object-position).
  function extent(iw, ih, W, H, anchorY) {
    const k = Math.max(W / iw, H / ih);
    const ex = (iw * k) / (2 * W);
    const ey = (ih * k) / (2 * H);
    const ay = anchorY == null ? 0.5 : anchorY;
    return { ex, ey, k, bx: 0, by: (0.5 - ay) * 2 * (ey - 0.5) };
  }

  function rotation(p) {
    const r = (d) => (d * Math.PI) / 180;
    // positive turn brings the left side nearer (bigger), positive tilt the top
    const [a, b, g] = [-r(p.turn || 0), r(p.tilt || 0), r(p.roll || 0)];
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    // roll * tilt * turn
    const Ry = [[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]];
    const Rx = [[1, 0, 0], [0, cb, -sb], [0, sb, cb]];
    const Rz = [[cg, -sg, 0], [sg, cg, 0], [0, 0, 1]];
    const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
    return mul(Rz, mul(Rx, Ry));
  }

  function rotate(R, v, pivot) {
    const d = [v[0] - pivot[0], v[1] - pivot[1], v[2] - pivot[2]];
    return [0, 1, 2].map((i) => R[i][0] * d[0] + R[i][1] * d[1] + R[i][2] * d[2] + pivot[i]);
  }

  // Projects a world-space rectangle (centre, half-width, half-height; world units
  // are frame widths) to screen corners TL, TR, BL, BR as {x, y} pixels from the
  // frame centre plus z (distance, for perspective-correct texturing).
  function project(F, W, R, pivot, cx, cy, cz, hw, hh) {
    return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
      const [X, Y, Z] = rotate(R, [cx + sx * hw, cy + sy * hh, cz], pivot);
      return { x: (W * F * X) / Z, y: (W * F * Y) / Z, z: Z };
    });
  }

  // The scene part of a camera p: p.gap is the depth between the person and the
  // background (in quarters of D); the orbit point is where the camera orbits:
  // orbitX/orbitY where it sits in the resting view (frame widths/heights from the
  // centre), orbitZ its depth (0 = the person's plane, 1 = the background's).
  function sceneOf(p) {
    const d = (k) => (p[k] == null ? PARAMS[k].def : p[k]);
    return {
      gap: d("gap"), orbit: { u: d("orbitX"), v: d("orbitY"), z: d("orbitZ") }, bgScale: d("bgSize"), fgScale: d("fgSize"),
      bgPos: [d("bgX"), d("bgY")], fgPos: [d("fgX"), d("fgY")],
    };
  }

  // Camera-space layout for camera p: plane depths, the orbit point T, rotation R.
  // Works in camera space: dolly and slide move the scene instead of the camera,
  // and orbiting rotates it around T the opposite way.
  //
  // The person plane is the reference: it rests at the focal distance F, dolly
  // brings it to F / zoom and slide moves it on screen. The depth gap only puts
  // the background further behind it (scaled so it still lines up with the still
  // in the resting view), so changing the gap never moves the person.
  function layout(p, W, H) {
    const s = sceneOf(p);
    const o = s.orbit;
    const L = p.focal / 50;
    const F = L * D;
    const gap = (s.gap ?? 1) * GAP;
    const dp = F / p.zoom;
    const db = dp + gap;
    const a = H / W;
    const cx = -p.panX * PAN;
    const cy = -p.panY * PAN * a;
    // the orbit point: on the ray through (u, v) of the resting view, at its depth,
    // then moved with the scene by the dolly and slide
    const zr = F + gap * o.z;
    const T = [(o.u * zr) / F + cx, (o.v * a * zr) / F + cy, zr - (F - dp)];
    return { F, a, db, dp, mb: (F + gap) / F, cx, cy, T, R: rotation(p) };
  }

  // Screen corners of the background and person planes for camera p. cb enlarges
  // the background only (around the point that rests at the frame centre), to keep
  // its edges out of view without changing the person.
  // pad = [x, y]: the background image's generated border, as fractions of the
  // photo's width/height on each side (an outpainted background is bigger than the
  // photo, so moves can look past the photo's edges).
  //
  // bgSize / fgSize enlarge or shrink a layer around the orbit point
  // (as it sits on that layer). A person cut off by the photo's bottom edge
  // (fgEdges.bottom) scales from the bottom of the frame instead: the photo's edge
  // is at or below it, so the cut stays out of view at any scale.
  // photo = {iw, ih}: the photo's size (the person layer's); its framing is p.framing.
  function planes(p, photo, W, H, cb, pad, fgEdges) {
    const s = sceneOf(p);
    const o = s.orbit;
    const ext = extent(photo.iw, photo.ih, W, H, p.framing ?? PARAMS.framing.def);
    const l = layout(p, W, H);
    const [px, py] = pad || [0, 0];
    // m: the plane's size relative to the photo; k: the user's scale around (ax, ay),
    // a resting-view point in frame widths/heights; mo, pos: the user's move, in
    // frame widths/heights as seen in the resting view (mo converts to the plane)
    // (bx, by, ex, ey): the rectangle in the resting view, in frame widths/heights:
    // the framed photo for the layers, the frame itself for captions on a layer
    const rect = (m, z, gx, gy, k, ax, ay, mo, pos, r) => {
      const A = [l.cx + ax * m, l.cy + ay * l.a * m];
      const C = [l.cx + r.bx * m, l.cy + r.by * l.a * m];
      return project(l.F, W, l.R, l.T, A[0] + (C[0] - A[0]) * k + pos[0] * mo, A[1] + (C[1] - A[1]) * k + pos[1] * l.a * mo, z,
        r.ex * m * (1 + 2 * gx) * k, r.ey * l.a * m * (1 + 2 * gy) * k);
    };
    const frame = { bx: 0, by: 0, ex: 0.5, ey: 0.5 };
    const fgAnchorY = fgEdges && fgEdges.bottom ? 0.5 : o.v; // the bottom of the frame
    const bgArgs = [l.db, px, py, s.bgScale || 1, o.u, o.v, l.mb, s.bgPos];
    const fgArgs = [l.dp, 0, 0, s.fgScale || 1, o.u, fgAnchorY, 1, s.fgPos];
    return {
      bg: rect(l.mb * (cb || 1), ...bgArgs, ext),
      fg: rect(1, ...fgArgs, ext),
      // where the frame would be on each layer: a caption attached to a layer is
      // drawn there, so it moves exactly like that layer (the background's edge
      // enlargement cb is left out: it only exists to hide edges)
      bgFrame: rect(l.mb, l.db, 0, 0, ...bgArgs.slice(3), frame),
      fgFrame: rect(1, l.dp, 0, 0, ...fgArgs.slice(3), frame),
      R: l.R,
    };
  }

  // Where the orbit point is on screen (pixels from the frame centre, before the
  // cover zoom c is applied: multiply by c).
  function orbitOnScreen(p, W, H) {
    const l = layout(p, W, H);
    if (l.T[2] <= 1e-3) return null;
    return { x: (W * l.F * l.T[0]) / l.T[2], y: (W * l.F * l.T[1]) / l.T[2] };
  }

  // The orbit point {u, v} that puts it under screen pixel (x, y) (from the frame
  // centre, cover zoom c) at its current depth, seen with camera p.
  function pickOrbit(p, W, H, c, x, y) {
    const l = layout(p, W, H);
    // ray from the camera through the pixel, against the orbit point's plane,
    // which the orbit has turned by R around T
    const d = [x / (c * W * l.F), y / (c * W * l.F), 1];
    const n = [l.R[0][2], l.R[1][2], l.R[2][2]];
    const dn = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (Math.abs(dn) < 1e-6) return null;
    const k = (n[0] * l.T[0] + n[1] * l.T[1] + n[2] * l.T[2]) / dn;
    if (k <= 0) return null;
    const P = d.map((v) => v * k);
    // undo the orbit (R is a rotation, so its inverse is its transpose)
    const q = [P[0] - l.T[0], P[1] - l.T[1], P[2] - l.T[2]];
    const X = l.R[0][0] * q[0] + l.R[1][0] * q[1] + l.R[2][0] * q[2] + l.T[0];
    const Y = l.R[0][1] * q[0] + l.R[1][1] * q[1] + l.R[2][1] * q[2] + l.T[1];
    // back to the resting view
    const zr = l.T[2] + (l.F - l.dp);
    return { u: ((X - l.cx) * l.F) / zr, v: ((Y - l.cy) * l.F) / (zr * l.a) };
  }

  // Centre of the person (alpha-weighted) as {fx, fy} fractions of the layer,
  // counting only the part inside box ({x0, x1, y0, y1} fractions), if given.
  function personCentre(img, box) {
    const b = box || { x0: 0, x1: 1, y0: 0, y1: 1 };
    const w = 128;
    const h = Math.max(1, Math.round((w * (img.naturalHeight || img.height)) / (img.naturalWidth || img.width)));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const a = ctx.getImageData(0, 0, w, h).data;
    let sx = 0, sy = 0, sw = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if ((x + 0.5) / w < b.x0 || (x + 0.5) / w > b.x1 || (y + 0.5) / h < b.y0 || (y + 0.5) / h > b.y1) continue;
      const al = a[(y * w + x) * 4 + 3];
      sx += x * al; sy += y * al; sw += al;
    }
    return sw ? { fx: (sx / sw + 0.5) / w, fy: (sy / sw + 0.5) / h } : { fx: (b.x0 + b.x1) / 2, fy: (b.y0 + b.y1) / 2 };
  }

  // The part of the still that the resting view shows, as fractions of the still.
  function visibleBox(ext) {
    return {
      x0: 0.5 - (0.5 + ext.bx) / (2 * ext.ex), x1: 0.5 + (0.5 - ext.bx) / (2 * ext.ex),
      y0: 0.5 - (0.5 + ext.by) / (2 * ext.ey), y1: 0.5 + (0.5 - ext.by) / (2 * ext.ey),
    };
  }

  // The resting-view position {u, v} of a point given as fractions of the still.
  function stillToView(fx, fy, ext) {
    return { u: (fx - 0.5) * 2 * ext.ex + ext.bx, v: (fy - 0.5) * 2 * ext.ey + ext.by };
  }

  // Screen corners of the plane a following caption is drawn on: the frame itself
  // at the focal distance (so it fills the frame unrotated), turned with the camera.
  function captionPlane(p, W, H) {
    const F = (p.focal / 50) * D;
    const a = H / W;
    return project(F, W, rotation(p), [0, 0, F], 0, 0, F, 0.5, 0.5 * a);
  }

  const EDGES = ["top", "right", "bottom", "left"];

  // Whether none of the given edges of a plane's projected quad (zoomed by c about
  // the centre) comes into the frame.
  function covers(q, c, W, H, edges) {
    if (q.some((v) => v.z < 1e-3)) return false;
    const poly = [q[0], q[1], q[3], q[2]].map((v) => [v.x * c, v.y * c]); // top, right, bottom, left edges
    let area = 0;
    for (let i = 0; i < 4; i++) area += poly[i][0] * poly[(i + 1) % 4][1] - poly[(i + 1) % 4][0] * poly[i][1];
    const orient = Math.sign(area);
    for (const [px, py] of [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]]) {
      for (let i = 0; i < 4; i++) {
        if (edges && !edges[EDGES[i]]) continue;
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % 4];
        if (((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) * orient < -1e-6) return false;
      }
    }
    return true;
  }

  // Which borders of the person layer the person touches (a body cut off by the
  // photo's edge). Only those edges of the person plane must stay out of view; its
  // transparent edges may come into the frame.
  function touchingEdges(img) {
    const w = 256;
    const h = Math.max(1, Math.round((w * (img.naturalHeight || img.height)) / (img.naturalWidth || img.width)));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const a = ctx.getImageData(0, 0, w, h).data;
    const opaque = (x, y) => a[(y * w + x) * 4 + 3] > 128;
    const count = (n, f) => { let k = 0; for (let i = 0; i < n; i++) if (f(i)) k++; return k / n; };
    return {
      top: count(w, (x) => opaque(x, 0)) > 0.01,
      bottom: count(w, (x) => opaque(x, h - 1)) > 0.01,
      left: count(h, (y) => opaque(0, y)) > 0.01,
      right: count(h, (y) => opaque(w - 1, y)) > 0.01,
    };
  }

  const MAX_COVER = 8;

  // What keeps layer edges out of view for the whole clip (no borders at any time),
  // as { c, cb }: c zooms the whole picture and is only needed when an edge of the
  // person that the body touches (a body cut off by the photo) would show; cb
  // enlarges just the background. Sampled over the clip, so they never change
  // mid-clip. opts: fgEdges (touchingEdges()), pad (the background's generated
  // border), smooth (the project's smoothed values). iw, ih: the photo's (person layer's) size.
  function coverFactor(keyframes, length, iw, ih, W, H, opts) {
    const o = opts || {};
    const photo = { iw, ih };
    const times = keyframes.map((k) => k.t);
    for (let i = 0; i <= 120; i++) times.push((length * i) / 120);
    const cams = times.map((t) => cameraAt(keyframes, t, o.smooth));
    // the smallest value from lo up for which ok() holds. Grows in small steps first:
    // enlarging a turned plane too far puts its near corner behind the camera, so
    // ok() is only monotonic near the answer.
    const search = (lo, ok) => {
      if (ok(lo)) return lo;
      let hi = lo;
      while (!ok(hi)) {
        lo = hi;
        hi *= 1.05;
        if (hi > MAX_COVER) return MAX_COVER;
      }
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (ok(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    let c = 1;
    if (o.fgEdges && Object.values(o.fgEdges).some(Boolean)) {
      for (const cam of cams) {
        const fg = planes(cam, photo, W, H, 1, null, o.fgEdges).fg;
        c = search(c, (x) => covers(fg, x, W, H, o.fgEdges));
      }
    }
    let cb = 1;
    for (const cam of cams) cb = search(cb, (x) => covers(planes(cam, photo, W, H, x, o.pad, o.fgEdges).bg, c, W, H, null));
    return { c, cb };
  }

  // ------------------------------------------------------------ WebGL quads

  // One shared WebGL canvas that draws textured quads in perspective.
  let warper = null;
  function getWarper() {
    if (warper) return warper;
    const canvas = document.createElement("canvas");
    const opts = { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true };
    const gl2 = canvas.getContext("webgl2", opts);
    const gl = gl2 || canvas.getContext("webgl", opts);
    if (!gl) throw new Error("WebGL is not available in this browser");
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER,
      "attribute vec4 p; attribute vec2 uv; varying vec2 v; void main() { gl_Position = p; v = uv; }"));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER,
      "precision mediump float; varying vec2 v; uniform sampler2D s; uniform float a; void main() { gl_FragColor = texture2D(s, v) * a; }"));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const lp = gl.getAttribLocation(prog, "p");
    const luv = gl.getAttribLocation(prog, "uv");
    gl.enableVertexAttribArray(lp);
    gl.enableVertexAttribArray(luv);
    gl.vertexAttribPointer(lp, 4, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(luv, 2, gl.FLOAT, false, 24, 16);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    const textures = new WeakMap();
    const ua = gl.getUniformLocation(prog, "a");

    function texture(src, dynamic) {
      let tex = !dynamic && textures.get(src);
      if (tex) return tex;
      tex = dynamic ? warper.scratch || (warper.scratch = gl.createTexture()) : gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (gl2 && !dynamic) {
        // mipmaps keep large stills smooth when they are drawn small
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      if (!dynamic) textures.set(src, tex);
      return tex;
    }

    warper = {
      canvas,
      begin(w, h) {
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      },
      // corners TL, TR, BL, BR in pixels from the frame centre (W x H frame), zoomed by
      // c; alpha fades the whole quad (premultiplied); add sums it into what's there
      // instead of drawing over it (for crossfades)
      quad(src, q, W, H, c, dynamic, alpha, add) {
        gl.uniform1f(ua, alpha == null ? 1 : alpha);
        gl.blendFunc(gl.ONE, add ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        gl.bindTexture(gl.TEXTURE_2D, texture(src, dynamic));
        const uv = [[0, 0], [1, 0], [0, 1], [1, 1]];
        const data = [];
        q.forEach((v, i) => {
          // clip space with w = depth gives perspective-correct texturing
          data.push(((v.x * c) / (W / 2)) * v.z, (-(v.y * c) / (H / 2)) * v.z, 0, v.z, uv[i][0], uv[i][1]);
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
    };
    return warper;
  }

  // ------------------------------------------------------------ captions

  function fonts() {
    return (window.SlideshowCaptions && window.SlideshowCaptions.FONTS) || [
      { id: "impact", label: "Impact", css: "Impact, sans-serif" },
    ];
  }

  function fontFor(id) {
    const list = fonts();
    return list.find((f) => f.id === id) || list[0];
  }

  // Wait until a caption font is ready, so canvas text isn't drawn in a fallback.
  function loadFont(id) {
    const f = fontFor(id);
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const family = f.css.split(",")[0];
    return document.fonts.load(`${f.weight || 400} 64px ${family}`).catch(() => {});
  }

  const ANIM = 0.6; // entrance seconds
  const FADE_OUT = 0.25; // captions from before effects existed always faded out

  // Caption effects: cap.effects is a list of {id, type, ...options}. Each type has
  // defaults for a new effect and an alpha(fx, cap, t) factor (more kinds of effect
  // can add other hooks later).
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const CAPTION_EFFECTS = {
    fade: {
      label: "Fade",
      defaults: { in: true, inDur: 0.5, out: true, outDur: 0.5 },
      alpha: (fx, cap, t) =>
        (fx.in ? EASES.inout(clamp01((t - cap.start) / Math.max(0.01, fx.inDur))) : 1) *
        (fx.out ? EASES.inout(clamp01((cap.end - t) / Math.max(0.01, fx.outDur))) : 1),
    },
  };

  function captionVisible(cap, t) {
    return t >= cap.start && t <= cap.end && [cap.text, cap.text2].some((s) => s && s.trim());
  }

  // Draws a caption flat in frame coordinates; the caller sets blending.
  function drawCaptionText(ctx, cap, t, W, H) {
    if (!captionVisible(cap, t)) return;
    const lines = [cap.text, cap.text2].filter((s) => s && s.trim());
    if (!lines.length) return;
    const f = fontFor(cap.font);
    const m = Math.min(W, H);
    const px = (cap.size / 100) * m;
    const p = Math.min(1, (t - cap.start) / ANIM);
    const e = EASES.out(p);
    let alpha = cap.effects ? 1 : Math.min(1, (cap.end - t) / FADE_OUT);
    for (const fx of cap.effects || []) {
      const def = CAPTION_EFFECTS[fx.type];
      if (def && def.alpha) alpha *= def.alpha(fx, cap, t);
    }
    let dx = 0;
    let dy = 0;
    let scale = 1;
    if (cap.anim === "rise") { dy = (1 - e) * 0.6 * px; alpha *= p; }
    else if (cap.anim === "fade") alpha *= p;
    else if (cap.anim === "slide") { dx = -(1 - e) * 1.5 * px; alpha *= p; }
    else if (cap.anim === "pop") { scale = p < 0.7 ? 0.6 + (0.46 * p) / 0.7 : 1.06 - (0.06 * (p - 0.7)) / 0.3; alpha *= Math.min(1, p / 0.7); }
    const anim = captionAt(cap, t);
    alpha *= Math.max(0, Math.min(1, anim.opacity));
    if (alpha <= 0 || anim.scale <= 0) return;

    const sizes = lines.map((_, i) => (i === 0 && cap.text && cap.text.trim() ? px : px * 0.5));
    const texts = lines.map((s) => (cap.uppercase ? s.toUpperCase() : s));
    const setFont = (sz) => (ctx.font = `${f.weight || 400} ${sz}px ${f.css}`);
    // shrink to fit 85% of the width
    let fit = 1;
    texts.forEach((s, i) => {
      setFont(sizes[i]);
      const w = ctx.measureText(s).width;
      if (w > W * 0.85) fit = Math.min(fit, (W * 0.85) / w);
    });
    const sz = sizes.map((s) => s * fit);
    const gaps = sz.map((s, i) => (i === 0 ? 0 : s * 0.5));
    const lineH = sz.map((s) => s * 0.95);
    const blockH = lineH.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
    const widths = texts.map((s, i) => { setFont(sz[i]); return ctx.measureText(s).width; });
    const blockW = Math.max(...widths);

    const [v, hz] = (cap.position || "bottom-left").split("-");
    const padX = 0.07 * m;
    const padY = 0.06 * m;
    const left = hz === "left" ? padX : hz === "right" ? W - padX - blockW : (W - blockW) / 2;
    const top = v === "top" ? padY : v === "bottom" ? H - 0.09 * m - blockH : (H - blockH) / 2;

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(left + blockW / 2 + dx + anim.x * W, top + blockH / 2 + dy + anim.y * H);
    ctx.rotate((anim.rotate * Math.PI) / 180);
    ctx.scale(scale * anim.scale, scale * anim.scale);
    ctx.translate(-(left + blockW / 2), -(top + blockH / 2));
    ctx.textBaseline = "alphabetic";
    let y = top;
    texts.forEach((s, i) => {
      y += gaps[i];
      setFont(sz[i]);
      const w = widths[i];
      const x = hz === "left" ? left : hz === "right" ? left + blockW - w : left + (blockW - w) / 2;
      const base = y + sz[i] * 0.8;
      if (cap.style === "box") {
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.82)";
        ctx.fillRect(x - sz[i] * 0.3, y - sz[i] * 0.08, w + sz[i] * 0.6, sz[i] * 1.12);
        ctx.restore();
      }
      if (cap.style === "shadow") {
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = sz[i] * 0.12;
        ctx.shadowOffsetY = sz[i] * 0.04;
      }
      if (cap.style === "outline") {
        ctx.lineJoin = "round";
        ctx.lineWidth = sz[i] * 0.12;
        ctx.strokeStyle = "#000";
        ctx.strokeText(s, x, base);
      }
      ctx.fillStyle = cap.color || "#fff";
      ctx.fillText(s, x, base);
      ctx.shadowColor = "transparent";
      y += lineH[i];
    });
    ctx.restore();
  }

  // ------------------------------------------------------------ frame

  let captionCanvas = null;

  // Draw the project at time t onto ctx, whose transform maps the W x H frame onto
  // its whole canvas. images = {bg, fg, pad} (loaded <img>s; pad = bg's generated
  // border); cover = coverFactor().
  // Where a caption is attached: "person" or "background" (on that layer's 3D plane,
  // moving exactly like it; background captions are drawn behind the person),
  // "camera" (turns with the camera only) or "screen" (flat).
  function captionAttach(cap) {
    return cap.attach || (cap.follow === false ? "screen" : "person");
  }

  function drawFrame(ctx, project, images, t, W, H, cover) {
    const { c, cb } = cover || { c: 1, cb: 1 };
    const ow = ctx.canvas.width;
    const oh = ctx.canvas.height;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const cam = cameraAt(project.keyframes, t, project.smooth);
    const caps = (project.captions || []).filter((cap) => captionVisible(cap, t));
    const gw = getWarper();
    let pl = null;
    if (images.bg && images.fg) {
      // the photo's size is the person layer's
      const photo = { iw: images.fg.naturalWidth || images.fg.width, ih: images.fg.naturalHeight || images.fg.height };
      pl = planes(cam, photo, W, H, cb, images.pad, images.fgEdges);
    }

    // one caption: drawn flat, then (unless on the screen) put on its plane
    const drawCaption = (cap) => {
      ctx.globalCompositeOperation = !cap.blend || cap.blend === "normal" ? "source-over" : cap.blend;
      const attach = captionAttach(cap);
      if (attach === "screen" || (!pl && attach !== "camera")) {
        drawCaptionText(ctx, cap, t, W, H);
        return;
      }
      if (!captionCanvas) captionCanvas = document.createElement("canvas");
      if (captionCanvas.width !== ow || captionCanvas.height !== oh) {
        captionCanvas.width = ow;
        captionCanvas.height = oh;
      }
      const cc = captionCanvas.getContext("2d");
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.clearRect(0, 0, ow, oh);
      cc.setTransform(ow / W, 0, 0, oh / H, 0, 0);
      drawCaptionText(cc, cap, t, W, H);
      gw.begin(ow, oh);
      if (attach === "camera") gw.quad(captionCanvas, captionPlane(cam, W, H), W, H, 1, true);
      else gw.quad(captionCanvas, attach === "background" ? pl.bgFrame : pl.fgFrame, W, H, c, true);
      ctx.drawImage(gw.canvas, 0, 0, W, H);
    };

    // back to front: background, captions on it, person, the other captions
    if (pl) {
      gw.begin(ow, oh);
      gw.quad(images.bg, pl.bg, W, H, c);
      ctx.drawImage(gw.canvas, 0, 0, W, H);
    }
    caps.filter((cap) => captionAttach(cap) === "background").forEach(drawCaption);
    if (pl) {
      ctx.globalCompositeOperation = "source-over";
      gw.begin(ow, oh);
      const seq = images.fgSeq;
      if (seq && seq.length > 1) {
        // bullet time: the frame at this point of the action, blended into the next
        const f = Math.max(0, Math.min(1, cam.action ?? 0)) * (seq.length - 1);
        const i = Math.min(seq.length - 2, Math.floor(f));
        const frac = f - i;
        // a true crossfade: the two frames summed with weights 1 - frac and frac in
        // their own pass, so the person is never see-through where both frames
        // cover a spot and nothing of the other frame is left at the ends
        if (frac < 0.999) gw.quad(seq[i], pl.fg, W, H, c, false, 1 - frac, true);
        if (frac > 0.001) gw.quad(seq[i + 1], pl.fg, W, H, c, false, frac, true);
      } else {
        gw.quad(images.fg, pl.fg, W, H, c);
      }
      ctx.drawImage(gw.canvas, 0, 0, W, H);
    }
    caps.filter((cap) => captionAttach(cap) !== "background").forEach(drawCaption);
    ctx.restore();
  }

  window.ParallaxRender = {
    PARAMS, PARAM_KEYS, CAPTION_PARAMS, CAPTION_KEYS, CAPTION_EFFECTS, EASES, PRESET_BEZ, interpolate, cameraAt, captionAt, captionAttach, planes, extent,
    orbitOnScreen, pickOrbit, personCentre, visibleBox, stillToView, coverFactor, touchingEdges, drawFrame, loadFont, fonts, fontFor,
  };
})();
