#!/usr/bin/env node
/**
 * Generate a synthetic family-tree dataset for stress-testing the renderer.
 *
 * Produces ../family-large.json with:
 *   - 10 generations
 *   - Widest row (G9) = 30 cards (15 anchors + 15 partners)
 *   - Bilingual Tamil/English names
 *   - Patrilineal anchors (males carry the line, married-in females have no
 *     parents in the data) — same shape as the existing family.json.
 *
 * Run from anywhere:  node scripts/generate-large.js
 */

const fs = require("fs");
const path = require("path");

// --- Name pools (Tamil + English transliteration) -------------------------
const M_TA = [
  "கருப்பன்", "வேலு", "முருகன்", "கிருஷ்ணன்", "சுப்ரமணி", "முத்து",
  "செல்வம்", "செந்தில்", "அருண்", "குமார்", "ராஜ்", "பாலா", "விஜய்",
  "ரவி", "சுரேஷ்", "மகேஷ்", "கார்த்திக்", "பிரகாஷ்", "வசந்த்", "ஆனந்த்",
  "ஹரி", "ரமேஷ்", "மோகன்", "சங்கர்", "நவீன்", "தினேஷ்", "சிவம்",
  "கணேசன்", "பெரியசாமி", "ராமசாமி", "அர்ஜுன்", "வினோத்", "சக்தி",
  "தீபக்", "மணிகண்டன்", "சரவணன்", "பாஸ்கரன்", "ஜெயராமன்", "சிவாஜி",
  "வாசுதேவன்", "அகிலன்", "தாமரை", "ஆதிநாத்", "பாலசுப்ரமணி",
  "தங்கவேல்", "கோபால்", "ஆறுமுகம்", "சுதர்சன்", "ஈஸ்வரன்", "பழனிசாமி",
];
const M_EN = [
  "Karuppan", "Velu", "Murugan", "Krishnan", "Subramani", "Muthu",
  "Selvam", "Senthil", "Arun", "Kumar", "Raj", "Bala", "Vijay",
  "Ravi", "Suresh", "Mahesh", "Karthik", "Prakash", "Vasanth", "Anand",
  "Hari", "Ramesh", "Mohan", "Shankar", "Naveen", "Dinesh", "Sivam",
  "Ganesan", "Periyasamy", "Ramasamy", "Arjun", "Vinoth", "Sakthi",
  "Deepak", "Manikandan", "Saravanan", "Bhaskaran", "Jayaraman", "Sivaji",
  "Vasudevan", "Akhilan", "Thamarai", "Adhinath", "Balasubramani",
  "Thangavel", "Gopal", "Arumugam", "Sudarshan", "Eswaran", "Palanisamy",
];

const F_TA = [
  "லட்சுமி", "சரஸ்வதி", "பார்வதி", "மீனாட்சி", "தேவி", "மாலா",
  "கீதா", "ராதா", "சீதா", "கமலா", "விமலா", "சாந்தி", "லதா",
  "இந்திரா", "பத்மா", "உஷா", "அனிதா", "செல்வி", "ரஞ்சிதா", "பிரியா",
  "திவ்யா", "கவிதா", "சங்கீதா", "மது", "புவனா", "கல்பனா", "மாயா",
  "நிலா", "தமிழ்", "ஜானகி", "அஞ்சலி", "தேன்மொழி", "ரேவதி",
  "கீர்த்தனா", "நிர்மலா", "வேதா", "சரண்யா", "பழனியம்மாள்",
  "ராஜேஸ்வரி", "சங்கரி", "கௌசல்யா", "தேவகி", "அபிராமி",
  "வள்ளியம்மாள்", "சுந்தரி", "நாகம்மாள்", "கனகம்", "ஐஸ்வர்யா",
  "ஹரிணி", "சுபாஷினி",
];
const F_EN = [
  "Lakshmi", "Saraswathi", "Parvathi", "Meenakshi", "Devi", "Mala",
  "Geetha", "Radha", "Sita", "Kamala", "Vimala", "Shanthi", "Latha",
  "Indira", "Padma", "Usha", "Anitha", "Selvi", "Ranjitha", "Priya",
  "Divya", "Kavitha", "Sangeetha", "Madhu", "Bhuvana", "Kalpana", "Maya",
  "Nila", "Tamil", "Janaki", "Anjali", "Thenmozhi", "Revathi",
  "Keerthana", "Nirmala", "Vedha", "Saranya", "Palaniammal",
  "Rajeshwari", "Sankari", "Kausalya", "Devaki", "Abirami",
  "Valliammal", "Sundari", "Nagammal", "Kanagam", "Aishwarya",
  "Harini", "Subhashini",
];

const PLACES = [
  "Thalathurai", "Pattakaranur", "Sulur", "Coimbatore", "Erode",
  "Karur", "Salem", "Madurai", "Trichy", "Tirupur", "Pollachi",
  "Avinashi", "Mettupalayam", "Annur", "Sathyamangalam", "Kovilpalayam",
  "Palladam", "Udumalpet", "Kangeyam", "Dharapuram",
];

const PHOTO_M =
  "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=240&q=80";
const PHOTO_F =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=240&q=80";

