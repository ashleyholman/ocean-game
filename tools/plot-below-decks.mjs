/**
 * Draw the below-decks arrangement from the ship's own geometry.
 *
 *   npm run ship:belowdecks
 *
 * **It is built now, so the drawing reads the built ship rather than a copy of
 * the plan.** Bulkhead stations, floor heights, doorway offsets, room widths and
 * the hatchway all come from `hullForm.ts` and `deckInterior.ts` — the same
 * expressions the loft draws and the walker stands on. It used to carry its own
 * constants beside the plan's, which was fine while nothing existed to disagree
 * with; it is exactly the fault this ship has been bitten by in every round
 * since the rig, so the moment the rooms became real the copies had to go.
 *
 * **The furniture is read from the geometry too, now.** It used to be hand-typed
 * rectangles beside the plan's prose, which was honest while nothing was built
 * and became the same fault as the constants the moment the rooms were
 * furnished: a drawing that agrees with a document instead of with the ship.
 * Every piece below is drawn from the solids `interiorFittings.ts` actually
 * emits — turned pieces as the quadrilaterals they are, not as the rectangles
 * they are not — so a bulkhead that moves, a berth that lengthens or a locker
 * that is deleted shows up here on the next run without anybody editing this
 * file. The only thing still authored here is what each piece is *called*.
 */
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const server = await createServer({
  configFile: false, root: process.cwd(), appType: 'custom',
  logLevel: 'error', server: { middlewareMode: true, ws: false },
});
const hf = await server.ssrLoadModule('/src/vessel/schooner/hullForm.ts');
const di = await server.ssrLoadModule('/src/vessel/schooner/deckInterior.ts');
// The captain's desk draws itself. Everything else in the cabin below is still
// an indicative block, and the difference matters now: the desk is the one
// piece aboard that is *not* square with the keel, so a hand-typed rectangle
// for it is not merely approximate — it is the wrong shape, and it would go on
// looking plausible.
const cd = await server.ssrLoadModule('/src/vessel/schooner/captainsDesk.ts');
const rf = await server.ssrLoadModule('/src/vessel/schooner/roomFitting.ts');
const fit = await server.ssrLoadModule('/src/vessel/schooner/interiorFittings.ts');

const HL = hf.HALF_LENGTH, BEAMD = hf.DECK_BEAM_DEPTH;
const AFT_SOLE = hf.CABIN_SOLE_Y, MID_SOLE = hf.PLATFORM_SOLE_Y, FWD_SOLE = hf.FORECASTLE_SOLE_Y;
const TRANSOM = hf.CABIN_AFT_Z;
const CAB_BHD = hf.CABIN_FORWARD_Z, AFT_BHD = hf.PLATFORM_AFT_Z;
const FWD_BHD = hf.PLATFORM_FORWARD_Z, PEAK_BHD = hf.FORECASTLE_FORWARD_Z;
const DOOR = di.DOORWAY_OFFSET, DOORW = di.DOORWAY_HALF_BREADTH;
const soleAt = (z) => (z < AFT_BHD ? AFT_SOLE : z > FWD_BHD ? FWD_SOLE : MID_SOLE);
const underBeam = (z) => hf.deckCrownY(z) + hf.deckLevelRise(z) - BEAMD;
const halfW = (z, sole) => di.roomHalfWidthAt(z, sole);

const STYLE = `<style>svg{--paper:#F7F4EE;--panel:#EFE9DE;--ink:#3A2E22;--ink2:#6B5B49;--ink3:#8C7D6B;--rule:#D2C8B7;--rule2:#B0A18B;--warm:#9C5B2E;--cask:#B98A55}@media (prefers-color-scheme:dark){svg{--paper:#191613;--panel:#272119;--ink:#E9E0D3;--ink2:#B5A793;--ink3:#8A7C6A;--rule:#3A3229;--rule2:#5A4C3C;--warm:#D9924F;--cask:#8A6236}}</style>`;
const R = (n) => Math.round(n);
const poly = (p) => p.map((q, i) => `${i ? 'L' : 'M'}${R(q[0])} ${R(q[1])}`).join('');

