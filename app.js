/* eslint-disable */
/**
 * Family tree renderer.
 *
 * Loads data from family.json (people + relationships), builds a tree,
 * lays it out so each parent is centered above its children, draws
 * orthogonal "elbow" connectors via SVG, and supports pan/zoom, search,
 * and a per-person detail panel.
 *
 * Pure HTML/CSS/JS — no build step, deployable on GitHub Pages.
 */

(function () {
  "use strict";

  // ---------- Layout constants ----------
  const CARD_W = 220;
  const CARD_H = 76;
  const COUPLE_GAP = 28; // visual gap between two partner cards
  const SIBLING_GAP = 36; // gap between sibling subtrees
  const FAMILY_GAP = 120; // gap between disconnected family trees
  const ROW_GAP = 88; // vertical gap between generations
  const PAD = 80; // outer padding around the whole canvas

  // ---------- DOM ----------
  const cardsEl = document.getElementById("cards");
  const svgEl = document.getElementById("connectors");
  const canvasEl = document.getElementById("canvas");
  const viewportEl = document.getElementById("viewport");
  const searchEl = document.getElementById("search");
  const detailEl = document.getElementById("detail");
  const detailBodyEl = document.getElementById("detail-body");
  const detailCloseEl = document.getElementById("detail-close");
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const legendEl = document.getElementById("legend");

  let peopleById = {};
  let coupleAnchorOf = {}; // personId -> anchor personId (the bloodline parent of a couple)
  let positions = {}; // personId -> { x, y, gen }
  let canvasW = 0;
  let canvasH = 0;
  let maxGen = 0;

  // ---------- Boot ----------
  // Pick which data file to load. Defaults to family.json. You can swap to a
  // different dataset (e.g. the 10-generation stress test) without editing
  // any code by adding a query param:
  //   http://localhost:8000/?data=family-large.json
  // The value can be any path relative to index.html, or a short alias.
  const DATA_ALIASES = {
    large: "./family-large.json",
    sample: "./family.json",
    default: "./family.json",
  };
  function resolveDataUrl() {
    const params = new URLSearchParams(location.search);
    const raw = (params.get("data") || "").trim();
    if (!raw) return DATA_ALIASES.default;
    if (DATA_ALIASES[raw]) return DATA_ALIASES[raw];
    // Allow plain filenames too — prefix "./" if the caller didn't.
    if (/^https?:\/\//i.test(raw) || raw.startsWith("/")) return raw;
    return raw.startsWith("./") ? raw : "./" + raw;
  }
  const DATA_URL = resolveDataUrl();

  fetch(DATA_URL, { cache: "no-cache" })
    .then((r) => {
      if (!r.ok) throw new Error("Failed to load " + DATA_URL + " (" + r.status + ")");
      return r.json();
    })
    .then((data) => {
      build(data);
      render(data);
      loadingEl.remove();
      panZoom.init();
      buildLegend();
      // Reflect the loaded file in the header subtitle so it's obvious which
      // dataset is currently displayed.
      const sub = document.getElementById("subtitle");
      if (sub) {
        const name = DATA_URL.split("/").pop();
        sub.textContent = "குடும்ப மரம் · " + name + " · " + data.people.length + " people";
      }
    })
    .catch((err) => {
      console.error(err);
      loadingEl.remove();
      errorEl.hidden = false;
      errorEl.textContent =
        "Could not load " +
        DATA_URL +
        ". If you're opening index.html directly with file://, run a local server: `python3 -m http.server` and open http://localhost:8000.";
    });

  // ---------- Build family graph ----------
  function build(data) {
    peopleById = {};
    coupleAnchorOf = {};

    data.people.forEach((p) => {
      peopleById[p.id] = Object.assign({}, p, {
        _children: new Set(),
        // A person may have several partners over time (e.g. a man with two
        // wives). Keep them in order of appearance in `relationships`.
        _partners: [],
        // For an anchor with multiple partners we also bucket children by
        // which partner is the OTHER parent, so each marriage can be drawn
        // with its own children group.
        _childrenByPartner: {},
      });
    });

    // children (each child appears under both parents while building; we'll dedupe to anchor below)
    data.people.forEach((p) => {
      if (p.father && peopleById[p.father]) peopleById[p.father]._children.add(p.id);
      if (p.mother && peopleById[p.mother]) peopleById[p.mother]._children.add(p.id);
    });

    // partners
    (data.relationships || [])
      .filter((r) => r.type === "partner")
      .forEach((r) => {
        if (!peopleById[r.person1] || !peopleById[r.person2]) return;
        const a = peopleById[r.person1];
        const b = peopleById[r.person2];
        if (a._partners.indexOf(r.person2) === -1) a._partners.push(r.person2);
        if (b._partners.indexOf(r.person1) === -1) b._partners.push(r.person1);
        // anchor = whichever partner descends from someone in the dataset
        const p1HasParents =
          (a.father && peopleById[a.father]) || (a.mother && peopleById[a.mother]);
        const p2HasParents =
          (b.father && peopleById[b.father]) || (b.mother && peopleById[b.mother]);
        let anchor = r.person1;
        if (p2HasParents && !p1HasParents) anchor = r.person2;
        // If we've already locked an anchor for either side from an earlier
        // marriage, keep it so all of a person's marriages share one anchor.
        if (coupleAnchorOf[r.person1]) anchor = coupleAnchorOf[r.person1];
        else if (coupleAnchorOf[r.person2]) anchor = coupleAnchorOf[r.person2];
        coupleAnchorOf[r.person1] = anchor;
        coupleAnchorOf[r.person2] = anchor;
      });

    // Move children of non-anchor partners onto the anchor so each couple's
    // children list lives in one place.
    Object.keys(coupleAnchorOf).forEach((pid) => {
      const anchorId = coupleAnchorOf[pid];
      if (pid === anchorId) return;
      const partner = peopleById[pid];
      const anchor = peopleById[anchorId];
      partner._children.forEach((c) => anchor._children.add(c));
      partner._children = new Set();
    });

    // Sort children by birth year (oldest first) for stable, intuitive layout.
    Object.values(peopleById).forEach((p) => {
      p._childrenArr = Array.from(p._children).sort((a, b) => {
        const ay = peopleById[a].birthYear || 0;
        const by = peopleById[b].birthYear || 0;
        return ay - by;
      });
    });

    // Bucket children by the partner who is the OTHER parent, so anchors
    // with multiple partners can lay out each marriage's children below the
    // correct partner. Children whose other parent isn't recorded fall back
    // to the first partner so they still show up somewhere sensible.
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
  }

  // ---------- Roots ----------
  function findRoots(data) {
    const roots = [];
    data.people.forEach((p) => {
      const node = peopleById[p.id];
      const hasParents =
        (p.father && peopleById[p.father]) || (p.mother && peopleById[p.mother]);
      if (hasParents) return;
      if (node._partners && node._partners.length > 0) {
        // only the anchor of a root couple represents the family
        if (coupleAnchorOf[p.id] === p.id) roots.push(p.id);
      } else {
        roots.push(p.id);
      }
    });
    return roots;
  }

  // ---------- Recursive layout ----------
  // Returns { width, connectX, places } where:
  //   width    = horizontal extent of this subtree
  //   connectX = x (within this subtree) of the bloodline anchor's card centre.
  //              This is where a parent's descent line should land — landing on
  //              the actual child card (NOT on the couple-line gap), so it's
  //              always unambiguous which person is the bloodline descendant.
  //   places   = map of personId -> { relX, y, gen } relative to subtree's left edge.
  //
  // Each anchor card is positioned directly above the centre between its
  // first- and last-child anchor cards. The partner (if any) sits to the right
  // of the anchor. The result is a clean vertical "spine" of bloodline cards
  // with married-in partners on the right.
  function layoutRel(personId, gen) {
    if (gen > maxGen) maxGen = gen;
    const p = peopleById[personId];
    const partners = p._partners || [];
    const y = PAD + gen * (CARD_H + ROW_GAP);

    // Multi-partner anchors (e.g. a man with two wives) get their own
    // arrangement: the anchor sits in the middle and each partner's children
    // are laid out below that partner's card.
    if (partners.length >= 2) {
      return layoutMultiPartner(personId, partners, gen, y);
    }

    // 0 or 1 partner — original layout: anchor on the left, partner (if any)
    // on the right, all children centred below the anchor.
    const partnerId = partners[0] || null;
    const unitW = partnerId ? CARD_W * 2 + COUPLE_GAP : CARD_W;
    const children = p._childrenArr;

    if (children.length === 0) {
      const places = {};
      places[personId] = { relX: 0, y: y, gen: gen };
      if (partnerId) {
        places[partnerId] = { relX: CARD_W + COUPLE_GAP, y: y, gen: gen };
      }
      // Anchor card centre — the descent target for this subtree.
      return { width: unitW, connectX: CARD_W / 2, places: places };
    }

    // Lay out children left-to-right.
    let cursor = 0;
    const childResults = [];
    children.forEach((cId, i) => {
      const r = layoutRel(cId, gen + 1);
      childResults.push({ id: cId, result: r, offset: cursor });
      cursor += r.width + (i < children.length - 1 ? SIBLING_GAP : 0);
    });
    const childrenSpan = cursor;

    // X of each child's bloodline anchor centre (within this subtree's frame).
    const childAbsConnects = childResults.map((cr) => cr.result.connectX + cr.offset);
    const firstC = childAbsConnects[0];
    const lastC = childAbsConnects[childAbsConnects.length - 1];
    const childrenCenter = (firstC + lastC) / 2;

    // Place the bloodline anchor's card centre directly above childrenCenter.
    // Partner (if any) extends to the right.
    let anchorRelLeft = childrenCenter - CARD_W / 2;

    // If anchor extends left of 0, shift the children's subtree right so all
    // relative coords stay non-negative.
    let shift = 0;
    if (anchorRelLeft < 0) {
      shift = -anchorRelLeft;
      anchorRelLeft = 0;
    }

    const places = {};
    places[personId] = { relX: anchorRelLeft, y: y, gen: gen };
    if (partnerId) {
      places[partnerId] = { relX: anchorRelLeft + CARD_W + COUPLE_GAP, y: y, gen: gen };
    }
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
    return { width: width, connectX: connectX, places: places };
  }

  // Multi-partner layout.
  //
  // Cards are arranged horizontally as
  //
  //   [partner_0] … [partner_{L-1}] [ANCHOR] [partner_L] … [partner_{N-1}]
  //
  // where L = floor(N/2). For N=2 this is the natural [wife1][husband][wife2].
  // All cards stay adjacent (one COUPLE_GAP between neighbours) so the
  // anchor and every partner are visible together — "this man has two
  // wives" reads instantly, no matter how many descendants each marriage
  // has.
  //
  // Each partner's children form their own subtree and the subtrees are
  // laid out left-to-right below the card cluster (in the same order as
  // the partner cards above). The cluster is then centred horizontally
  // over the combined children flow so the whole arrangement looks
  // balanced. Connectors (`drawConnectors`) draw a separate descent line
  // from each partner down to that partner's children — that's what tells
  // you which children belong to which wife.
  function layoutMultiPartner(personId, partners, gen, y) {
    const p = peopleById[personId];
    const N = partners.length;
    const leftCount = Math.floor(N / 2);

    // slots: card order at this row. null = anchor slot.
    const slots = [];
    for (let i = 0; i < leftCount; i++) slots.push(partners[i]);
    slots.push(null);
    for (let i = leftCount; i < N; i++) slots.push(partners[i]);

    // Lay out each partner's children subtree (recursive). We also remember
    // each group's own connectX (where its bus midpoint sits inside the
    // group's frame), so we can later line that midpoint up under the
    // partner's card centre when possible.
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
        childResults: childResults,
        span: cursor,
        connectX: (firstConnect + lastConnect) / 2,
        firstConnect: firstConnect,
        lastConnect: lastConnect,
      };
    });

    // Cluster is the N+1 cards packed tight with COUPLE_GAP between each.
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

    // PASS 1 — assign each children-group its preferred offset (so the
    // group's bus midpoint sits below the partner's card centre), but never
    // letting two adjacent groups overlap (min SIBLING_GAP between).
    const groupOffset = {};
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
      groupOffset[slot] = offset;
      lastRight = offset + g.span;
      childrenMin = Math.min(childrenMin, offset);
      childrenMax = Math.max(childrenMax, offset + g.span);
    });

    // PASS 2 — choose a clusterStart so each partner's drop point lands
    // inside her own children's connect range [firstConnect, lastConnect].
    // For partner i:
    //   partner.drop = clusterStart + slotIdx_i*step + CARD_W/2
    // and we want:
    //   groupOffset_i + firstConnect_i <= partner.drop <= groupOffset_i + lastConnect_i
    // Re-arranging gives a [lo_i, hi_i] range for clusterStart per partner;
    // the intersection of those ranges (or the midpoint if infeasible) is
    // our final cluster position.
    let deltaLo = -Infinity;
    let deltaHi = Infinity;
    partners.forEach((partnerId) => {
      const g = groupOf[partnerId];
      if (g.span === 0) return;
      const slotIdx = partnerSlotIdx[partnerId];
      const goff = groupOffset[partnerId];
      const lo = goff + g.firstConnect - slotIdx * step - CARD_W / 2;
      const hi = goff + g.lastConnect - slotIdx * step - CARD_W / 2;
      deltaLo = Math.max(deltaLo, lo);
      deltaHi = Math.min(deltaHi, hi);
    });

    let clusterStart;
    if (deltaLo === -Infinity || deltaHi === Infinity) {
      clusterStart = 0;
    } else {
      // Both feasible and infeasible cases: midpoint of [lo, hi] is the
      // best compromise. When deltaLo > deltaHi the range is empty but the
      // midpoint still minimises max error.
      clusterStart = (deltaLo + deltaHi) / 2;
    }

    // Shift everything so the leftmost edge is at x=0.
    let minRelX = clusterStart;
    if (childrenMin !== Infinity) minRelX = Math.min(minRelX, childrenMin);
    const shift = minRelX < 0 ? -minRelX : 0;
    if (shift > 0) {
      clusterStart += shift;
      Object.keys(groupOffset).forEach((pid) => (groupOffset[pid] += shift));
      if (childrenMax !== -Infinity) childrenMax += shift;
    }

    const totalWidth = Math.max(
      clusterStart + clusterWidth,
      childrenMax === -Infinity ? 0 : childrenMax
    );

    // Place cards.
    const places = {};
    slots.forEach((slot, i) => {
      const x = clusterStart + i * step;
      if (slot === null) places[personId] = { relX: x, y: y, gen: gen };
      else places[slot] = { relX: x, y: y, gen: gen };
    });

    // Place each partner's children subtree at its computed offset.
    partners.forEach((partnerId) => {
      const g = groupOf[partnerId];
      if (g.span === 0) return;
      const off = groupOffset[partnerId];
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
    return { width: totalWidth, connectX: connectX, places: places };
  }

  // ---------- Render ----------
  function render(data) {
    const roots = findRoots(data);
    if (roots.length === 0) {
      errorEl.hidden = false;
      errorEl.textContent = "No root people found in family.json.";
      return;
    }

    // Place each disconnected family side-by-side.
    let xCursor = PAD;
    roots.forEach((rootId, idx) => {
      const sub = layoutRel(rootId, 0);
      Object.keys(sub.places).forEach((id) => {
        const info = sub.places[id];
        positions[id] = { x: info.relX + xCursor, y: info.y, gen: info.gen };
      });
      xCursor += sub.width + (idx < roots.length - 1 ? FAMILY_GAP : 0);
    });

    canvasW = xCursor + PAD;
    canvasH = PAD + (maxGen + 1) * (CARD_H + ROW_GAP) - ROW_GAP + PAD;

    canvasEl.style.width = canvasW + "px";
    canvasEl.style.height = canvasH + "px";
    svgEl.setAttribute("width", canvasW);
    svgEl.setAttribute("height", canvasH);
    svgEl.setAttribute("viewBox", "0 0 " + canvasW + " " + canvasH);

    drawConnectors(data);
    drawCards(data);
  }

  // ---------- Cards ----------
  function drawCards(data) {
    const frag = document.createDocumentFragment();
    data.people.forEach((p) => {
      const pos = positions[p.id];
      if (!pos) return;
      const el = document.createElement("div");
      el.className = "card gen-" + (pos.gen % 8);
      if (p.deathYear) el.classList.add("deceased");
      el.style.left = pos.x + "px";
      el.style.top = pos.y + "px";
      el.dataset.id = p.id;
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");

      const names = parseName(p.name);
      const photo = makePhotoEl(p, names.en || names.ta);

      const info = document.createElement("div");
      info.className = "info";
      const nameEl = document.createElement("div");
      nameEl.className = "name";
      nameEl.textContent = names.ta || names.en || "—";
      const enEl = document.createElement("div");
      enEl.className = "name-en";
      enEl.textContent = names.en || "";
      const metaEl = document.createElement("div");
      metaEl.className = "meta";
      metaEl.textContent = formatYears(p) + (p.place ? " · " + p.place : "");

      info.appendChild(nameEl);
      if (names.en) info.appendChild(enEl);
      info.appendChild(metaEl);

      el.appendChild(photo);
      el.appendChild(info);

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        showDetail(p.id);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          showDetail(p.id);
        }
      });

      frag.appendChild(el);
    });
    cardsEl.appendChild(frag);
  }

  function makePhotoEl(person, fallbackName) {
    const wrap = document.createElement("div");
    wrap.className = "photo";
    const fallback = initials(fallbackName);
    if (person.photo) {
      const img = document.createElement("img");
      img.alt = fallbackName || "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = person.photo;
      img.addEventListener("error", () => {
        wrap.removeChild(img);
        wrap.textContent = fallback;
      });
      wrap.appendChild(img);
    } else {
      wrap.textContent = fallback;
    }
    return wrap;
  }

  // ---------- SVG connectors (couple line + descent + sibling bus) ----------
  //
  // Two distinct kinds of line are drawn so the relationships are unambiguous:
  //
  //   • Couple line — short horizontal between an anchor card's right edge and
  //     its partner's left edge, at the cards' vertical mid-line. This is the
  //     ONLY line that touches a married-in partner; it clearly says "marriage".
  //
  //   • Descent line — emerges from the BLOODLINE anchor's bottom-centre and
  //     drops to a sibling bus, then up to each child's bloodline anchor card
  //     top-centre. Lineage always lands on the actual child card (never on
  //     the couple-gap of the child), so "whose parents are these" is obvious
  //     even when the child is in their own marriage.
  function drawConnectors(data) {
    const segments = []; // each segment is "M x1 y1 L x2 y2"

    data.people.forEach((p) => {
      const pos = positions[p.id];
      if (!pos) return;
      const node = peopleById[p.id];
      const partners = node._partners || [];

      // Only draw outgoing lines from the anchor of a couple (avoids duplicates).
      if (partners.length > 0 && coupleAnchorOf[p.id] !== p.id) return;

      const yMid = pos.y + CARD_H / 2;

      // 1) Couple lines — one per partner. The anchor may sit on either side
      // of any given partner (e.g. wives flanking a husband), so always draw
      // from the inner edge of the leftmost card to the inner edge of the
      // rightmost card at mid-height.
      partners.forEach((partnerId) => {
        const ppos = positions[partnerId];
        if (!ppos) return;
        if (pos.x < ppos.x) {
          segments.push(`M ${pos.x + CARD_W} ${yMid} L ${ppos.x} ${yMid}`);
        } else {
          segments.push(`M ${ppos.x + CARD_W} ${yMid} L ${pos.x} ${yMid}`);
        }
      });

      // 2) Descent lines.
      //
      // Single-partner / no-partner: descent emerges from the anchor's
      // bottom-centre and feeds the full _childrenArr (unchanged behaviour).
      //
      // Multi-partner: each partner has their own children group, so the
      // descent for each marriage drops from that partner's (the mother's)
      // bottom-centre. This makes "which children belong to which wife"
      // unambiguous.
      if (partners.length >= 2) {
        partners.forEach((partnerId) => {
          const ppos = positions[partnerId];
          if (!ppos) return;
          const kids = (node._childrenByPartner && node._childrenByPartner[partnerId]) || [];
          if (kids.length === 0) return;
          drawDescent(segments, ppos.x + CARD_W / 2, ppos.y + CARD_H, ppos.y, kids);
        });
      } else {
        const children = node._childrenArr;
        if (!children || children.length === 0) return;
        drawDescent(segments, pos.x + CARD_W / 2, pos.y + CARD_H, pos.y, children);
      }
    });

    if (segments.length === 0) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", segments.join(" "));
    svgEl.appendChild(path);
  }

  function drawDescent(segments, parentDropX, parentDropY, parentY, children) {
    const busY = parentY + CARD_H + ROW_GAP / 2;

    const childPoints = children
      .map((cId) => {
        const cPos = positions[cId];
        return cPos ? { x: cPos.x + CARD_W / 2, y: cPos.y } : null;
      })
      .filter(Boolean);
    if (childPoints.length === 0) return;

    // Drop from parent's bottom-centre to the bus.
    segments.push(`M ${parentDropX} ${parentDropY} L ${parentDropX} ${busY}`);

    // Sibling bus spans every drop X plus the parent drop X.
    const allXs = [parentDropX].concat(childPoints.map((cp) => cp.x));
    const minX = Math.min.apply(null, allXs);
    const maxX = Math.max.apply(null, allXs);
    if (maxX - minX > 0.5) {
      segments.push(`M ${minX} ${busY} L ${maxX} ${busY}`);
    }

    // Drop from bus down to each child's anchor card top.
    childPoints.forEach((cp) => {
      segments.push(`M ${cp.x} ${busY} L ${cp.x} ${cp.y}`);
    });
  }

  // ---------- Detail panel ----------
  function showDetail(id) {
    const p = peopleById[id];
    if (!p) return;

    // visual focus
    document.querySelectorAll(".card.focused").forEach((el) => el.classList.remove("focused"));
    const cardEl = cardsEl.querySelector(`.card[data-id="${id}"]`);
    if (cardEl) cardEl.classList.add("focused");

    const names = parseName(p.name);
    const partnerIds = peopleById[p.id]._partners || [];
    const partners = partnerIds.map((pid) => peopleById[pid]).filter(Boolean);
    const father = p.father ? peopleById[p.father] : null;
    const mother = p.mother ? peopleById[p.mother] : null;

    // Children of this person are stored on the anchor; if this person is the partner, look up the anchor.
    const anchorId = coupleAnchorOf[p.id] || p.id;
    const anchorNode = peopleById[anchorId];
    const childrenIds = anchorNode._childrenArr || [];

    detailBodyEl.innerHTML = "";

    if (p.photo) {
      const ph = document.createElement("div");
      ph.className = "photo-lg";
      const img = document.createElement("img");
      img.src = p.photo;
      img.alt = names.en || "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        ph.removeChild(img);
        ph.textContent = initials(names.en || names.ta);
      });
      ph.appendChild(img);
      detailBodyEl.appendChild(ph);
    }

    const h2 = document.createElement("h2");
    h2.textContent = names.ta || names.en || "—";
    detailBodyEl.appendChild(h2);

    if (names.en) {
      const en = document.createElement("div");
      en.className = "name-en-lg";
      en.textContent = names.en;
      detailBodyEl.appendChild(en);
    }

    const meta = document.createElement("div");
    meta.className = "meta-row";
    if (formatYears(p)) meta.appendChild(chip(formatYears(p)));
    if (p.place) meta.appendChild(chip(p.place));
    if (p.gender) meta.appendChild(chip(cap(p.gender)));
    detailBodyEl.appendChild(meta);

    if (p.bio) {
      const bio = document.createElement("p");
      bio.className = "bio";
      bio.textContent = p.bio;
      detailBodyEl.appendChild(bio);
    }

    if (father || mother) {
      detailBodyEl.appendChild(sectionTitle("Parents"));
      const ul = document.createElement("ul");
      if (father) ul.appendChild(personLink(father, "Father"));
      if (mother) ul.appendChild(personLink(mother, "Mother"));
      detailBodyEl.appendChild(ul);
    }

    if (partners.length) {
      detailBodyEl.appendChild(sectionTitle(partners.length > 1 ? "Partners" : "Partner"));
      const ul = document.createElement("ul");
      partners.forEach((partner) => {
        ul.appendChild(personLink(partner, partner.gender === "female" ? "Wife" : "Husband"));
      });
      detailBodyEl.appendChild(ul);
    }

    // When the anchor has more than one partner, group children under each
    // marriage so it's clear which children belong to which wife/husband.
    const anchorPartners = anchorNode._partners || [];
    if (
      anchorPartners.length >= 2 &&
      anchorNode._childrenByPartner &&
      childrenIds.length
    ) {
      anchorPartners.forEach((pid) => {
        const partner = peopleById[pid];
        const groupKids = (anchorNode._childrenByPartner[pid] || []).filter((c) =>
          peopleById[c]
        );
        if (groupKids.length === 0) return;
        const partnerNames = partner ? parseName(partner.name) : { ta: "", en: "" };
        const label = partner
          ? "Children with " + (partnerNames.ta || partnerNames.en || "—")
          : "Children";
        detailBodyEl.appendChild(sectionTitle(label));
        const ul = document.createElement("ul");
        groupKids.forEach((cid) => {
          const c = peopleById[cid];
          ul.appendChild(personLink(c, c.gender === "female" ? "Daughter" : "Son"));
        });
        detailBodyEl.appendChild(ul);
      });
    } else if (childrenIds.length) {
      detailBodyEl.appendChild(sectionTitle("Children"));
      const ul = document.createElement("ul");
      childrenIds.forEach((cid) => {
        const c = peopleById[cid];
        ul.appendChild(personLink(c, c.gender === "female" ? "Daughter" : "Son"));
      });
      detailBodyEl.appendChild(ul);
    }

    detailEl.hidden = false;
  }

  function chip(text) {
    const c = document.createElement("span");
    c.className = "chip";
    c.textContent = text;
    return c;
  }

  function sectionTitle(text) {
    const h = document.createElement("h3");
    h.textContent = text;
    return h;
  }

  function personLink(person, role) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const names = parseName(person.name);
    btn.innerHTML =
      `<span>${escapeHtml(names.ta || names.en)}</span>` +
      (role ? ` <span class="role">· ${role}</span>` : "");
    btn.addEventListener("click", () => {
      showDetail(person.id);
      panZoom.focusOn(person.id);
    });
    li.appendChild(btn);
    return li;
  }

  detailCloseEl.addEventListener("click", () => {
    detailEl.hidden = true;
    document.querySelectorAll(".card.focused").forEach((el) => el.classList.remove("focused"));
  });

  // ---------- Search ----------
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.trim().toLowerCase();
    const cards = cardsEl.querySelectorAll(".card");
    if (!q) {
      cards.forEach((c) => c.classList.remove("dimmed", "matched"));
      return;
    }
    let firstMatch = null;
    cards.forEach((c) => {
      const id = c.dataset.id;
      const p = peopleById[id];
      const hay =
        (p.name || "").toLowerCase() +
        " " +
        (p.place || "").toLowerCase() +
        " " +
        (p.id || "").toLowerCase();
      const matches = hay.indexOf(q) !== -1;
      c.classList.toggle("matched", matches);
      c.classList.toggle("dimmed", !matches);
      if (matches && !firstMatch) firstMatch = id;
    });
    if (firstMatch) panZoom.focusOn(firstMatch);
  });

  // ---------- Pan / Zoom ----------
  const panZoom = (function () {
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let isDown = false;
    let startX = 0;
    let startY = 0;
    let startTx = 0;
    let startTy = 0;
    let pinchDist = 0;
    let pinchScale = 1;

    function apply() {
      canvasEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      const label = document.getElementById("zoom-reset");
      if (label) label.textContent = Math.round(scale * 100) + "%";
    }

    function fit() {
      const vw = viewportEl.clientWidth;
      const vh = viewportEl.clientHeight;
      if (canvasW === 0 || canvasH === 0) return;
      const s = Math.min(vw / canvasW, vh / canvasH) * 0.92;
      scale = Math.max(0.1, Math.min(2, s));
      tx = (vw - canvasW * scale) / 2;
      ty = (vh - canvasH * scale) / 2;
      apply();
    }

    function focusOn(id) {
      const pos = positions[id];
      if (!pos) return;
      const vw = viewportEl.clientWidth;
      const vh = viewportEl.clientHeight;
      // keep current scale; recenter
      tx = vw / 2 - (pos.x + CARD_W / 2) * scale;
      ty = vh / 2 - (pos.y + CARD_H / 2) * scale;
      apply();
    }

    function zoomAt(clientX, clientY, factor) {
      const newScale = Math.max(0.15, Math.min(3, scale * factor));
      const rect = viewportEl.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      tx = cx - (cx - tx) * (newScale / scale);
      ty = cy - (cy - ty) * (newScale / scale);
      scale = newScale;
      apply();
    }

    function init() {
      fit();

      // Mouse pan
      viewportEl.addEventListener("mousedown", (e) => {
        if (e.target.closest(".card")) return;
        isDown = true;
        startX = e.clientX;
        startY = e.clientY;
        startTx = tx;
        startTy = ty;
        viewportEl.classList.add("grabbing");
      });
      window.addEventListener("mousemove", (e) => {
        if (!isDown) return;
        tx = startTx + (e.clientX - startX);
        ty = startTy + (e.clientY - startY);
        apply();
      });
      window.addEventListener("mouseup", () => {
        isDown = false;
        viewportEl.classList.remove("grabbing");
      });

      // Wheel zoom
      viewportEl.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          zoomAt(e.clientX, e.clientY, factor);
        },
        { passive: false }
      );

      // Touch pan + pinch
      viewportEl.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) {
          if (e.target.closest(".card")) return;
          isDown = true;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          startTx = tx;
          startTy = ty;
        } else if (e.touches.length === 2) {
          isDown = false;
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          pinchDist = Math.hypot(dx, dy);
          pinchScale = scale;
        }
      });
      viewportEl.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches.length === 1 && isDown) {
            tx = startTx + (e.touches[0].clientX - startX);
            ty = startTy + (e.touches[0].clientY - startY);
            apply();
          } else if (e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const d = Math.hypot(dx, dy);
            if (pinchDist > 0) {
              const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
              const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
              const factor = (d / pinchDist) * (pinchScale / scale);
              zoomAt(cx, cy, factor);
            }
          }
        },
        { passive: false }
      );
      viewportEl.addEventListener("touchend", () => {
        isDown = false;
        pinchDist = 0;
      });

      // Buttons
      document.getElementById("zoom-in").addEventListener("click", () => {
        const r = viewportEl.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
      });
      document.getElementById("zoom-out").addEventListener("click", () => {
        const r = viewportEl.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
      });
      document.getElementById("zoom-reset").addEventListener("click", () => {
        scale = 1;
        const vw = viewportEl.clientWidth;
        const vh = viewportEl.clientHeight;
        tx = (vw - canvasW * scale) / 2;
        ty = (vh - canvasH * scale) / 2;
        apply();
      });
      document.getElementById("fit").addEventListener("click", fit);

      window.addEventListener("resize", () => {
        // keep scale, but if everything is off-screen, refit gently
      });
    }

    return { init: init, focusOn: focusOn, fit: fit };
  })();

  // ---------- Legend ----------
  function buildLegend() {
    const usedGens = new Set();
    Object.values(positions).forEach((p) => usedGens.add(p.gen));
    const sorted = Array.from(usedGens).sort((a, b) => a - b);
    legendEl.innerHTML = "";
    const label = document.createElement("span");
    label.textContent = "Generations:";
    label.style.color = "var(--muted)";
    legendEl.appendChild(label);
    sorted.forEach((g) => {
      const sw = document.createElement("span");
      sw.className = "swatch";
      const i = document.createElement("i");
      i.style.background = `var(--gen-${g % 8})`;
      sw.appendChild(i);
      const t = document.createElement("span");
      t.textContent = "G" + (g + 1);
      sw.appendChild(t);
      legendEl.appendChild(sw);
    });
  }

  // ---------- Helpers ----------
  function parseName(name) {
    if (!name) return { ta: "", en: "" };
    const m = name.match(/^(.*?)\s*\((.+)\)\s*$/);
    if (m) return { ta: m[1].trim(), en: m[2].trim() };
    // No parens — assume single-language
    return { ta: name, en: "" };
  }

  function initials(name) {
    if (!name) return "?";
    return name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }

  function formatYears(p) {
    if (p.deathYear) return (p.birthYear || "?") + "–" + p.deathYear;
    if (p.birthYear) return "b. " + p.birthYear;
    return "";
  }

  function cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