const BIO_HINTS = [
  "Farmer who tended ancestral land in {place}.",
  "Known for hosting the village harvest festival.",
  "Spent most of life in {place}; loved telling old stories.",
  "Took the family business to neighbouring towns.",
  "Quiet temperament, devoted to family.",
  "Moved to {place} after marriage.",
  "Spoke fondly of relatives across the river.",
  "Carried on the family trade through difficult years.",
  "Pioneered formal education in the family.",
  "Best remembered for cooking on village holidays.",
];

// --- Generation shape ------------------------------------------------------
// Number of bloodline anchors (carriers) per generation.
// 1, 2, 3, 4, 5, 7, 9, 12, 15, 16
// → widest row at G9 = 15 anchors + 15 partners = 30 cards.
const TARGETS = [1, 2, 3, 4, 5, 7, 9, 12, 15, 16];

// --- Generator -------------------------------------------------------------
const people = [];
const relationships = [];

let mIdx = 0;
let fIdx = 0;
let placeIdx = 0;
let bioIdx = 0;

// Deterministic pseudo-random so the file is stable across runs.
let seed = 1;
function rand() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

function nextName(gender) {
  if (gender === "male") {
    const ta = M_TA[mIdx % M_TA.length];
    const en = M_EN[mIdx % M_EN.length];
    mIdx++;
    return { ta, en };
  }
  const ta = F_TA[fIdx % F_TA.length];
  const en = F_EN[fIdx % F_EN.length];
  fIdx++;
  return { ta, en };
}

function makeId(en, gen) {
  const slug = en.toLowerCase().replace(/[^a-z]+/g, "");
  return `${slug}-g${gen}-${people.length + 1}`;
}

function birthYearFor(gen) {
  // G1 = 1820, +20 per generation, plus a small deterministic jitter.
  const base = 1820 + (gen - 1) * 20;
  return base + Math.floor(rand() * 6);
}

function makePerson(gender, gen, parents) {
  const n = nextName(gender);
  const place = PLACES[placeIdx++ % PLACES.length];
  const id = makeId(n.en, gen);
  const birthYear = birthYearFor(gen);
  const p = {
    id,
    name: `${n.ta} (${n.en})`,
    gender,
    birthYear,
    place,
    photo: gender === "male" ? PHOTO_M : PHOTO_F,
  };
  // Mark older generations as deceased (lived ~70-85 years).
  if (birthYear + 85 < 2026) {
    p.deathYear = birthYear + 65 + Math.floor(rand() * 20);
  }
  // A few bios sprinkled in early generations to populate the detail panel.
  if (gen <= 4 && bioIdx < 12) {
    p.bio = BIO_HINTS[bioIdx % BIO_HINTS.length].replace("{place}", place);
    bioIdx++;
  }
  if (parents && parents.father) p.father = parents.father;
  if (parents && parents.mother) p.mother = parents.mother;
  people.push(p);
  return p;
}

function distributeKids(prevCount, target) {
  // Each previous parent gets at least one child; remainder spread round-robin.
  const arr = new Array(prevCount).fill(1);
  let extra = target - prevCount;
  let i = 0;
  while (extra > 0) {
    arr[i % prevCount]++;
    extra--;
    i++;
  }
  return arr;
}

// G1: root couple
const root = makePerson("male", 1);
const rootPartner = makePerson("female", 1);
relationships.push({ type: "partner", person1: root.id, person2: rootPartner.id });
let level = [{ anchor: root, partner: rootPartner }];

for (let gen = 2; gen <= 10; gen++) {
  const target = TARGETS[gen - 1];
  const kidsPerParent = distributeKids(level.length, target);
  const next = [];

  level.forEach((parentCouple, i) => {
    const numKids = kidsPerParent[i];
    for (let j = 0; j < numKids; j++) {
      // First-born of each couple is the bloodline-carrying son (matches the
      // patrilineal convention used in family.json). Extra kids alternate.
      const childGender = j === 0 ? "male" : j % 2 === 1 ? "female" : "male";
      const child = makePerson(childGender, gen, {
        father: parentCouple.anchor.id,
        mother: parentCouple.partner.id,
      });

      if (gen < 10) {
        // Pair every G2..G9 carrier with a married-in partner.
        const partnerGender = childGender === "male" ? "female" : "male";
        const partner = makePerson(partnerGender, gen);
        relationships.push({
          type: "partner",
          person1: child.id,
          person2: partner.id,
        });
        next.push({ anchor: child, partner });
      } else {
        // G10 = leaf children, no partners.
        next.push({ anchor: child, partner: null });
      }
    }
  });

  level = next;
}

const out = { people, relationships };
const outPath = path.resolve(__dirname, "..", "family-large.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

const cardsByGen = {};
people.forEach((p) => {
  // approximate gen by id suffix
  const m = p.id.match(/-g(\d+)-/);
  if (m) {
    const g = +m[1];
    cardsByGen[g] = (cardsByGen[g] || 0) + 1;
  }
});
console.log("Wrote", outPath);
console.log("People       :", people.length);
console.log("Relationships:", relationships.length);
console.log("Cards / gen  :");
Object.keys(cardsByGen)
  .sort((a, b) => +a - +b)
  .forEach((g) => console.log("  G" + g + ":", cardsByGen[g]));