const S = 58, X0 = 48, PLAN_MID = 214, PB = 700;
const zx = (z) => X0 + (z + HL) * S;
const bx = (b) => PLAN_MID - b * S;
const py = (y) => PB - y * S;
const zs = [];
for (let z = -HL; z <= HL + 1e-9; z += 0.2) zs.push(Math.min(z, HL));

const g = [];
g.push(`<svg viewBox="0 0 1000 770" xmlns="http://www.w3.org/2000/svg" role="img" width="100%" style="font-family:ui-sans-serif,system-ui,sans-serif">`);
g.push(`<title>Below-decks arrangement with every space given a use</title>`);
g.push(`<desc>Plan and side view of the schooner's below-decks arrangement, drawn from the built ship. The captain's cabin aft has its furniture at the low sides and a clear standing strip on the centreline; a pantry and spirit locker flank a short ship's ladder; the wardroom carries the mainmast, the pump well, a mess table with a form each side, runs of chests along both sides, and the mate's and surgeon's cabins flanking the hatchway; the forecastle holds the galley hearth to port, its dresser to starboard, a hinged table at the foremast and four berths in two tiers in the bow; and the peak is the sail and boatswain's store.</desc>`);
g.push(STYLE);
g.push(`<rect width="1000" height="770" fill="var(--paper)"/>`);
g.push(`<text x="48" y="22" font-size="13" fill="var(--ink2)">Plan — front of the ship on the right. ${di.belowDecksSoleArea().toFixed(1)} m² of walkable floor, drawn from the built ship.</text>`);

const sil = [
  ...zs.map((z) => [zx(z - hf.counterRakeShift(z, hf.deckAtSideY(z) + hf.deckLevelRise(z))), bx(di.roofHalfWidthAt(z))]),
  ...zs.slice().reverse().map((z) => [zx(z - hf.counterRakeShift(z, hf.deckAtSideY(z) + hf.deckLevelRise(z))), bx(-di.roofHalfWidthAt(z))]),
];
g.push(`<path d="${poly(sil)}Z" fill="var(--panel)" stroke="var(--rule2)" stroke-width="1"/>`);
for (const [z0, z1, sole, op] of [
  [TRANSOM, CAB_BHD, AFT_SOLE, 0.3], [CAB_BHD, AFT_BHD, AFT_SOLE, 0.12],
  [AFT_BHD, FWD_BHD, MID_SOLE, 0.2], [FWD_BHD, PEAK_BHD, FWD_SOLE, 0.3], [PEAK_BHD, 7.2, FWD_SOLE, 0.08],
]) {
  const pts = [];
  for (let z = z0; z <= z1 + 1e-9; z += 0.15) pts.push([zx(z), bx(halfW(Math.min(z, z1), sole))]);
  for (let z = z1; z >= z0 - 1e-9; z -= 0.15) pts.push([zx(z), bx(-halfW(Math.max(z, z0), sole))]);
  g.push(`<path d="${poly(pts)}Z" fill="var(--warm)" opacity="${op}"/>`);
  if (z0 > -HL) {
    const b = halfW(z0, sole);
    g.push(`<line x1="${R(zx(z0))}" y1="${R(bx(b))}" x2="${R(zx(z0))}" y2="${R(bx(-b))}" stroke="var(--ink)" stroke-width="1.8"/>`);
  }
}
g.push(`<line x1="${R(zx(-HL))}" y1="${R(bx(0))}" x2="${R(zx(HL))}" y2="${R(bx(0))}" stroke="var(--rule2)" stroke-width="0.7" stroke-dasharray="9 6"/>`);

