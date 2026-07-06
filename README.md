# OnDemand HQ — Digital Twin (Vercel-ready)

A self-contained, **zero-build** static site: an interactive WebGL walkthrough of the OnDemand HQ
digital twin (the 18,067-object "MAX" build, ~17k procedural props) plus a render gallery of the
frames path-traced on the H100 node.

No framework, no `npm install`, no build step. Just static files + the model. Deploys to Vercel
(or any static host) as-is.

## Contents
```
ondemand-hq-vercel/
├── index.html                 walkthrough (three.js via CDN; WASD + teleport + optional H100 render)
├── gallery.html               render gallery (montage, all-zones sheet, flythrough, hero still)
├── config.js                  ← set your H100 render endpoint here (optional)
├── vercel.json                content-type + caching for the .glb and gallery
├── rooms.json                 16 zone spawn points
├── models/ondemand-hq.glb     the enriched model (28 MB, 18,067 objects)
└── gallery/                   blast_montage.mp4, sheet_zones.png, sheet_building.png,
                               flythrough.mp4, render_exterior_hero.png
```

## Deploy to Vercel

**CLI**
```bash
npm i -g vercel        # once
cd ondemand-hq-vercel
vercel                 # preview deploy  → follow prompts
vercel --prod          # production
```
When Vercel asks about a framework, choose **Other** — there is no build command and no output
directory to set; it serves these files directly.

**Dashboard / git**: push this folder to a git repo and "Import Project" at vercel.com/new, or drag
the folder onto vercel.com/new. Framework preset: **Other**.

## Run it locally (optional)
Any static server works — no Node required:
```bash
cd ondemand-hq-vercel
python3 -m http.server 5050      # then open http://localhost:5050
```

## The "Photoreal render (H100)" button
`index.html` reads `config.js`. If `renderEndpoint` is set, a green button appears that POSTs your
current camera to `<renderEndpoint>/api/render` and shows the GPU-path-traced result (CORS is open on
the H100 server).

> The default value is the H100 node's **Cloudflare quick-tunnel URL, which is EPHEMERAL** — it changes
> every time the tunnel restarts. To refresh it: on the node run `bash /root/ohq/deploy/launch.sh`,
> then copy the value from `/root/ohq/PUBLIC_URL.txt` into `config.js`. Leave `renderEndpoint: ""` to
> hide the button entirely — the walkthrough works fully without it (all rendering is client-side WebGL).

## Notes
- **`models/ondemand-hq.glb` is optimized: 1.6 MB, Draco-compressed.** The full 18,067-object MAX build
  was merged by material into one mesh (~247 draw calls instead of 18k) and Draco-compressed (28 MB → 1.6 MB),
  so it loads fast and stays smooth in the browser with no loss of detail. The Draco decoder is loaded
  automatically from the three.js CDN (`examples/jsm/libs/draco/`) — no extra files to host.
- Room info-card thumbnails are loaded from external URLs (Cloudinary) referenced in `rooms.json`.
- Everything else is served from this folder — no external backend required for the walkthrough itself.
