// Headless layout check.
//
// Loads family.json, runs the same build() + layoutRel() pipeline that app.js
// uses in the browser, and prints the resulting (x, y) for every person so we
// can confirm where each card actually ends up — especially the two wives of
// a multi-partner anchor.
//
// Usage: node scripts/layout-check.js

const fs = require("fs");
const path = require("path");

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "family.json"), "utf8")
);

const CARD_W = 220;
const CARD_H = 76;
const COUPLE_GAP = 28;
const SIBLING_GAP = 36;
const FAMILY_GAP = 120;
const ROW_GAP = 88;
const PAD = 80;

const peopleById = {};
const coupleAnchorOf = {};
let maxGen = 0;
const positions = {};

// ---- build() ---------------------------------------------------------------
data.people.forEach((p) => {
  peopleById[p.id] = Object.assign({}, p, {
    _children: new Set(),
    _partners: [],
    _childrenByPartner: {},
  });
});
data.people.forEach((p) => {
  if (p.father && peopleById[p.father]) peopleById[p.father]._children.add(p.id);
  if (p.mother && peopleById[p.mother]) peopleById[p.mother]._children.add(p.id);
});
(data.relationships || [])
  .filter((r) => r.type === "partner")
  .forEach((r) => {
    if (!peopleById[r.person1] || !peopleById[r.person2]) return;
    const a = peopleById[r.person1];
    const b = peopleById[r.person2];
    if (a._partners.indexOf(r.person2) === -1) a._partners.push(r.person2);
    if (b._partners.indexOf(r.person1) === -1) b._partners.push(r.person1);
    const p1HasParents =
      (a.father && peopleById[a.father]) || (a.mother && peopleById[a.mother]);
    const p2HasParents =
      (b.father && peopleById[b.father]) || (b.mother && peopleById[b.mother]);
    let anchor = r.person1;
    if (p2HasParents && !p1HasParents) anchor = r.person2;
    if (coupleAnchorOf[r.person1]) anchor = coupleAnchorOf[r.person1];
    else if (coupleAnchorOf[r.person2]) anchor = coupleAnchorOf[r.person2];
    coupleAnchorOf[r.person1] = anchor;
    coupleAnchorOf[r.person2] = anchor;
  });
Object.keys(coupleAnchorOf).forEach((pid) => {
  const anchorId = coupleAnchorOf[pid];
  if (pid === anchorId) return;
  const partner = peopleById[pid];
  const anchor = peopleById[anchorId];
  partner._children.forEach((c) => anchor._children.add(c));
  partner._children = new Set();
});
Object.values(peopleById).forEach((p) => {
  p._childrenArr = Array.from(p._children).sort((a, b) => {
    const ay = peopleById[a].birthYear || 0;
    const by = peopleById[b].birthYear || 0;
    return ay - by;
  });
});
Object.values(peopleById).forEach((p) => {
  if (p._partners.length === 0) return;
  p._partners.forEach((pid) => {
    p._childrenByPartner[pid] = [];
  });
  const orphans = [];
  p._childrenArr.forEach((cid) => {
    const c = peopleById[cid];
    let match = null;
    for (let i = 0; i < p._partners.length; i++) {
      const partnerId = p._partners[i];
      if (c.father === partnerId || c.mother === partnerId) {
        match = partnerId;
        break;
      }
    }
    if (match) p._childrenByPartner[match].push(cid);
    else orphans.push(cid);
  });
  if (orphans.length) {
    const firstPartner = p._partners[0];
    p._childrenByPartner[firstPartner] = p._childrenByPartner[firstPartner].concat(orphans);
  }
});

// ---- findRoots() ----------------------------------------------------------
function findRoots() {
  const roots = [];
  data.people.forEach((p) => {
    const node = peopleById[p.id];
    const hasParents =
      (p.father && peopleById[p.father]) || (p.mother && peopleById[p.mother]);
    if (hasParents) return;
    if (node._partners && node._partners.length > 0) {
      if (coupleAnchorOf[p.id] === p.id) roots.push(p.id);
    } else {
      roots.push(p.id);
    }
  });
  return roots;
}