const F = (z0, z1, b0, b1, t, o = {}) => {
  const x = R(zx(z0)), y = R(bx(Math.max(b0, b1)));
  const w = R((z1 - z0) * S), h = R(Math.abs(b1 - b0) * S);
  const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--warm)" opacity="${o.op ?? 0.42}" stroke="var(--warm)" stroke-width="1.2"/>`];
  if (t) parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + 3.5}" font-size="${o.size || 9.5}" fill="${o.fill || 'var(--ink)'}" text-anchor="middle">${t}</text>`);
  return parts.join('');
};
const T = (z, b, t, size = 9.5, fill = 'var(--ink2)') => `<text x="${R(zx(z))}" y="${R(bx(b)) + 3.5}" font-size="${size}" fill="${fill}" text-anchor="middle">${t}</text>`;

// --- the furniture, from the solids the ship actually emits ------------------
//
// One pass over `interiorFittingsNow()`, so nothing here has to know what has
// been built. A piece's *massing* is the part of it a plan drawing wants, so
// what is drawn is the solids a body can be stopped by — the carcases — and
// where a fitting has none (a shelf, a rack, a compass) its whole timber is
// drawn instead, faintly. Turned pieces come out as quadrilaterals because
// that is what they are; the desk spent two rounds being a rectangle here that
// it was not.
const FURNITURE_LABELS = {
  chartDesk: 'chart desk',
  deskChair: 'seat',
  sternLockerPort: 'bench',
  sternLockerStarboard: 'bench',
  boxBerth: 'box berth',
  washstand: 'wash',
  hangingLocker: 'press',
  captainSeaChest: 'chest',
  wardroomTable: 'table',
  wardroomFormPort: '',
  wardroomFormStarboard: '',
  mateCabin: "mate's cabin",
  surgeonCabin: "surgeon's cabin",
  wardroomStoresPort: 'chests · stores',
  wardroomStoresStarboard: 'chests · stores',
  galleyHearth: 'galley',
  galleyDresser: 'dresser',
  crewBerthsPort: 'two berths',
  crewBerthsStarboard: 'two berths',
  foremastTable: 'mess',
  crewChestPort: 'chest',
  crewChestStarboard: 'chest',
  pumpWell: '',
  pumpTube: '',
};

/** The four corners of a solid in plan, turn included. */
const solidPlan = (sd) => {
  if (sd.kind !== 'box') {
    const r = Math.max(sd.radiusA, sd.radiusB);
    return [
      [sd.a.x - r, sd.a.z - r], [sd.a.x + r, sd.a.z - r],
      [sd.a.x + r, sd.a.z + r], [sd.a.x - r, sd.a.z + r],
    ];
  }
  const yaw = sd.yaw ?? 0, c = Math.cos(yaw), sn = Math.sin(yaw);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const lx = sx * sd.half.x, lz = sz * sd.half.z;
    return [sd.centre.x + lx * c + lz * sn, sd.centre.z - lx * sn + lz * c];
  });
};

const fittings = fit.interiorFittingsNow();
for (const piece of fittings) {
  if (piece.kind === 'hatchwayBoards' || piece.kind === 'foreScuttleSoffit') continue;
  const massing = piece.solids.filter((sd) => sd.collides);
  const drawn = massing.length ? massing : piece.solids;
  const op = massing.length ? 0.42 : 0.22;
  let cx = 0, cz = 0, n = 0;
  for (const sd of drawn) {
    const pts = solidPlan(sd).map(([x, z]) => [zx(z), bx(x)]);
    g.push(`<path d="${poly(pts)}Z" fill="var(--warm)" opacity="${op}" stroke="var(--warm)" stroke-width="0.8"/>`);
    for (const [x, z] of solidPlan(sd)) { cx += x; cz += z; n++; }
  }
  const label = FURNITURE_LABELS[piece.name];
  if (label && n) {
    g.push(`<text x="${R(zx(cz / n))}" y="${R(bx(cx / n)) + 3.5}" font-size="9" fill="var(--ink)" text-anchor="middle">${label}</text>`);
  }
}
g.push(T(-7.5, 1.42, 'rudder', 9, 'var(--warm)'));
g.push(T(-6.1, -0.02, 'clear — the only 1.85 m', 9, 'var(--warm)'));

