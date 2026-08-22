/* Screw Out - rendering and input.
 *
 * Everything is painted into one canvas. There is not a single DOM element on
 * top of the board, and that is deliberate: a sibling game once shipped
 * completely unplayable because an invisible positioned div sat over the
 * canvas and swallowed every tap, while its whole test suite passed. If the
 * only thing the player can touch is the canvas, that failure cannot happen.
 *
 * One rendering fact does all the work here: planks are painted in layer
 * order, so a screw is visible exactly when no higher plank covers its hole -
 * which is the same condition as being turnable. Occlusion is not drawn to
 * illustrate the rule, it *is* the rule, so what the player sees can never
 * disagree with what the engine allows.
 */
(function () {
  'use strict';

  var C = window.ScrewCore;
  var cv = document.getElementById('c');
  var ctx = cv.getContext('2d');

  var G = {
    W: 0, H: 0, dpr: 1,
    sx: 0, sw: 0, sh: 0,      /* letterbox stage */
    st: null, level: 1,
    cell: 40, ox: 0, oy: 0,
    anims: [], t: 0, shake: 0,
    screen: 'play',            /* play | won | lost */
    overlayT: 0,
    hint: 0,
    buttons: []
  };

  /* ------------------------------------------------------------------ */
  /* storage - wrapped, because file:// and some WebViews throw on access */
  /* ------------------------------------------------------------------ */
  var mem = {};
  function store(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; }
  }
  function load(k, d) {
    try { var v = localStorage.getItem(k); return v === null ? d : v; }
    catch (e) { return k in mem ? mem[k] : d; }
  }

  /* ------------------------------------------------------------------ */
  /* audio                                                               */
  /* ------------------------------------------------------------------ */
  var Audio2 = (function () {
    var actx = null, muted = load('so_mute', '0') === '1';
    function ac() {
      if (!actx) {
        try { actx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { actx = false; }
      }
      return actx;
    }
    function blip(freq, dur, type, vol) {
      if (muted) return;
      var a = ac(); if (!a) return;
      try {
        if (a.state === 'suspended') a.resume();
        var o = a.createOscillator(), g = a.createGain();
        o.type = type || 'triangle';
        o.frequency.setValueAtTime(freq, a.currentTime);
        g.gain.setValueAtTime(vol || 0.09, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
        o.connect(g); g.connect(a.destination);
        o.start(); o.stop(a.currentTime + dur);
      } catch (e) { /* audio is a nicety; never let it break input */ }
    }
    return {
      unscrew: function () { blip(320 + Math.random() * 60, 0.09, 'square', 0.05); },
      land: function () { blip(540, 0.07, 'triangle', 0.06); },
      box: function () { blip(760, 0.16, 'sine', 0.1); setTimeout(function () { blip(1010, 0.18, 'sine', 0.09); }, 70); },
      fall: function () { blip(150, 0.22, 'sawtooth', 0.05); },
      win: function () { [660, 830, 990, 1320].forEach(function (f, i) { setTimeout(function () { blip(f, 0.2, 'sine', 0.09); }, i * 105); }); },
      lose: function () { [420, 330, 250].forEach(function (f, i) { setTimeout(function () { blip(f, 0.24, 'sine', 0.08); }, i * 130); }); },
      bad: function () { blip(160, 0.1, 'square', 0.05); },
      toggle: function () { muted = !muted; store('so_mute', muted ? '1' : '0'); return muted; },
      muted: function () { return muted; }
    };
  }());

  /* ------------------------------------------------------------------ */
  /* ads - the Android side fills these in; on the web they no-op        */
  /* ------------------------------------------------------------------ */
  var Ads = {
    interstitial: function () {
      try { if (window.AndroidBridge && AndroidBridge.showInterstitial) AndroidBridge.showInterstitial(); } catch (e) {}
    },
    rewarded: function (cb) {
      Ads._cb = cb;
      try {
        if (window.AndroidBridge && AndroidBridge.showRewarded) { AndroidBridge.showRewarded(); return; }
      } catch (e) {}
      cb(true); /* no bridge: give the reward rather than dead-ending the player */
    }
  };
  window.ScrewOut = {
    onRewardEarned: function () { if (Ads._cb) { var f = Ads._cb; Ads._cb = null; f(true); } },
    onRewardFailed: function () { if (Ads._cb) { var f = Ads._cb; Ads._cb = null; f(false); } }
  };

  /* ------------------------------------------------------------------ */
  /* palette                                                             */
  /* ------------------------------------------------------------------ */
  var PAL = {
    red: ['#ff5a5a', '#d92f2f'], blue: ['#4f97ff', '#2563c9'],
    green: ['#42d17a', '#1f9c50'], yellow: ['#ffd23f', '#d9a406'],
    purple: ['#b06bff', '#7c3ac9'], orange: ['#ff9a3c', '#d96b13'],
    cyan: ['#3fd8e6', '#128fa3'], pink: ['#ff77c2', '#d43c92']
  };
  var WOOD = ['#e0a869', '#c07f43', '#f2c894'];

  /* ------------------------------------------------------------------ */
  /* geometry                                                            */
  /* ------------------------------------------------------------------ */
  function resize() {
    G.W = window.innerWidth; G.H = window.innerHeight;
    G.dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(G.W * G.dpr);
    cv.height = Math.round(G.H * G.dpr);
    cv.style.width = G.W + 'px';
    cv.style.height = G.H + 'px';
    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);

    /* A phone-shaped column, centred. On a wide desktop window the board would
     * otherwise stretch into something no phone ever shows. */
    G.sw = Math.min(G.W, G.H * 0.60, 580);
    G.sh = G.H;
    G.sx = (G.W - G.sw) / 2;
    layout();
  }

  var TOPBAR = 0, BOXTOP = 0, TRAYTOP = 0;

  function layout() {
    var st = G.st;
    TOPBAR = Math.max(54, G.sh * 0.085);
    var trayH = G.sw * 0.15;
    var boxH = G.sw * 0.24;
    TRAYTOP = G.sh - trayH - G.sh * 0.025;
    BOXTOP = TRAYTOP - boxH - G.sw * 0.03;

    if (!st) return;
    var availW = G.sw * 0.94;
    var availH = BOXTOP - TOPBAR - G.sw * 0.06;
    /* Fit the planks, not the nominal grid. The generator rarely uses every
     * row, and fitting the grid left a third of the screen as empty sky with
     * the pieces shrunk to fit space nothing was in. The box is taken once, at
     * level start, from the *initial* planks - recomputing it as planks fall
     * would make the whole board zoom under the player's finger. */
    var bb = G.bbox;
    var bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
    G.cell = Math.min(availW / bw, availH / bh);
    G.ox = G.sx + (G.sw - bw * G.cell) / 2 - bb.x0 * G.cell;
    G.oy = TOPBAR + (availH - bh * G.cell) / 2 + G.sw * 0.03 - bb.y0 * G.cell;
  }

  function cellPx(cx, cy) {
    return { x: G.ox + (cx + 0.5) * G.cell, y: G.oy + (cy + 0.5) * G.cell };
  }

  /* ------------------------------------------------------------------ */
  /* level flow                                                          */
  /* ------------------------------------------------------------------ */
  function levelData(n) {
    var pack = window.SCREW_LEVELS;
    if (pack && pack[n - 1]) return pack[n - 1];
    /* Past the shipped pack, make one on the spot. Same generator, same
     * guarantees - it is only slower, and by then the player has earned it. */
    return C.generateTuned(n, 90210 + n, { candidates: 5, samples: 18 }) ||
           C.generate(n, 90210 + n);
  }

  function startLevel(n) {
    G.level = n;
    var lv = levelData(n);
    G.st = C.instantiate(lv);
    var bb = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
    for (var i = 0; i < lv.planks.length; i++) {
      var p = lv.planks[i];
      if (p.x < bb.x0) bb.x0 = p.x;
      if (p.y < bb.y0) bb.y0 = p.y;
      if (p.x + p.w > bb.x1) bb.x1 = p.x + p.w;
      if (p.y + p.h > bb.y1) bb.y1 = p.y + p.h;
    }
    G.bbox = bb;
    G.anims = [];
    G.screen = 'play';
    G.overlayT = 0;
    G.shake = 0;
    store('so_level', String(n));
    layout();
  }

  function nextLevel() {
    var n = G.level + 1;
    /* An interstitial every third level: often enough to matter, rarely enough
     * that it does not feel like a toll booth. */
    if (n % 3 === 1 && n > 3) Ads.interstitial();
    startLevel(n);
  }

  /* ------------------------------------------------------------------ */
  /* animation                                                           */
  /* ------------------------------------------------------------------ */
  function anim(o) { o.t = 0; G.anims.push(o); return o; }

  function stepAnims(dt) {
    for (var i = G.anims.length - 1; i >= 0; i--) {
      var a = G.anims[i];
      a.t += dt;
      if (a.t >= a.dur) { if (a.done) a.done(); G.anims.splice(i, 1); }
    }
  }
  function ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
  function easeOutBack(t) { var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

  /* Screws in flight are drawn from the animation list, not from the board, so
   * a screw is never in two places at once. */
  function flyScrew(sid, from, to, delay) {
    anim({ kind: 'fly', sid: sid, from: from, to: to, dur: 0.32, delay: delay || 0 });
  }

  function trayPos(i) {
    var n = G.st ? G.st.trayCap : 5;
    var pad = G.sw * 0.035;
    var w = (G.sw - pad * 2) / n;
    return { x: G.sx + pad + w * (i + 0.5), y: TRAYTOP + G.sw * 0.075 };
  }
  function boxSlotPos(slot, k) {
    var pad = G.sw * 0.035;
    var bw = (G.sw - pad * 2 - G.sw * 0.04) / 3;
    var bx = G.sx + pad + slot * (bw + G.sw * 0.02);
    var r = bw * 0.13;
    return { x: bx + bw * 0.5 + (k - 1) * (r * 2.5), y: BOXTOP + G.sw * 0.155 };
  }

  function applyEvents(events) {
    var delay = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.t === 'fly') {
        var s = G.st.screws[e.screw];
        var from = e.from === 'tray' ? trayPos(0) : cellPx(s.cx, s.cy);
        var to = e.slot >= 0 ? boxSlotPos(e.slot, G.st.boxes[e.slot] ? G.st.boxes[e.slot].filled - 1 : 0)
                             : trayPos(G.st.tray.indexOf(e.screw));
        flyScrew(e.screw, from, to, delay);
        if (e.from === 'tray') delay += 0.06;
        Audio2.land();
      } else if (e.t === 'plankfall') {
        anim({ kind: 'fall', plank: e.plank, dur: 0.45, delay: 0, dir: Math.random() < 0.5 ? -1 : 1 });
        Audio2.fall();
      } else if (e.t === 'boxclear') {
        anim({ kind: 'pop', slot: e.slot, dur: 0.3 });
        Audio2.box();
      } else if (e.t === 'win') {
        G.screen = 'won'; G.overlayT = 0; Audio2.win();
        var best = parseInt(load('so_best', '1'), 10) || 1;
        if (G.level + 1 > best) store('so_best', String(G.level + 1));
      } else if (e.t === 'lose') {
        G.screen = 'lost'; G.overlayT = 0; Audio2.lose();
      }
    }
  }

  function animFor(kind, key, val) {
    for (var i = 0; i < G.anims.length; i++) {
      var a = G.anims[i];
      if (a.kind === kind && a[key] === val) return a;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* input                                                               */
  /* ------------------------------------------------------------------ */
  function hitScrew(px, py) {
    var st = G.st, best = -1, bestD = 1e9;
    var r = G.cell * 0.5;
    for (var i = 0; i < st.screws.length; i++) {
      if (!C.isFree(st, i)) continue;      /* invisible screws are untappable */
      var s = st.screws[i];
      var p = cellPx(s.cx, s.cy);
      var d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
      if (d < r * r && d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function onPress(px, py) {
    /* Buttons are hit-tested from a list rebuilt every frame, so what is drawn
     * and what is touchable cannot drift apart. */
    for (var i = 0; i < G.buttons.length; i++) {
      var b = G.buttons[i];
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { b.fn(); return; }
    }
    if (G.screen !== 'play') return;

    var sid = hitScrew(px, py);
    if (sid < 0) return;
    var st = G.st;
    if (!C.canTap(st, sid)) {
      /* Reachable but nowhere to put it - say so with a shake rather than
       * silently ignoring the tap, which reads as a broken button. */
      G.shake = 0.35; Audio2.bad(); G.hint = 1.2;
      return;
    }
    Audio2.unscrew();
    anim({ kind: 'spin', sid: sid, dur: 0.18 });
    var r = C.tap(st, sid);
    if (r.ok) applyEvents(r.events);
  }

  function toStage(clientX, clientY) {
    var rect = cv.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  cv.addEventListener('touchstart', function (e) {
    if (e.cancelable) e.preventDefault();  /* non-cancelable touches log an error if you do this blind */
    var t = e.changedTouches[0];
    var p = toStage(t.clientX, t.clientY);
    onPress(p.x, p.y);
  }, { passive: false });

  cv.addEventListener('mousedown', function (e) {
    var p = toStage(e.clientX, e.clientY);
    onPress(p.x, p.y);
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 60); });

  /* ------------------------------------------------------------------ */
  /* drawing helpers                                                     */
  /* ------------------------------------------------------------------ */
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawPlank(p, alpha, dy, rot) {
    var x = G.ox + p.x * G.cell, y = G.oy + p.y * G.cell;
    var w = p.w * G.cell, h = p.h * G.cell;
    var pad = G.cell * 0.06;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x + w / 2, y + h / 2 + (dy || 0));
    if (rot) ctx.rotate(rot);
    ctx.translate(-w / 2, -h / 2);

    ctx.shadowColor = 'rgba(60,35,10,0.35)';
    ctx.shadowBlur = G.cell * 0.28;
    ctx.shadowOffsetY = G.cell * 0.13;
    rr(pad, pad, w - pad * 2, h - pad * 2, G.cell * 0.26);
    var g = ctx.createLinearGradient(0, pad, 0, h - pad);
    g.addColorStop(0, WOOD[2]); g.addColorStop(0.45, WOOD[0]); g.addColorStop(1, WOOD[1]);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    /* Grain: a few soft strokes along the long axis. Enough to read as timber,
     * not so much that the screws get lost in it. */
    ctx.save();
    rr(pad, pad, w - pad * 2, h - pad * 2, G.cell * 0.26);
    ctx.clip();
    ctx.strokeStyle = 'rgba(140,85,40,0.20)';
    ctx.lineWidth = Math.max(1, G.cell * 0.035);
    var along = w >= h;
    var n = 4;
    for (var i = 1; i <= n; i++) {
      ctx.beginPath();
      if (along) {
        var yy = pad + (h - pad * 2) * (i / (n + 1));
        ctx.moveTo(pad + G.cell * 0.1, yy);
        ctx.bezierCurveTo(w * 0.35, yy - G.cell * 0.05, w * 0.65, yy + G.cell * 0.05, w - pad - G.cell * 0.1, yy);
      } else {
        var xx = pad + (w - pad * 2) * (i / (n + 1));
        ctx.moveTo(xx, pad + G.cell * 0.1);
        ctx.bezierCurveTo(xx - G.cell * 0.05, h * 0.35, xx + G.cell * 0.05, h * 0.65, xx, h - pad - G.cell * 0.1);
      }
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = Math.max(1, G.cell * 0.045);
    rr(pad + ctx.lineWidth * 0.5, pad + ctx.lineWidth * 0.5,
       w - pad * 2 - ctx.lineWidth, h - pad * 2 - ctx.lineWidth, G.cell * 0.24);
    ctx.stroke();
    ctx.restore();
  }

  function drawScrew(px, py, colour, r, spin, dim) {
    var c = PAL[colour] || PAL.red;
    ctx.save();
    ctx.translate(px, py);
    if (spin) ctx.rotate(spin);
    if (dim) ctx.globalAlpha = 0.55;

    ctx.beginPath(); ctx.arc(0, r * 0.13, r, 0, 6.2832);
    ctx.fillStyle = 'rgba(40,25,10,0.30)'; ctx.fill();

    var g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    g.addColorStop(0, c[0]); g.addColorStop(1, c[1]);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832);
    ctx.fillStyle = g; ctx.fill();

    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.20)'; ctx.stroke();

    /* Cross-head slot - the detail that makes it read as a screw and not a
     * coloured dot. */
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1.4, r * 0.20);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r * 0.52, 0); ctx.lineTo(r * 0.52, 0);
    ctx.moveTo(0, -r * 0.52); ctx.lineTo(0, r * 0.52);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(-r * 0.32, -r * 0.36, r * 0.26, 0, 6.2832);
    ctx.fillStyle = 'rgba(255,255,255,0.38)'; ctx.fill();
    ctx.restore();
  }

  function drawSocket(px, py, r) {
    ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.stroke();
  }

  function text(s, x, y, size, colour, align, weight) {
    ctx.font = (weight || '800') + ' ' + size + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colour;
    ctx.fillText(s, x, y);
  }

  function button(x, y, w, h, label, fill, fn, size) {
    rr(x, y + h * 0.07, w, h, h * 0.28);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fill();
    rr(x, y, w, h, h * 0.28);
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, fill[0]); g.addColorStop(1, fill[1]);
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
    text(label, x + w / 2, y + h / 2, size || Math.round(h * 0.38), '#fff');
    G.buttons.push({ x: x, y: y, w: w, h: h, fn: fn });
  }

  /* ------------------------------------------------------------------ */
  /* frame                                                               */
  /* ------------------------------------------------------------------ */
  function draw(dt) {
    var st = G.st;
    G.t += dt;
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt);
    if (G.hint > 0) G.hint = Math.max(0, G.hint - dt);
    G.buttons = [];

    /* background */
    var bg = ctx.createLinearGradient(0, 0, 0, G.H);
    bg.addColorStop(0, '#7fd0f5'); bg.addColorStop(0.55, '#a9e4fb'); bg.addColorStop(1, '#ffe6bb');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, G.W, G.H);

    /* the stage, so a wide window frames the phone column instead of stretching it */
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(G.sx, 0, G.sw, G.H);
    ctx.restore();

    ctx.save();
    if (G.shake > 0) {
      var m = G.shake * 9;
      ctx.translate(Math.sin(G.t * 60) * m, Math.cos(G.t * 51) * m * 0.5);
    }

    drawTopBar();
    drawBoard();
    drawBoxes();
    drawTray();
    drawFlying();

    ctx.restore();

    if (G.screen !== 'play') drawOverlay(dt);
  }

  function drawTopBar() {
    var y = G.sh * 0.018, h = TOPBAR - y - 8;
    rr(G.sx + G.sw * 0.035, y, G.sw * 0.93, h, h * 0.32);
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill();
    text('LEVEL ' + G.level, G.sx + G.sw * 0.5, y + h * 0.5, Math.round(h * 0.44), '#2b4a63');

    var bs = h * 0.62;
    var bx = G.sx + G.sw * 0.035 + G.sw * 0.02;
    button(bx, y + (h - bs) / 2, bs, bs, Audio2.muted() ? '🔇' : '🔊', ['#ffd35c', '#f0a92b'],
           function () { Audio2.toggle(); }, Math.round(bs * 0.5));

    var rx = G.sx + G.sw * 0.965 - G.sw * 0.02 - bs;
    button(rx, y + (h - bs) / 2, bs, bs, '↻', ['#8fd6ff', '#3f9fe0'],
           function () { startLevel(G.level); }, Math.round(bs * 0.55));
  }

  function drawBoard() {
    var st = G.st;
    /* Back to front by layer, so a higher plank paints over the screws of the
     * plank beneath it. That painting order is the occlusion rule. */
    var order = st.planks.slice().sort(function (a, b) { return a.layer - b.layer; });
    for (var i = 0; i < order.length; i++) {
      var p = order[i];
      var fa = animFor('fall', 'plank', p.id);
      if (!p.alive && !fa) continue;
      var alpha = 1, dy = 0, rot = 0;
      if (fa) {
        var t = Math.min(1, fa.t / fa.dur);
        alpha = 1 - t * t;
        dy = t * t * G.cell * 5;
        rot = fa.dir * t * 0.7;
      }
      drawPlank(p, alpha, dy, rot);

      if (!fa) {
        for (var s = 0; s < st.screws.length; s++) {
          var sc = st.screws[s];
          if (sc.plank !== p.id || sc.state !== 'board') continue;
          if (animFor('fly', 'sid', s)) continue;
          var pos = cellPx(sc.cx, sc.cy);
          var sp = animFor('spin', 'sid', s);
          var dim = G.hint > 0 && !C.canTap(st, s);
          drawScrew(pos.x, pos.y, sc.colour, G.cell * 0.30,
                    sp ? (sp.t / sp.dur) * 6.5 : 0, dim);
        }
      }
    }
  }

  function drawBoxes() {
    var st = G.st;
    var pad = G.sw * 0.035;
    var bw = (G.sw - pad * 2 - G.sw * 0.04) / 3;
    var bh = G.sw * 0.24;

    for (var slot = 0; slot < 3; slot++) {
      var bx = G.sx + pad + slot * (bw + G.sw * 0.02);
      var b = st.boxes[slot];
      var pop = animFor('pop', 'slot', slot);
      var sc = 1;
      if (pop) { var t = pop.t / pop.dur; sc = 1 + Math.sin(t * Math.PI) * 0.16; }

      ctx.save();
      ctx.translate(bx + bw / 2, BOXTOP + bh / 2);
      ctx.scale(sc, sc);
      ctx.translate(-bw / 2, -bh / 2);

      rr(0, bh * 0.05, bw, bh * 0.95, bw * 0.14);
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fill();

      rr(0, 0, bw, bh * 0.95, bw * 0.14);
      if (b) {
        var c = PAL[b.colour];
        var g = ctx.createLinearGradient(0, 0, 0, bh);
        g.addColorStop(0, c[0]); g.addColorStop(1, c[1]);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.32)';
      }
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.stroke();

      if (b) {
        var r = bw * 0.13;
        for (var k = 0; k < 3; k++) {
          var px = bw * 0.5 + (k - 1) * (r * 2.5), py = bh * 0.55;
          if (k < b.filled) drawScrew(px, py, b.colour, r * 0.86, 0, false);
          else drawSocket(px, py, r * 0.86);
        }
      } else {
        text('—', bw / 2, bh * 0.5, bw * 0.3, 'rgba(255,255,255,0.7)');
      }
      ctx.restore();
    }

    /* Queue preview: knowing what is coming is most of the strategy. */
    var qy = BOXTOP - G.sw * 0.055;
    var qn = Math.min(5, st.queue.length);
    var qr = G.sw * 0.021;
    var qw = qr * 3.1;
    var qx0 = G.sx + G.sw * 0.5 - (qn * qw) / 2 + qw / 2;
    text('NEXT', G.sx + G.sw * 0.5 - (qn * qw) / 2 - G.sw * 0.075, qy, G.sw * 0.036, 'rgba(35,70,95,0.8)');
    for (var q = 0; q < qn; q++) {
      var c2 = PAL[st.queue[q]];
      ctx.beginPath(); ctx.arc(qx0 + q * qw, qy, qr, 0, 6.2832);
      ctx.fillStyle = c2[0]; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.stroke();
    }
    if (st.queue.length > qn) {
      text('+' + (st.queue.length - qn), qx0 + qn * qw + qr * 1.2, qy, G.sw * 0.034, 'rgba(35,70,95,0.75)');
    }
  }

  function drawTray() {
    var st = G.st;
    var pad = G.sw * 0.035;
    var h = G.sw * 0.15;
    rr(G.sx + pad, TRAYTOP, G.sw - pad * 2, h, h * 0.28);
    var full = st.tray.length >= st.trayCap;
    ctx.fillStyle = full ? 'rgba(255,120,120,0.55)' : 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = full ? '#e04b4b' : 'rgba(255,255,255,0.6)';
    ctx.stroke();

    var r = h * 0.29;
    for (var i = 0; i < st.trayCap; i++) {
      var p = trayPos(i);
      if (i < st.tray.length) {
        var sid = st.tray[i];
        if (animFor('fly', 'sid', sid)) { drawSocket(p.x, p.y, r); continue; }
        drawScrew(p.x, p.y, st.screws[sid].colour, r, 0, false);
      } else {
        drawSocket(p.x, p.y, r);
      }
    }
  }

  function drawFlying() {
    var st = G.st;
    for (var i = 0; i < G.anims.length; i++) {
      var a = G.anims[i];
      if (a.kind !== 'fly') continue;
      if (a.t < a.delay) continue;
      var t = Math.min(1, (a.t - a.delay) / a.dur);
      var e = ease(t);
      var x = a.from.x + (a.to.x - a.from.x) * e;
      var y = a.from.y + (a.to.y - a.from.y) * e - Math.sin(t * Math.PI) * G.sw * 0.09;
      drawScrew(x, y, st.screws[a.sid].colour, G.cell * 0.30 * (1 - t * 0.18), t * 9, false);
    }
  }

  function drawOverlay(dt) {
    /* A panel is modal: it owns the input while it is up, so the controls
     * behind it stop being touchable. Otherwise what the player can touch
     * stops matching what they can see. */
    G.buttons = [];
    G.overlayT += dt;
    var k = Math.min(1, G.overlayT / 0.32);
    ctx.fillStyle = 'rgba(12,28,44,' + (0.74 * k) + ')';
    ctx.fillRect(0, 0, G.W, G.H);

    var w = Math.min(G.sw * 0.84, 380);
    var h = w * 0.86;
    var x = G.W / 2 - w / 2;
    var y = G.H / 2 - h / 2 - G.H * 0.02;
    var s = easeOutBack(k);
    ctx.save();
    ctx.translate(G.W / 2, G.H / 2 - G.H * 0.02);
    ctx.scale(s, s);
    ctx.translate(-G.W / 2, -(G.H / 2 - G.H * 0.02));

    rr(x, y, w, h, w * 0.09);
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e8f4ff');
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(60,110,150,0.35)'; ctx.stroke();

    var won = G.screen === 'won';
    text(won ? 'LEVEL DONE!' : 'STUCK!', G.W / 2, y + h * 0.20, w * 0.115, won ? '#1f9c50' : '#d9483b');
    text(won ? 'Level ' + G.level + ' cleared in ' + G.st.moves + ' turns'
             : 'The holder is full',
         G.W / 2, y + h * 0.34, w * 0.062, '#4a6b83', 'center', '600');

    var bw = w * 0.72, bh = h * 0.17;
    if (won) {
      button(G.W / 2 - bw / 2, y + h * 0.48, bw, bh, 'NEXT LEVEL', ['#54dd86', '#22a35a'], nextLevel);
      button(G.W / 2 - bw / 2, y + h * 0.70, bw, bh, 'REPLAY', ['#8fd6ff', '#3f9fe0'],
             function () { startLevel(G.level); });
    } else {
      var canBuy = G.st.traySlotsBought < 2;
      button(G.W / 2 - bw / 2, y + h * 0.48, bw, bh,
             canBuy ? '+1 SLOT  (AD)' : 'NO SLOTS LEFT',
             canBuy ? ['#ffcf5c', '#e8a010'] : ['#c9d3da', '#9fb0bb'],
             function () {
               if (!canBuy) return;
               Ads.rewarded(function (granted) {
                 if (!granted) return;
                 var r = C.addTraySlot(G.st);
                 if (r.ok) {
                   G.screen = 'play';
                   layout();
                   applyEvents(r.events || []);
                 }
               });
             });
      button(G.W / 2 - bw / 2, y + h * 0.70, bw, bh, 'TRY AGAIN', ['#8fd6ff', '#3f9fe0'],
             function () { startLevel(G.level); });
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  var last = 0;
  function frame(ts) {
    var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
    last = ts;
    stepAnims(dt);
    draw(dt);
    requestAnimationFrame(frame);
  }

  resize();
  startLevel(parseInt(load('so_level', '1'), 10) || 1);
  requestAnimationFrame(frame);

  /* Exposed for the test harness so it can assert on real state while driving
   * the real glass. Nothing in the game reads these. */
  window.__game = G;
  window.__core = C;
  window.__startLevel = startLevel;
}());
