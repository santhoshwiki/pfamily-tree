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
        _partner: null,
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
        if (peopleById[r.person1] && peopleById[r.person2]) {
          peopleById[r.person1]._partner = r.person2;
          peopleById[r.person2]._partner = r.person1;
          // anchor = whichever partner descends from someone in the dataset
          const p1HasParents =
            (peopleById[r.person1].father && peopleById[peopleById[r.person1].father]) ||
            (peopleById[r.person1].mother && peopleById[peopleById[r.person1].mother]);
          const p2HasParents =
            (peopleById[r.person2].father && peopleById[peopleById[r.person2].father]) ||
            (peopleById[r.person2].mother && peopleById[peopleById[r.person2].mother]);
          let anchor = r.person1;
          if (p2HasParents && !p1HasParents) anchor = r.person2;
          coupleAnchorOf[r.person1] = anchor;
          coupleAnchorOf[r.person2] = anchor;
        }
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
  }

  // ---------- Roots ----------
  function findRoots(data) {
    const roots = [];
    data.people.forEach((p) => {
      const node = peopleById[p.id];
      const hasParents =
        (p.father && peopleById[p.father]) || (p.mother && peopleById[p.mother]);
      if (hasParents) return;
      if (node._partner) {
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
    const partnerId = p._partner;
    const unitW = partnerId ? CARD_W * 2 + COUPLE_GAP : CARD_W;
    const children = p._childrenArr;
    const y = PAD + gen * (CARD_H + ROW_GAP);

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
      const partnerId = node._partner;

      // Only draw outgoing lines from the anchor of a couple (avoids duplicates).
      if (partnerId && coupleAnchorOf[p.id] !== p.id) return;

      const yMid = pos.y + CARD_H / 2;
      const yBottom = pos.y + CARD_H;

      // 1) Couple line — anchor card right edge to partner card left edge.
      if (partnerId) {
        const ppos = positions[partnerId];
        segments.push(`M ${pos.x + CARD_W} ${yMid} L ${ppos.x} ${yMid}`);
      }

      const children = node._childrenArr;
      if (!children || children.length === 0) return;

      // 2) Descent emerges from the bloodline anchor's bottom-centre.
      const parentDropX = pos.x + CARD_W / 2;
      const parentDropY = yBottom;
      const busY = pos.y + CARD_H + ROW_GAP / 2;

      // Each child connects at its own bloodline anchor card top-centre.
      const childPoints = children.map((cId) => {
        const cPos = positions[cId];
        return { x: cPos.x + CARD_W / 2, y: cPos.y };
      });

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
    });

    if (segments.length === 0) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", segments.join(" "));
    svgEl.appendChild(path);
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
    const partnerId = peopleById[p.id]._partner;
    const partner = partnerId ? peopleById[partnerId] : null;
    const father = p.father ? peopleById[p.father] : null;
    const mother = p.mother ? peopleById[p.mother] : null;

    // Children of this person are stored on the anchor; if this person is the partner, look up the anchor.
    const anchorId = coupleAnchorOf[p.id] || p.id;
    const childrenIds = (peopleById[anchorId]._childrenArr || []).filter((c) => {
      // If person is the anchor: all listed children are theirs.
      // If person is the partner: same children apply (shared with anchor).
      return true;
    });

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

    if (partner) {
      detailBodyEl.appendChild(sectionTitle("Partner"));
      const ul = document.createElement("ul");
      ul.appendChild(personLink(partner, partner.gender === "female" ? "Wife" : "Husband"));
      detailBodyEl.appendChild(ul);
    }

    if (childrenIds.length) {
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