// 2 pantry, ladder, spirit locker — still indicative: nothing is built in here.
g.push(F(hf.COMPANION_AFT_Z, hf.COMPANION_FORWARD_Z, -hf.COMPANION_HALF_BREADTH, hf.COMPANION_HALF_BREADTH, 'ladder', { op: 0.5, size: 9 }));
g.push(F(-4.2, -3.15, 0.55, 1.72, 'pantry', { op: 0.3, size: 9 }));
g.push(F(-4.2, -3.5, -0.55, -1.72, 'spirits', { op: 0.3, size: 9 }));
g.push(F(-2.95, -2.5, -0.6, -1.7, 'oilskins', { op: 0.22, size: 9 }));

// The hatchway is a shaft: same footprint as the deck's cargo hatch, directly
// under it, so a cask travels one vertical line. Boards over it, walked on.
g.push(`<rect x="${R(zx(di.HATCHWAY_AFT_Z))}" y="${R(bx(di.HATCHWAY_HALF_BREADTH))}" width="${R((di.HATCHWAY_FORWARD_Z - di.HATCHWAY_AFT_Z) * S)}" height="${R(2 * di.HATCHWAY_HALF_BREADTH * S)}" fill="var(--warm)" opacity="0.14" stroke="var(--warm)" stroke-width="2"/>`);
for (let i = 1; i < 5; i++) {
  const b = 0.75 - (1.5 * i) / 5;
  g.push(`<line x1="${R(zx(0.5))}" y1="${R(bx(b))}" x2="${R(zx(2.3))}" y2="${R(bx(b))}" stroke="var(--warm)" stroke-width="0.7" opacity="0.8"/>`);
}
g.push(T(1.4, 0.02, 'hatchway', 9, 'var(--warm)'));
g.push(T(-1.35, 0.34, 'pump', 9, 'var(--warm)'));

// 5 peak
g.push(T(6.72, 0.42, 'sail room,', 9.5, 'var(--ink2)'));
g.push(T(6.72, 0.0, 'bosun’s store', 9.5, 'var(--ink2)'));

