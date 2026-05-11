// Smoke test for the multi-partner build logic.
// Runs the family-graph builder against family.json without requiring a
// browser, and asserts that karuppagoundar ends up with both wives and that
// children are bucketed under the correct mother.
//
// Usage: node scripts/smoke-test.js

const fs = require("fs");
const path = require("path");

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "family.json"), "utf8")
);

// --- Mirror of build() from app.js ------------------------------------------
const peopleById = {};
const coupleAnchorOf = {};

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
    p._childrenByPartner[firstPartner] =
      p._childrenByPartner[firstPartner].concat(orphans);
  }
});

// --- Assertions -------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  } else {
    console.log("ok  :", msg);
  }
}

const k = peopleById["karuppagoundar"];
assert(k, "karuppagoundar exists in dataset");
assert(
  Array.isArray(k._partners) && k._partners.length === 2,
  "karuppagoundar has exactly 2 partners (got " + k._partners.length + ")"
);
assert(
  k._partners.indexOf("karuppagoundar-wife1") !== -1 &&
    k._partners.indexOf("karuppagoundar-wife2") !== -1,
  "karuppagoundar partners include both wives"
);

const w1Children = k._childrenByPartner["karuppagoundar-wife1"] || [];
const w2Children = k._childrenByPartner["karuppagoundar-wife2"] || [];

assert(
  w1Children.length === 12,
  "wife1 has 12 children (got " + w1Children.length + ")"
);
assert(
  w2Children.length === 8,
  "wife2 has 8 children (got " + w2Children.length + ")"
);

w1Children.forEach((cid) => {
  const c = peopleById[cid];
  assert(
    c.mother === "karuppagoundar-wife1",
    cid + " is correctly attributed to wife1"
  );
});
w2Children.forEach((cid) => {
  const c = peopleById[cid];
  assert(
    c.mother === "karuppagoundar-wife2",
    cid + " is correctly attributed to wife2"
  );
});

assert(
  coupleAnchorOf["karuppagoundar"] === "karuppagoundar",
  "karuppagoundar is his own couple anchor"
);
assert(
  coupleAnchorOf["karuppagoundar-wife1"] === "karuppagoundar",
  "wife1's couple anchor is karuppagoundar"
);
assert(
  coupleAnchorOf["karuppagoundar-wife2"] === "karuppagoundar",
  "wife2's couple anchor is karuppagoundar"
);

// Regression: a single-partner anchor (e.g. nanjappa-goundar-1 + poochiyammal)
// should still expose a single-element _partners array and unchanged children.
const n1 = peopleById["nanjappa-goundar-1"];
assert(
  n1._partners.length === 1 && n1._partners[0] === "poochiyammal",
  "single-partner case still works for nanjappa-goundar-1"
);
assert(
  n1._childrenArr.length >= 3,
  "nanjappa-goundar-1 still has all his children"
);

console.log("\nAll smoke checks passed.");