// ---- layoutRel() / layoutMultiPartner() -----------------------------------
function layoutRel(personId, gen) {
  if (gen > maxGen) maxGen = gen;
  const p = peopleById[personId];
  const partners = p._partners || [];
  const y = PAD + gen * (CARD_H + ROW_GAP);

  if (partners.length >= 2) return layoutMultiPartner(personId, partners, gen, y);

  const partnerId = partners[0] || null;
  const unitW = partnerId ? CARD_W * 2 + COUPLE_GAP : CARD_W;
  const children = p._childrenArr;

  if (children.length === 0) {
    const places = {};
    places[personId] = { relX: 0, y, gen };
    if (partnerId) places[partnerId] = { relX: CARD_W + COUPLE_GAP, y, gen };
    return { width: unitW, connectX: CARD_W / 2, places };
  }

  let cursor = 0;
  const childResults = [];
  children.forEach((cId, i) => {
    const r = layoutRel(cId, gen + 1);
    childResults.push({ id: cId, result: r, offset: cursor });
    cursor += r.width + (i < children.length - 1 ? SIBLING_GAP : 0);
  });
  const childrenSpan = cursor;

  const childAbsConnects = childResults.map((cr) => cr.result.connectX + cr.offset);
  const firstC = childAbsConnects[0];
  const lastC = childAbsConnects[childAbsConnects.length - 1];
  const childrenCenter = (firstC + lastC) / 2;

  let anchorRelLeft = childrenCenter - CARD_W / 2;
  let shift = 0;
  if (anchorRelLeft < 0) {
    shift = -anchorRelLeft;
    anchorRelLeft = 0;
  }

  const places = {};
  places[personId] = { relX: anchorRelLeft, y, gen };
  if (partnerId) places[partnerId] = { relX: anchorRelLeft + CARD_W + COUPLE_GAP, y, gen };
  childResults.forEach((cr) => {
    const cPlaces = cr.result.places;
    Object.keys(cPlaces).forEach((id) => {
      places[id] = {
        relX: cPlaces[id].relX + cr.offset + shift,
        y: cPlaces[id].y,
        gen: cPlaces[id].gen,
      };
    });
  });
  const unitRight = anchorRelLeft + unitW;
  const width = Math.max(unitRight, childrenSpan + shift);
  const connectX = anchorRelLeft + CARD_W / 2;
  return { width, connectX, places };
}