for (const [z, r] of [[-1.9, 0.175], [4.1, 0.166]]) g.push(`<circle cx="${R(zx(z))}" cy="${R(bx(0))}" r="${R(r * S)}" fill="var(--ink3)"/>`);
g.push(T(-1.9, 0.34, 'mast', 8.5, 'var(--ink3)'));
g.push(T(4.1, 0.36, 'mast', 8.5, 'var(--ink3)'));
for (const win of di.STERN_WINDOWS) g.push(`<line x1="${R(zx(TRANSOM + 0.06))}" y1="${R(bx(win.x - win.halfWidth))}" x2="${R(zx(TRANSOM + 0.06))}" y2="${R(bx(win.x + win.halfWidth))}" stroke="var(--warm)" stroke-width="4"/>`);
// The doorways, where they actually are. Both after ones dog-leg round a mast:
// the mainmast at -1.9 leaves 0.5 m to the -2.4 bulkhead where a body needs
// 0.73 m, so the passage keeps to starboard there and to port forward.
for (const [z, x] of [[CAB_BHD, 0], [AFT_BHD, -DOOR], [FWD_BHD, DOOR]]) {
  g.push(`<line x1="${R(zx(z))}" y1="${R(bx(x - DOORW))}" x2="${R(zx(z))}" y2="${R(bx(x + DOORW))}" stroke="var(--paper)" stroke-width="4"/>`);
  const sweep = x >= 0 ? 1 : 0;
  const b1 = x + (x >= 0 ? DOORW * 2 : -DOORW * 2);
  g.push(`<path d="M${R(zx(z))} ${R(bx(x - (x >= 0 ? -DOORW : DOORW)))} A ${R(0.7 * S)} ${R(0.7 * S)} 0 0 ${sweep} ${R(zx(z + 0.7))} ${R(bx(b1))}" fill="none" stroke="var(--warm)" stroke-width="1.1" stroke-dasharray="3 3"/>`);
  g.push(`<line x1="${R(zx(z))}" y1="${R(bx(b1))}" x2="${R(zx(z + 0.7))}" y2="${R(bx(b1))}" stroke="var(--warm)" stroke-width="2.4"/>`);
}
const area = (n) => di.spaceSoleArea(di.belowDecksSpace(n)).toFixed(1);
const titles = [
  [-6.1, 2.2, "1  captain's cabin", `${area('cabin')} m²`],
  [-3.4, 2.2, '2  pantry, ladder, spirit locker', `${area('landing')} m²`],
  [0.3, 2.62, '3  wardroom', `${area('wardroom')} m², 1.84–2.06 m head`],
  [4.5, -2.62, '4  forecastle — galley, four berths', `${area('forecastle')} m²`],
];
for (const [z, b, t, sub] of titles) {
  g.push(`<text x="${R(zx(z))}" y="${R(bx(b))}" font-size="12.5" fill="var(--ink)" text-anchor="middle">${t}</text>`);
  g.push(`<text x="${R(zx(z))}" y="${R(bx(b)) + 15}" font-size="11" fill="var(--ink2)" text-anchor="middle">${sub}</text>`);
}
g.push(`<text x="${R(zx(6.9))}" y="${R(bx(1.15))}" font-size="12.5" fill="var(--ink)" text-anchor="middle">5  peak</text>`);
g.push(`<text x="${R(zx(-7.1))}" y="${R(bx(-1.6))}" font-size="10.5" fill="var(--warm)" text-anchor="middle">four stern windows</text>`);

// ------------------------------------------------------------- side view
g.push(`<text x="48" y="424" font-size="13" fill="var(--ink2)">Side view — and what is under each floor</text>`);
const hull = [
  ...zs.map((z) => [zx(z), py(hf.deckAtSideY(z) + hf.deckLevelRise(z))]),
  ...zs.slice().reverse().map((z) => [zx(z), py(hf.floorYAt(z))]),
];
g.push(`<path d="${poly(hull)}Z" fill="var(--panel)" stroke="var(--rule2)" stroke-width="1.2"/>`);
g.push(`<path d="${poly(zs.map((z) => [zx(z), py(underBeam(z))]))}" fill="none" stroke="var(--rule2)" stroke-width="1" stroke-dasharray="4 3"/>`);
for (let t = 0; t < 3; t++) {
  const yc = 0.6 + t * 0.48;
  for (let z = AFT_BHD + 0.35 + (t % 2 ? 0.25 : 0); z <= FWD_BHD - 0.35; z += 0.52) {
    g.push(`<circle cx="${R(zx(z))}" cy="${R(py(yc))}" r="${R(0.235 * S)}" fill="none" stroke="var(--cask)" stroke-width="1"/>`);
  }
}
g.push(`<path d="${poly([[zx(-2.3), py(0.17)], [zx(2.5), py(0.17)], [zx(2.5), py(0.34)], [zx(-2.3), py(0.34)]])}Z" fill="var(--ink3)" opacity="0.55"/>`);
g.push(`<line x1="${R(zx(-HL))}" y1="${R(py(2.3))}" x2="${R(zx(HL))}" y2="${R(py(2.3))}" stroke="var(--warm)" stroke-width="1.2" stroke-dasharray="7 4"/>`);
g.push(`<text x="${R(zx(HL)) + 6}" y="${R(py(2.3)) + 4}" font-size="11" fill="var(--warm)">waterline</text>`);
for (const [z0, z1, sole] of [[TRANSOM, AFT_BHD, AFT_SOLE], [AFT_BHD, FWD_BHD, MID_SOLE], [FWD_BHD, PEAK_BHD, FWD_SOLE]]) {
  g.push(`<line x1="${R(zx(z0))}" y1="${R(py(sole))}" x2="${R(zx(z1))}" y2="${R(py(sole))}" stroke="var(--ink)" stroke-width="3"/>`);
}

