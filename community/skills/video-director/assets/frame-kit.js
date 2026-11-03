/* Video Director frame kit.
 * Helpers for drawing storyboard frames as HTML that headless Chrome renders to PNG.
 * A frames file defines BRAND and FRAMES, loads this script, then calls renderFrame().
 *
 * URL hash:  #<frameId>                  one frame, with reviewer notes
 *            #<frameId>&clean            same frame without notes (use for final stills)
 *            #<frameId>&variant=<name>   frame drawn with a named variant (for example a color treatment)
 *            #__list                     prints every frame id (used by render_frames.py --all)
 */
(function () {
  "use strict";
  const K = {};
  let uid = 0;
  const next = (p) => `${p}${uid++}`;

  const params = (() => {
    const raw = (location.hash || "").replace(/^#/, "").split("&");
    const out = { id: decodeURIComponent(raw[0] || ""), clean: false, variant: "" };
    for (const part of raw.slice(1)) {
      const [k, v] = part.split("=");
      if (k === "clean") out.clean = true;
      else if (k) out[k] = decodeURIComponent(v || "");
    }
    return out;
  })();
  K.params = params;

  /* BRAND and FRAMES are declared by the frames file with const, so read them by name, not from window. */
  const brand = () => (typeof BRAND !== "undefined" ? BRAND : window.BRAND) || {};
  const frames = () => (typeof FRAMES !== "undefined" ? FRAMES : window.FRAMES) || {};
  const size = () => brand().size || [1920, 1080];
  K.W = () => size()[0];
  K.H = () => size()[1];
  K.vertical = () => K.H() / K.W() >= 1.6; // 9:16; 4:5 and 1:1 use the landscape safe box

  /* The safe box for the format, as fractions of the frame. Lines must sit inside it; nothing may sit below its
     bottom edge. 16:9 and square: 5% title-safe, bottom 17% kept clear. 9:16: 15% top, 35% bottom, 6% left, 12% right
     (platform buttons and captions). Override with BRAND.safe = {top, bottom, left, right} or BRAND.clearBottom. */
  K.safe = () => {
    const b = brand();
    if (b.safe) return Object.assign({ top: 0.05, bottom: 0.17, left: 0.05, right: 0.05 }, b.safe);
    if (K.vertical()) return { top: 0.15, bottom: 0.35, left: 0.06, right: 0.12 };
    return { top: 0.05, bottom: b.clearBottom ?? 0.17, left: 0.05, right: 0.05 };
  };

  /* ---------- grounds ---------- */
  /* BRAND.grounds = { main: "#c8103e", dark: "#14141a" }. Flat brand colors by default; a gradient only
     when the brand itself uses one. Never blur brand colors together into mesh or aura gradients.
     Edge darkening is off unless asked for: GROUND(name, { vignette: true }). */
  K.GROUND = (name, opts = {}) => {
    const g = (brand().grounds || {})[name] || name;
    const vignette = opts.vignette !== true ? "" :
      `<div class="bgl" style="position:absolute;inset:0;background:radial-gradient(${Math.round(K.W() * 0.73)}px ${Math.round(K.H() * 0.83)}px at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,.18) 100%)"></div>`;
    return `<div class="bgl" style="position:absolute;inset:0;background:${g}"></div>${vignette}`;
  };

  /* A curved edge where one ground sweeps over another (for a color change that is itself the transformation).
     progress 0..1 is how far the second ground has travelled from the right. */
  K.SWEEP = (from, to, progress) => {
    const x = Math.round(K.W() * (1 - progress)), H = K.H(), W = K.W();
    const edge = `M${x + 260} 0 C ${x - 140} ${H * 0.3}, ${x + 360} ${H * 0.7}, ${x - 60} ${H} L ${W + 400} ${H} L ${W + 400} 0 Z`;
    return `${K.GROUND(from)}<div class="bgl" style="position:absolute;inset:0;background:${(brand().grounds || {})[to] || to};clip-path:path('${edge}')"></div>`;
  };

  /* ---------- depth ---------- */
  /* A 3D space. Everything inside can sit at a different depth with SLAB(..., z, ...).
     rx tilts the floor away from the camera; keep tilts under about 12-22 degrees so text stays readable. */
  K.STAGE = (rx, rz, inner, opts = {}) => {
    const persp = opts.perspective || 2400, origin = opts.origin || "50% 35%", oy = opts.oy || "45%";
    return `<div class="stage3d" style="position:absolute;inset:0;perspective:${persp}px;perspective-origin:${origin}">
<div style="position:absolute;inset:0;transform-style:preserve-3d;transform:rotateX(${rx}deg) rotateZ(${rz}deg);transform-origin:50% ${oy}">${inner}</div></div>`;
  };

  /* A slab with real thickness (stacked edge shadows) at depth z. Use for product surfaces, documents, tiles. */
  K.SLAB = (x, y, z, w, inner, extra = "") =>
    `<div class="slab k" style="left:${x}px;top:${y}px;width:${w}px;transform:translateZ(${z}px);${extra}">${inner}</div>`;

  /* Depth of field for things far from the camera. level 1 or 2. */
  K.far = (level = 1) => level >= 2 ? "filter:blur(10px);opacity:.6" : "filter:blur(5px);opacity:.82";

  /* ---------- people and photos ---------- */
  K.PHOTO = (src, x, y, w, h, opts = {}) =>
    `<div class="photo k" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background-image:url('${src}');background-position:${opts.pos || "center"};border-radius:${opts.radius ?? 28}px;${opts.extra || ""}"></div>`;

  /* A round face. Use one wherever a person is named on screen. */
  K.FACE = (src, size = 64, ring = 0) =>
    `<span class="face k" style="width:${size}px;height:${size}px;background-image:url('${src}');${ring ? `box-shadow:0 0 0 ${ring}px #fff` : ""}"></span>`;

  /* A solid glass chip: a face or icon, a title and a short line. Keep it nearly opaque so it reads. */
  K.CHIP = (x, y, lead, title, sub = "", opts = {}) =>
    `<div class="chip k" style="left:${x}px;top:${y}px;transform:scale(${opts.scale || 1}) rotate(${opts.rot || 0}deg);transform-origin:left top;${opts.extra || ""}">${lead || ""}<div><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div></div>`;

  /* ---------- the brand mark as a frame for other things ---------- */
  /* BRAND.mark = { viewBox: [400, 220], mask: '<circle cx=".." cy=".." r=".." fill="white"/>...' }
     The mask is drawn white-on-black: white is inside the shape.
     SHAPE_MOSAIC fills the shape with a grid of photo tiles. Use it only where the mark frames or forms something
     (for example the people of a company assembling into its shape). Never as decoration.
     opts.photos   list of image paths, used in order
     opts.ghost    true draws only a faint outline of the shape (show the shape before the tiles fill it)
     opts.keep     function(row, col) -> bool, which tiles are filled (for in-between frames)
     opts.single   one image filling the whole shape
     opts.cols / opts.rows  grid size (default 7 x 4) */
  K.SHAPE_MOSAIC = (x, y, w, opts = {}) => {
    const mark = brand().mark || { viewBox: [400, 220], mask: '<rect x="0" y="0" width="400" height="220" rx="40" fill="white"/>' };
    const [vw, vh] = mark.viewBox, k = next("mo"), cols = opts.cols || 7, rows = opts.rows || 4;
    const cw = vw / cols, ch = vh / rows, gap = Math.min(cw, ch) * 0.03;
    let body = "";
    if (opts.single) {
      body = `<image href="${opts.single}" x="0" y="0" width="${vw}" height="${vh}" preserveAspectRatio="xMidYMid slice"/>`;
    } else if (!opts.ghost) {
      const photos = opts.photos || [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (opts.keep && !opts.keep(r, c)) continue;
        if (!photos.length) continue;
        const p = photos[(r * cols + c) % photos.length];
        body += `<image href="${p}" x="${c * cw + gap}" y="${r * ch + gap}" width="${cw - 2 * gap}" height="${ch - 2 * gap}" preserveAspectRatio="xMidYMid slice"/>`;
      }
    }
    const ghost = opts.ghost || opts.showGhost ? `<rect x="0" y="0" width="${vw}" height="${vh}" fill="rgba(255,255,255,${opts.ghostOpacity ?? 0.13})"/>` : "";
    return `<svg class="mosaic k" style="position:absolute;left:${x}px;top:${y}px;overflow:visible;filter:drop-shadow(0 40px 60px rgba(0,0,0,.3))" width="${w}" height="${w * vh / vw}" viewBox="0 0 ${vw} ${vh}">
<defs><mask id="${k}" maskUnits="userSpaceOnUse" x="0" y="0" width="${vw}" height="${vh}"><rect x="0" y="0" width="${vw}" height="${vh}" fill="black"/>${mark.mask}</mask></defs>
<g mask="url(#${k})">${ghost}${body}</g></svg>`;
  };

  /* ---------- on-screen lines ---------- */
  /* One home position for the film's lines; the video type sets which.
     "top": centered near the top (about 9% down in 16:9, 20% in 9:16), the visual below it with clear space.
     "mid": centered at about 47% down, over the picture (brand films).
     "center": dead center, for moments with nothing else on screen (a claim card, a held beat, the end card).
     "side": a deliberate exception (say why in the storyboard). Wrap a word in <b> to give it weight, never color. */
  K.CAPTION = (text, opts = {}) => {
    const mode = opts.mode || (brand().caption && brand().caption.mode) || "top";
    const cfg = Object.assign({ top: K.vertical() ? 0.2 : 0.093, size: 58, weight: K.vertical() ? 680 : 520 }, brand().caption || {}, opts);
    // size is given in pixels for a 1920x1080 frame; scale it to this format's height share
    // (16:9 about 5.4% of the height, 9:16 about 4%, square and 4:5 about 4.5%).
    const share = K.vertical() ? 0.04 : (K.W() / K.H() >= 1.6 ? 0.054 : 0.045);
    const fs = Math.round((cfg.size / 1080) * (share / 0.054) * K.H());
    if (mode === "side") {
      return `<div class="cap" data-mode="side" data-text-role="opening" style="left:${opts.x ?? 1100}px;top:${opts.y ?? 380}px;width:${opts.w ?? 700}px;text-align:left;font-size:${fs}px;font-weight:${cfg.weight}">${text}</div>`;
    }
    const top = mode === "center" ? Math.round(K.H() / 2 - fs / 2) : mode === "mid" ? Math.round(K.H() * 0.47 - fs / 2) : Math.round(K.H() * cfg.top);
    const sf = K.safe(), left = Math.round(K.W() * Math.max(0.08, sf.left)), right = Math.round(K.W() * Math.max(0.08, sf.right));
    return `<div class="cap" data-mode="${mode}" data-text-role="${opts.role || (mode === "center" ? "card" : "line")}" style="left:${left}px;width:${K.W() - left - right}px;top:${top}px;text-align:center;font-size:${fs}px;font-weight:${cfg.weight}">${text}</div>`;
  };

  /* A 1-3 word label beside the thing it names (explainers, demos, data). Labels are not checked as overlapping lines. */
  K.LABEL = (text, x, y, opts = {}) =>
    `<div class="label txt" data-text-role="label" style="position:absolute;left:${x}px;top:${y}px;font-size:${Math.round((opts.size || 0.04) * K.H())}px;font-weight:${opts.weight || 600};color:${opts.color || "#fff"};white-space:nowrap">${text}</div>`;

  /* Where the visual area starts when lines sit at the top. Put the main visual below this y. */
  K.VISUAL_TOP = () => Math.round(K.H() * (K.vertical() ? 0.32 : 0.27));

  /* ---------- interaction ---------- */
  K.CURSOR = (x, y) => `<svg class="k" style="position:absolute;left:${x}px;top:${y}px;filter:drop-shadow(0 4px 8px rgba(0,0,0,.3))" width="46" height="60" viewBox="0 0 23 30"><path d="M2 2 L2 24 L8 18.5 L12 27 L15.5 25.5 L11.5 17 L19.5 17 Z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

  /* A logo image (a real tool's official mark) on a tile. */
  K.LOGO = (src, size = 40) => `<img src="${src}" alt="" style="width:${size}px;height:${size}px;object-fit:contain;flex:none">`;

  /* ---------- reviewer notes ---------- */
  /* A dashed note for the reviewer. Notes are removed with &clean. Keep them short: what moves, not what it means. */
  K.NOTE = (text, pos = "right:60px;top:20px") => `<div class="note" style="${pos}">${text}</div>`;

  /* ---------- layout check ---------- */
  /* After drawing, measure every line of on-screen text against the visual elements (anything with class "k", plus
     images and svgs), against the title-safe area, and check that nothing sits in the bottom band
     (BRAND.clearBottom, default 0.17 of the height). The result is written into the page as JSON so
     render_frames.py can read it. It reports candidates; a person decides whether each overlap matters. */
  function layoutReport(stage, error) {
    const W = K.W(), H = K.H(), sf = K.safe();
    const safe = { l: W * sf.left, t: H * sf.top, r: W * (1 - sf.right), b: H * (1 - Math.min(sf.bottom, 0.05) ) };
    const bandTop = H * (1 - sf.bottom);
    const report = { id: params.id, size: [W, H], viewport: [innerWidth, innerHeight], error: error || null, captions: [], overlaps: [], unsafe: [], lowband: [], empty: !stage.textContent.trim() && !stage.querySelector("img,svg,.photo,.face,.chip,.slab,.k") };
    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const caps = [...stage.querySelectorAll(".cap")];
    const visuals = [...stage.querySelectorAll(".k, img, svg, .photo, .face")].filter((el) => {
      if (el.closest(".cap") || el.closest(".note") || el.classList.contains("bgl")) return false;
      const b = box(el);
      return b.w > 4 && b.h > 4 && b.w * b.h < W * H * 0.8 && getComputedStyle(el).visibility !== "hidden";
    });
    const label = (el) => (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || el.tagName.toLowerCase();
    for (const c of caps) {
      const b = box(c);
      const text = c.textContent.trim().slice(0, 80);
      report.captions.push({ text, mode: c.dataset.mode, box: [Math.round(b.l), Math.round(b.t), Math.round(b.w), Math.round(b.h)] });
      // Measure the inked text, not the full-width line box.
      const range = document.createRange(); range.selectNodeContents(c);
      const ink = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (ink.some((r) => r.left < safe.l || r.top < safe.t || r.right > safe.r || r.bottom > safe.b)) report.unsafe.push(text);
      const pad = 12;
      for (const v of visuals) {
        if (c.contains(v)) continue;
        if (c.dataset.mode === "mid" && v.classList.contains("photo")) continue; // brand-film type sits over the picture by design
        const vb = box(v);
        const hit = ink.some((r) => r.left - pad < vb.r && r.right + pad > vb.l && r.top - pad < vb.b && r.bottom + pad > vb.t);
        if (hit) report.overlaps.push({ caption: text, element: String(label(v)).slice(0, 40), box: [Math.round(vb.l), Math.round(vb.t), Math.round(vb.w), Math.round(vb.h)] });
      }
    }
    // Keep the bottom band clear of content: players, platform buttons and phones cover it.
    // Mark product UI, a speaker's name bar or a legal line that may sit low with class "allow-low".
    const labels = [...stage.querySelectorAll(".txt")];
    for (const l of labels) {
      const lb = box(l);
      if (!l.closest(".allow-low") && (lb.l < safe.l || lb.t < safe.t || lb.r > safe.r)) report.unsafe.push(l.textContent.trim().slice(0, 80));
    }
    for (const v of [...visuals, ...caps, ...labels]) {
      if (v.closest(".allow-low")) continue;
      const vb = box(v);
      if (vb.w >= W * 0.9 && vb.h >= H * 0.5) continue; // full-bleed pictures and backgrounds may fill the frame
      if (vb.b > bandTop + 2 && vb.t < H) report.lowband.push({ element: String(label(v)).slice(0, 40), box: [Math.round(vb.l), Math.round(vb.t), Math.round(vb.w), Math.round(vb.h)] });
    }
    const node = document.createElement("script");
    node.type = "application/json"; node.id = "layout-report";
    node.textContent = JSON.stringify(report);
    document.body.appendChild(node);
  }

  /* ---------- render ---------- */
  K.renderFrame = () => {
    const stage = document.getElementById("stage");
    const [W, H] = size();
    document.documentElement.style.setProperty("--w", W + "px");
    document.documentElement.style.setProperty("--h", H + "px");
    if (params.id === "__list") {
      stage.innerHTML = `<pre id="frame-size">${W}x${H}</pre><pre id="frame-list">${Object.keys(frames()).join("\n")}</pre>`;
      return;
    }
    let error = null;
    try {
      const fn = frames()[params.id];
      if (!fn) throw new Error(`No frame called "${params.id}"`);
      stage.innerHTML = fn(params);
      if (params.clean) stage.querySelectorAll(".note").forEach((n) => n.remove());
    } catch (e) {
      error = String(e && e.message || e);
      stage.innerHTML = `<div style="position:absolute;inset:0;background:#fff;color:#b00020;font:600 40px/1.3 sans-serif;padding:80px">Frame error in ${params.id}:<br>${error.replace(/</g, "&lt;")}</div>`;
    }
    layoutReport(stage, error);
  };

  K.STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:var(--w,1920px);height:var(--h,1080px);overflow:hidden;background:#fff}
body{-webkit-font-smoothing:antialiased}
#stage{position:absolute;inset:0;overflow:hidden}
.slab{position:absolute;background:#fff;border-radius:30px;padding:40px 46px;color:#16141a;transform-style:preserve-3d;
 box-shadow:0 1px 0 #ebe8ef,0 2px 0 #e4e0ea,0 3px 0 #ddd8e4,0 4px 0 #d5cfdd,0 5px 0 #cdc6d6,0 6px 0 #c4bccf,0 40px 80px rgba(0,0,0,.3),0 90px 140px rgba(0,0,0,.2)}
.photo{position:absolute;background-size:cover;background-position:center}
.face{display:inline-block;border-radius:50%;background-size:cover;background-position:center 25%;flex:none;vertical-align:middle}
.chip{position:absolute;display:flex;align-items:center;gap:18px;border-radius:999px;padding:16px 30px 16px 16px;background:rgba(255,255,255,.96);
 box-shadow:0 24px 60px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.9);white-space:nowrap;color:#111}
.chip b{display:block;font-size:30px;font-weight:650;letter-spacing:-.01em}.chip small{display:block;font-size:22px;color:#55555f;margin-top:2px}
.cap{position:absolute;color:#fff;letter-spacing:-.02em;line-height:1.08}
.cap b{font-weight:760}
.note{position:absolute;z-index:50;font:600 22px/1.3 sans-serif;color:#fff;border:2px dashed rgba(255,255,255,.75);border-radius:12px;padding:8px 14px;background:rgba(0,0,0,.28);max-width:640px}
`;

  K.install = () => {
    const st = document.createElement("style");
    st.textContent = K.STYLE + (brand().css || "");
    document.head.appendChild(st);
    if (brand().font) document.body.style.fontFamily = brand().font;
  };

  window.KIT = K;
})();