function layoutMultiPartner(personId, partners, gen, y) {
  const p = peopleById[personId];
  const N = partners.length;
  const leftCount = Math.floor(N / 2);

  const slots = [];
  for (let i = 0; i < leftCount; i++) slots.push(partners[i]);
  slots.push(null);
  for (let i = leftCount; i < N; i++) slots.push(partners[i]);

  const groupOf = {};
  partners.forEach((partnerId) => {
    const kids = (p._childrenByPartner && p._childrenByPartner[partnerId]) || [];
    const childResults = [];
    let cursor = 0;
    kids.forEach((cId, i) => {
      const r = layoutRel(cId, gen + 1);
      childResults.push({ id: cId, result: r, offset: cursor });
      cursor += r.width + (i < kids.length - 1 ? SIBLING_GAP : 0);
    });
    let firstConnect = CARD_W / 2;
    let lastConnect = CARD_W / 2;
    if (childResults.length > 0) {
      const absConnects = childResults.map((cr) => cr.result.connectX + cr.offset);
      firstConnect = absConnects[0];
      lastConnect = absConnects[absConnects.length - 1];
    }
    groupOf[partnerId] = {
      childResults, span: cursor,
      connectX: (firstConnect + lastConnect) / 2,
      firstConnect, lastConnect,
    };
  });

  const clusterWidth = (N + 1) * CARD_W + N * COUPLE_GAP;
  const step = CARD_W + COUPLE_GAP;

  const partnerSlotCentre = {};
  const partnerSlotIdx = {};
  slots.forEach((slot, i) => {
    if (slot !== null) {
      partnerSlotCentre[slot] = i * step + CARD_W / 2;
      partnerSlotIdx[slot] = i;
    }
  });

  const groupOffsetMap = {};
  let lastRight = -Infinity;
  let childrenMin = Infinity;
  let childrenMax = -Infinity;
  slots.forEach((slot) => {
    if (slot === null) return;
    const g = groupOf[slot];
    if (g.span === 0) return;
    const desired = partnerSlotCentre[slot] - g.connectX;
    const minStart = lastRight === -Infinity ? -Infinity : lastRight + SIBLING_GAP;
    const offset = Math.max(desired, minStart);
    groupOffsetMap[slot] = offset;
    lastRight = offset + g.span;
    childrenMin = Math.min(childrenMin, offset);
    childrenMax = Math.max(childrenMax, offset + g.span);
  });

  let deltaLo = -Infinity;
  let deltaHi = Infinity;
  partners.forEach((partnerId) => {
    const g = groupOf[partnerId];
    if (g.span === 0) return;
    const slotIdx = partnerSlotIdx[partnerId];
    const goff = groupOffsetMap[partnerId];
    const lo = goff + g.firstConnect - slotIdx * step - CARD_W / 2;
    const hi = goff + g.lastConnect - slotIdx * step - CARD_W / 2;
    deltaLo = Math.max(deltaLo, lo);
    deltaHi = Math.min(deltaHi, hi);
  });
  let clusterStart;
  if (deltaLo === -Infinity || deltaHi === Infinity) clusterStart = 0;
  else clusterStart = (deltaLo + deltaHi) / 2;

  let minRelX = clusterStart;
  if (childrenMin !== Infinity) minRelX = Math.min(minRelX, childrenMin);
  const shift = minRelX < 0 ? -minRelX : 0;
  if (shift > 0) {
    clusterStart += shift;
    Object.keys(groupOffsetMap).forEach((pid) => (groupOffsetMap[pid] += shift));
    if (childrenMax !== -Infinity) childrenMax += shift;
  }
  const totalWidth = Math.max(
    clusterStart + clusterWidth,
    childrenMax === -Infinity ? 0 : childrenMax
  );

  const places = {};
  slots.forEach((slot, i) => {
    const x = clusterStart + i * step;
    if (slot === null) places[personId] = { relX: x, y, gen };
    else places[slot] = { relX: x, y, gen };
  });
  partners.forEach((partnerId) => {
    const g = groupOf[partnerId];
    if (g.span === 0) return;
    const off = groupOffsetMap[partnerId];
    g.childResults.forEach((cr) => {
      const cPlaces = cr.result.places;
      Object.keys(cPlaces).forEach((id) => {
        places[id] = {
          relX: cPlaces[id].relX + cr.offset + off,
          y: cPlaces[id].y,
          gen: cPlaces[id].gen,
        };
      });
    });
  });

  const connectX = places[personId].relX + CARD_W / 2;
  return { width: totalWidth, connectX, places };
}

const roots = findRoots();
let xCursor = PAD;
roots.forEach((rootId, idx) => {
  const sub = layoutRel(rootId, 0);
  Object.keys(sub.places).forEach((id) => {
    const info = sub.places[id];
    positions[id] = { x: info.relX + xCursor, y: info.y, gen: info.gen };
  });
  xCursor += sub.width + (idx < roots.length - 1 ? FAMILY_GAP : 0);
});

function show(id) {
  const pos = positions[id];
  const name = (peopleById[id] && peopleById[id].name) || "??";
  if (!pos) {
    console.log(`  MISSING from positions: ${id} (${name})`);
    return;
  }
  console.log(
    `  ${id.padEnd(28)} ${name.padEnd(40)} x=${String(Math.round(pos.x)).padStart(6)}  y=${String(Math.round(pos.y)).padStart(4)}  gen=${pos.gen}`
  );
}

console.log("=== karuppagoundar family ===");
["karuppagoundar-wife1", "karuppagoundar", "karuppagoundar-wife2"].forEach(show);
console.log("\nchildren of wife1:");
(peopleById["karuppagoundar"]._childrenByPartner["karuppagoundar-wife1"] || []).forEach(show);
console.log("\nchildren of wife2:");
(peopleById["karuppagoundar"]._childrenByPartner["karuppagoundar-wife2"] || []).forEach(show);

console.log("\n=== subramani family ===");
["subramani-wife1", "subramani", "subramani-wife2"].forEach(show);
console.log("\nchildren of subramani-wife1:");
(peopleById["subramani"]._childrenByPartner["subramani-wife1"] || []).forEach(show);
console.log("\nchildren of subramani-wife2:");
(peopleById["subramani"]._childrenByPartner["subramani-wife2"] || []).forEach(show);

console.log("\n=== total canvas extent ===");
const allX = Object.values(positions).map((p) => p.x);
console.log("min x =", Math.min(...allX), " max x =", Math.max(...allX) + CARD_W);