// The furniture in elevation, from the same solids the plan reads. This is the
// only view that can show a thing the plan cannot: the forecastle's berths are
// in two tiers, and the galley's flue runs to the beams.
for (const piece of fittings) {
  if (piece.kind === 'hatchwayBoards' || piece.kind === 'foreScuttleSoffit') continue;
  for (const sd of piece.solids) {
    let zLo, zHi, yLo, yHi;
    if (sd.kind === 'box') {
      const yaw = sd.yaw ?? 0;
      const reach = Math.abs(sd.half.z * Math.cos(yaw)) + Math.abs(sd.half.x * Math.sin(yaw));
      zLo = sd.centre.z - reach; zHi = sd.centre.z + reach;
      yLo = sd.centre.y - sd.half.y; yHi = sd.centre.y + sd.half.y;
    } else {
      const r = Math.max(sd.radiusA, sd.radiusB);
      zLo = Math.min(sd.a.z, sd.b.z) - r; zHi = Math.max(sd.a.z, sd.b.z) + r;
      yLo = Math.min(sd.a.y, sd.b.y); yHi = Math.max(sd.a.y, sd.b.y);
    }
    // Massing solid, trim faint: a side view of every drawer front is a blur.
    g.push(`<rect x="${R(zx(zLo))}" y="${R(py(yHi))}" width="${Math.max(1, R((zHi - zLo) * S))}" height="${Math.max(1, R((yHi - yLo) * S))}" fill="var(--warm)" opacity="${sd.collides ? 0.24 : 0.08}"/>`);
  }
}
for (const [z, yHi, yLo, n, dir] of [[AFT_BHD, AFT_SOLE, MID_SOLE, 2, 1], [FWD_BHD, FWD_SOLE, MID_SOLE, 1, -1]]) {
  for (let i = 1; i <= n; i++) {
    const y = yHi - ((yHi - yLo) * i) / n;
    g.push(`<line x1="${R(zx(z + dir * 0.3 * (i - 1)))}" y1="${R(py(y))}" x2="${R(zx(z + dir * 0.3 * i))}" y2="${R(py(y))}" stroke="var(--ink)" stroke-width="2"/>`);
  }
}
for (const z of [CAB_BHD, AFT_BHD, FWD_BHD, PEAK_BHD]) {
  const top = underBeam(z), lo = Math.min(soleAt(z - 0.01), soleAt(z + 0.01));
  const hi = Math.min(lo + 1.9, top - 0.08);
  if (z === PEAK_BHD) g.push(`<line x1="${R(zx(z))}" y1="${R(py(lo))}" x2="${R(zx(z))}" y2="${R(py(top))}" stroke="var(--ink)" stroke-width="1.8"/>`);
  else {
    g.push(`<line x1="${R(zx(z))}" y1="${R(py(hi))}" x2="${R(zx(z))}" y2="${R(py(top))}" stroke="var(--ink)" stroke-width="1.8"/>`);
    g.push(`<line x1="${R(zx(z))}" y1="${R(py(lo))}" x2="${R(zx(z))}" y2="${R(py(hi))}" stroke="var(--warm)" stroke-width="1.6" stroke-dasharray="4 3"/>`);
  }
}
for (const [z, t] of [[-1.9, 'mainmast'], [4.1, 'foremast']]) {
  g.push(`<line x1="${R(zx(z))}" y1="${R(py(hf.floorYAt(z) + 0.26))}" x2="${R(zx(z))}" y2="${R(py(5.1))}" stroke="var(--ink3)" stroke-width="3"/>`);
  g.push(`<text x="${R(zx(z)) + 6}" y="${R(py(5.1)) - 4}" font-size="11" fill="var(--ink3)">${t}</text>`);
}
for (const [z0, z1] of [[hf.COMPANION_AFT_Z, hf.COMPANION_FORWARD_Z], [di.HATCHWAY_AFT_Z, di.HATCHWAY_FORWARD_Z]]) {
  const zm = (z0 + z1) / 2;
  g.push(`<line x1="${R(zx(z0))}" y1="${R(py(hf.deckCrownY(zm) + hf.deckLevelRise(zm)))}" x2="${R(zx(z1))}" y2="${R(py(hf.deckCrownY(zm) + hf.deckLevelRise(zm)))}" stroke="var(--warm)" stroke-width="4"/>`);
}
// The platform's hatchway is directly under the deck's, and the same size.
g.push(`<line x1="${R(zx(di.HATCHWAY_AFT_Z))}" y1="${R(py(MID_SOLE))}" x2="${R(zx(di.HATCHWAY_FORWARD_Z))}" y2="${R(py(MID_SOLE))}" stroke="var(--warm)" stroke-width="4"/>`);
for (const z of [di.HATCHWAY_AFT_Z, di.HATCHWAY_FORWARD_Z]) {
  g.push(`<line x1="${R(zx(z))}" y1="${R(py(MID_SOLE))}" x2="${R(zx(z))}" y2="${R(py(hf.deckCrownY(1.4)))}" stroke="var(--warm)" stroke-width="0.9" stroke-dasharray="4 4"/>`);
}
g.push(`<text x="${R(zx(1.4))}" y="${R(py(2.05))}" font-size="10" fill="var(--warm)" text-anchor="middle">one shaft, deck to hold</text>`);
// what's under each floor
g.push(`<line x1="${R(zx(TRANSOM + 0.3))}" y1="${R(py(AFT_SOLE))}" x2="${R(zx(-2.5))}" y2="${R(py(AFT_SOLE))}" stroke="var(--ink)" stroke-width="1"/>`);
const under = [
  [-5.2, 1.72, 'bread room and lazarette', 10.5],
  [0.1, 1.15, 'water · salt provisions · iron ballast', 10.5],
  [4.5, 1.42, 'cable tier', 10.5],
];
for (const [z, y, t, s] of under) g.push(`<text x="${R(zx(z))}" y="${R(py(y))}" font-size="${s}" fill="var(--ink2)" text-anchor="middle">${t}</text>`);
const floors = [
  [-6.0, 3.3, '2.45 floor'],
  [-3.4, 3.3, '2.45 floor'],
  [0.1, 2.6, '1.80 floor — the platform'],
  [4.4, 2.95, '2.05 floor'],
];
for (const [z, y, t] of floors) g.push(`<text x="${R(zx(z))}" y="${R(py(y))}" font-size="11" fill="var(--ink2)" text-anchor="middle">${t}</text>`);
g.push(`<line x1="${R(zx(-HL))}" y1="734" x2="${R(zx(HL))}" y2="734" stroke="var(--rule)" stroke-width="1"/>`);
for (let z = -6; z <= 6; z += 2) {
  g.push(`<line x1="${R(zx(z))}" y1="730" x2="${R(zx(z))}" y2="738" stroke="var(--rule2)" stroke-width="1"/>`);
  g.push(`<text x="${R(zx(z))}" y="752" font-size="11" fill="var(--ink3)" text-anchor="middle">${z > 0 ? '+' : ''}${z}</text>`);
}
g.push(`<text x="${R(zx(HL)) + 8}" y="752" font-size="11" fill="var(--ink3)">m</text>`);
g.push(`</svg>`);
writeFileSync('docs/ship/below-decks-arrangement.svg', g.join('\n'));
await server.close();
console.log('wrote docs/ship/below-decks-arrangement.svg');
