# Family Tree · குடும்ப மரம்

An interactive, multi-generation family tree rendered from `family.json`.
Pure HTML / CSS / JavaScript — no build step, no server, no dependencies.
Drop it on GitHub Pages and you're done.

## Features

- **10+ generations** — recursive bottom-up layout that places each parent
  centred above the connect-span of its children.
- **Multiple disconnected families** — each family tree is laid out
  independently and placed side-by-side.
- **Couples & lineage** — partner cards sit next to the bloodline parent
  and share a horizontal couple line; descent connectors are drawn as
  orthogonal "elbows" matching `design.png`.
- **Pan & zoom** — drag to pan, scroll/pinch to zoom, plus zoom buttons
  and a "Fit" button so the whole tree fits the screen.
- **Search** — type a name (Tamil or English) or a place; matching cards
  are highlighted and the view re-centres on the first match.
- **Detail panel** — click any card to open parents, partner, children,
  bio, place and years, with quick navigation between people.
- **Bilingual labels** — Tamil + English names rendered side-by-side
  (Noto Sans Tamil + Inter).

## Data format

`family.json`:

```json
{
  "people": [
    {
      "id": "santhoshkumar",
      "name": "சந்தோஷ்குமார் (Santhoshkumar)",
      "gender": "male",
      "birthYear": 1990,
      "place": "Thalathurai",
      "photo": "https://…",
      "bio": "Family storyteller and gardener.",
      "father": "…optional id…",
      "mother": "…optional id…"
    }
  ],
  "relationships": [
    { "type": "partner", "person1": "santhoshkumar", "person2": "mythili" }
  ]
}
```

Notes:

- `name` may be `"Tamil (English)"` or just one language.
- `father` / `mother` reference another person's `id`; missing or unknown
  parents are fine — those people simply become roots.
- `partner` relationships connect spouses (married-in partners need only
  appear in `people` and in a `relationships` entry).

## Running locally

Modern browsers block `fetch("./family.json")` over `file://`, so use any
static server:

```bash
# Python 3
python3 -m http.server 8000

# Node (no install)
npx --yes http-server -p 8000

# Or VS Code's "Live Server" extension
```

Then open <http://localhost:8000>.

## Deploying to GitHub Pages (free)

1. Create a new GitHub repository and push these files to `main`.
2. **Settings → Pages**.
3. **Build and deployment → Source**: `Deploy from a branch`.
4. **Branch**: `main`, folder `/ (root)`. Save.
5. Wait ~30 seconds. Your site is live at
   `https://<user>.github.io/<repo>/`.

The `.nojekyll` file in this folder disables Jekyll processing so files
are served as-is.

### Custom domain (optional)

Add a `CNAME` file containing your domain, configure DNS as documented
[here](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site).

## Editing the tree

Just edit `family.json`. Every change is picked up on reload — no build,
no rebuild, no migration. Add new generations by giving each new person
a unique `id` and pointing `father` / `mother` at existing IDs.

## Switching datasets

The page loads `family.json` by default. To load another dataset, append
`?data=…` to the URL:

```
http://localhost:8000/                            # family.json (default)
http://localhost:8000/?data=large                 # family-large.json (alias)
http://localhost:8000/?data=family-large.json     # explicit filename
http://localhost:8000/?data=./trees/cousins.json  # any relative path
```

The currently-loaded file and its person count are shown in the header
subtitle.

### Bundled stress dataset

`family-large.json` is a generated dataset with **10 generations** and
**30 cards in the widest row** (G9 = 15 anchors + 15 partners, 132 people
total). It exercises both depth and breadth of the layout. Re-generate
it any time with:

```bash
node scripts/generate-large.js
```

The script is deterministic, so the file is stable across runs.

## File map

```
ft/
├── index.html              # Page shell + header + detail panel
├── styles.css              # Card / connector / panel styles
├── app.js                  # Tree builder, layout, SVG connectors, pan/zoom, search
├── family.json             # Your data (default dataset)
├── family-large.json       # Generated 10-gen / 30-wide stress dataset
├── scripts/
│   └── generate-large.js   # Deterministic generator for family-large.json
├── design.png              # Reference design
├── requirements.md         # Project requirements
├── README.md               # This file
└── .nojekyll               # Tells GitHub Pages: serve files literally
```

## Layout, briefly

For each subtree:

1. Lay out children left-to-right (recursively).
2. Compute each child's `connectX` — the X where its incoming descent
   line should land (the couple-midline if the child is in a couple,
   otherwise the card centre).
3. Place the parent unit (anchor + partner) centred on the midpoint
   between the first and last child's `connectX`. This keeps descent
   lines straight whenever possible.
4. If the parent extends past the subtree's left edge, shift the
   children right so all relative coordinates stay non-negative.

The whole tree is then drawn into one absolutely-positioned `.canvas`
that is translated/scaled by the pan-zoom layer. Connector lines are a
single `<svg>` `<path>` containing all couple lines, descent drops and
sibling buses.
