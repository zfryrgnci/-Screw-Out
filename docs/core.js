/* Screw Out - pure logic. No canvas, no DOM, no timers.
 *
 * The game, in one paragraph: wooden planks are piled on top of each other and
 * pinned down by coloured screws. A screw can only be turned if nothing is
 * lying over it. Unscrew it and it flies into a colour box (three screws to a
 * box) or, if no box of that colour is open yet, into a five-slot holder. When
 * a plank loses its last screw it falls away and reveals what was under it.
 * You lose when the holder is full and nothing you can reach fits anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY LEVEL IS SOLVABLE
 *
 * Two independent things have to be provable: that the screws can be *reached*
 * in some order, and that they can be *sorted* without the holder overflowing.
 *
 * Reachability. Planks are placed in a fixed order and each one is given a
 * lower layer than the last. So plank i is only ever covered by planks with a
 * smaller index. Removing them in index order therefore always works: by the
 * time we reach plank i, every plank that could be lying over it is already
 * gone. That is not a search - it is true by construction, for any positions
 * at all, so the generator can scatter planks freely.
 *
 * Sorting. Walking that removal order gives the exact sequence in which screws
 * come off. Colours are assigned along that sequence rather than up front: at
 * each step the screw is either given the colour of a box that is open right
 * now (so it flies straight in) or committed to a box further down the queue
 * (so it waits in the holder). The second choice is only taken while the
 * holder has room to spare, which is checked at the moment of assignment. The
 * result is a colouring for which that removal order provably never overflows.
 *
 * One invariant makes this airtight: a screw assigned to an *open* box enters
 * it immediately, so for an open box "assigned" and "inside" are the same
 * number, and a box that reaches three clears at once. An open box therefore
 * always has room, and the "put it straight in a box" escape hatch is always
 * available. There is no state where the generator can paint itself into a
 * corner.
 *
 * Both claims are then checked rather than trusted: the construction order is
 * replayed through the public tap() API, and a solver that never saw that
 * order has to win too. A level only its own recipe can beat is a level nobody
 * beats.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScrewCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BOX_CAP = 3;
  var OPEN_BOXES = 3;

  /* ------------------------------------------------------------------ */
  /* rng                                                                 */
  /* ------------------------------------------------------------------ */
  function mkRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function pick(rnd, arr) { return arr[(rnd() * arr.length) | 0]; }
  function shuffle(rnd, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0, t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  var COLOURS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan', 'pink'];

  /* ------------------------------------------------------------------ */
  /* queries                                                             */
  /* ------------------------------------------------------------------ */

  function plankCovers(p, cx, cy) {
    return cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h;
  }

  /* A screw is turnable when its own plank is still up and no *higher* plank
   * that is still up lies across the hole. Layer is what matters, not paint
   * order: two planks can share a cell and the one underneath is the blocked
   * one, no matter which was drawn last. */
  function isFree(st, screwId) {
    var s = st.screws[screwId];
    if (s.state !== 'board') return false;
    var own = st.planks[s.plank];
    if (!own.alive) return false;
    for (var i = 0; i < st.planks.length; i++) {
      var q = st.planks[i];
      if (!q.alive || q.id === own.id) continue;
      if (q.layer > own.layer && plankCovers(q, s.cx, s.cy)) return false;
    }
    return true;
  }

  function freeScrews(st) {
    var out = [];
    for (var i = 0; i < st.screws.length; i++) if (isFree(st, i)) out.push(i);
    return out;
  }

  function openBoxWithColour(st, colour) {
    for (var i = 0; i < st.boxes.length; i++) {
      var b = st.boxes[i];
      if (b && b.colour === colour && b.filled < BOX_CAP) return i;
    }
    return -1;
  }

  function trayFull(st) { return st.tray.length >= st.trayCap; }

  /* Can this particular screw be turned right now? Reachable is not enough -
   * it also has to have somewhere to land. */
  function canTap(st, screwId) {
    if (st.status !== 'play') return false;
    if (!isFree(st, screwId)) return false;
    if (openBoxWithColour(st, st.screws[screwId].colour) >= 0) return true;
    return !trayFull(st);
  }

  function anyMove(st) {
    var f = freeScrews(st);
    for (var i = 0; i < f.length; i++) if (canTap(st, f[i])) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* mutation                                                            */
  /* ------------------------------------------------------------------ */

  function refillBoxes(st, events) {
    var slot;
    for (slot = 0; slot < OPEN_BOXES; slot++) {
      if (!st.boxes[slot] && st.queue.length) {
        st.boxes[slot] = { colour: st.queue.shift(), filled: 0, slot: slot };
        events.push({ t: 'boxopen', slot: slot, colour: st.boxes[slot].colour });
      }
    }
  }

  /* Everything that happens *after* a screw lands: boxes that just filled get
   * shipped out, fresh boxes slide in, and the holder empties itself into
   * anything that now matches. That last step can fill another box, so this
   * runs to a fixed point - the cascade is the payoff of the whole game and it
   * has to be allowed to run all the way. */
  function settle(st, events) {
    var changed = true;
    var guard = 0;
    while (changed && guard++ < 500) {
      changed = false;

      for (var i = 0; i < OPEN_BOXES; i++) {
        var b = st.boxes[i];
        if (b && b.filled >= BOX_CAP) {
          events.push({ t: 'boxclear', slot: i, colour: b.colour });
          st.boxes[i] = null;
          st.cleared++;
          changed = true;
        }
      }
      var before = st.queue.length;
      refillBoxes(st, events);
      if (st.queue.length !== before) changed = true;

      for (var k = 0; k < st.tray.length; k++) {
        var sid = st.tray[k];
        var slot = openBoxWithColour(st, st.screws[sid].colour);
        if (slot >= 0) {
          st.tray.splice(k, 1);
          k--;
          st.screws[sid].state = 'box';
          st.screws[sid].box = slot;
          st.boxes[slot].filled++;
          events.push({ t: 'fly', screw: sid, from: 'tray', slot: slot });
          changed = true;
        }
      }
    }
  }

  function checkEnd(st, events) {
    var done = true;
    for (var i = 0; i < st.screws.length; i++) {
      if (st.screws[i].state === 'board' || st.screws[i].state === 'tray') { done = false; break; }
    }
    var boxesLeft = st.queue.length > 0;
    for (var j = 0; j < OPEN_BOXES; j++) if (st.boxes[j]) boxesLeft = true;
    if (done && !boxesLeft) {
      st.status = 'won';
      events.push({ t: 'win' });
      return;
    }
    if (!anyMove(st)) {
      st.status = 'lost';
      events.push({ t: 'lose' });
    }
  }

  function tap(st, screwId) {
    if (st.status !== 'play') return { ok: false, reason: 'over', events: [] };
    /* Range comparisons alone are not a validity check: 1.5 is "in range" and
     * so are null and NaN, since every comparison against NaN is false. All
     * three then index past the end of the array and crash a line later. */
    if (typeof screwId !== 'number' || !isFinite(screwId) || screwId !== Math.floor(screwId) ||
        screwId < 0 || screwId >= st.screws.length) {
      return { ok: false, reason: 'nosuch', events: [] };
    }
    var s = st.screws[screwId];
    if (s.state !== 'board') return { ok: false, reason: 'gone', events: [] };
    if (!isFree(st, screwId)) return { ok: false, reason: 'blocked', events: [] };

    var events = [];
    var slot = openBoxWithColour(st, s.colour);

    if (slot >= 0) {
      s.state = 'box'; s.box = slot;
      st.boxes[slot].filled++;
      events.push({ t: 'fly', screw: screwId, from: 'board', slot: slot });
    } else {
      if (trayFull(st)) return { ok: false, reason: 'trayfull', events: [] };
      s.state = 'tray';
      st.tray.push(screwId);
      events.push({ t: 'fly', screw: screwId, from: 'board', slot: -1 });
    }

    /* The plank keeps a list of its screws; when the list runs dry it drops.
     * Recomputing "does any screw still belong to me" every frame would be the
     * same answer more slowly, so the count is maintained here. */
    var p = st.planks[s.plank];
    p.left--;
    if (p.left <= 0 && p.alive) {
      p.alive = false;
      events.push({ t: 'plankfall', plank: p.id });
    }

    st.moves++;
    settle(st, events);
    checkEnd(st, events);
    return { ok: true, reason: '', events: events };
  }

  /* The rewarded-ad booster: one more holder slot. Deliberately not free and
   * deliberately not unlimited, because a holder that grows without bound
   * turns the whole game into "tap everything". */
  function addTraySlot(st) {
    if (st.status !== 'play') return { ok: false };
    if (st.traySlotsBought >= 2) return { ok: false, reason: 'max' };
    st.traySlotsBought++;
    st.trayCap++;
    var events = [];
    settle(st, events);
    if (st.status === 'play' && !anyMove(st)) { st.status = 'lost'; events.push({ t: 'lose' }); }
    return { ok: true, events: events };
  }

  function snapshot(st) {
    return JSON.parse(JSON.stringify({
      planks: st.planks, screws: st.screws, boxes: st.boxes,
      queue: st.queue, tray: st.tray, status: st.status, moves: st.moves
    }));
  }

  /* ------------------------------------------------------------------ */
  /* generator                                                           */
  /* ------------------------------------------------------------------ */

  function plankHoles(x, y, w, h) {
    /* Holes at the ends always, plus a middle one on long planks. A plank
     * pinned at one point only would spin, and it reads as a mistake. */
    var cells = [];
    if (w >= h) {
      cells.push([x, y]);
      if (w >= 4) cells.push([x + ((w / 2) | 0), y]);
      if (w >= 2) cells.push([x + w - 1, y]);
    } else {
      cells.push([x, y]);
      if (h >= 4) cells.push([x, y + ((h / 2) | 0)]);
      if (h >= 2) cells.push([x, y + h - 1]);
    }
    return cells;
  }

  /* Placement is where the difficulty actually lives.
   *
   * Scattering planks at random produced boards where nothing was buried at
   * all - every screw reachable on turn one, so there was no order to work out
   * and no puzzle, only tapping. The same mistake as shipping a sliding puzzle
   * at 52% fill. So each plank after the first few is placed *deliberately
   * under* the pile: candidates are scored on how many of their holes end up
   * covered by planks already down, and the score aims at a target fraction
   * rather than at "as buried as possible", because a board where everything
   * is buried is a board with one legal move at a time - a corridor, not a
   * puzzle. */
  function layout(rnd, cfg) {
    var W = cfg.W, H = cfg.H;
    var planks = [];

    function coveredBy(cx, cy) {
      for (var i = 0; i < planks.length; i++) if (plankCovers(planks[i], cx, cy)) return true;
      return false;
    }
    function overlapCells(x, y, w, h) {
      var n = 0;
      for (var dx = 0; dx < w; dx++) for (var dy = 0; dy < h; dy++) {
        if (coveredBy(x + dx, y + dy)) n++;
      }
      return n;
    }

    var union = {};
    var unionN = 0;
    var fillGoal = W * H * 0.60;
    function addUnion(x, y, w, h) {
      for (var dx = 0; dx < w; dx++) for (var dy = 0; dy < h; dy++) {
        var k = (x + dx) + ',' + (y + dy);
        if (!union[k]) { union[k] = 1; unionN++; }
      }
    }
    function freshCells(x, y, w, h) {
      var n = 0;
      for (var dx = 0; dx < w; dx++) for (var dy = 0; dy < h; dy++) {
        if (!union[(x + dx) + ',' + (y + dy)]) n++;
      }
      return n;
    }

    for (var idx = 0; idx < cfg.planks; idx++) {
      var best = null, bestScore = -1e9;
      var seed = idx < 3 ? 0 : cfg.coverTarget;
      var depth = cfg.planks > 1 ? idx / (cfg.planks - 1) : 1;
      /* Long boards at the bottom, short pieces on top - the way anything is
       * actually stacked. It is not only prettier: when the topmost planks are
       * long they blanket the whole pile, so the board shows three planks and
       * hides twenty, and the player is given one legal move at a time. */
      var lmax = Math.max(cfg.minLen, Math.round(2 + (cfg.maxLen - 2) * Math.min(1, depth * 1.35)));

      for (var c = 0; c < 44; c++) {
        var horiz = rnd() < 0.5;
        var len = cfg.minLen + ((rnd() * (lmax - cfg.minLen + 1)) | 0);
        var w = horiz ? len : 1, h = horiz ? 1 : len;
        if (w > W || h > H) continue;
        var x = (rnd() * (W - w + 1)) | 0;
        var y = (rnd() * (H - h + 1)) | 0;

        var dup = false;
        for (var d = 0; d < planks.length; d++) {
          var q = planks[d];
          if (q.x === x && q.y === y && q.w === w && q.h === h) { dup = true; break; }
        }
        if (dup) continue;

        var holes = plankHoles(x, y, w, h);
        var cov = 0;
        for (var hI = 0; hI < holes.length; hI++) if (coveredBy(holes[hI][0], holes[hI][1])) cov++;
        var frac = cov / holes.length;

        var score = -Math.abs(frac - seed) * 10;
        /* Keep the structure a pile rather than confetti: a plank touching
         * nothing floats alone in the corner and looks like a bug. */
        if (planks.length) score += Math.min(overlapCells(x, y, w, h), 3) * 0.6;
        /* ...but stop it collapsing into one clump. Without this the pile grew
         * inward and left most of the frame empty sky. */
        score += freshCells(x, y, w, h) * (unionN < fillGoal ? 1.1 : 0.12);
        score += rnd() * 0.8;
        if (score > bestScore) { bestScore = score; best = { x: x, y: y, w: w, h: h }; }
      }
      if (!best) continue;
      addUnion(best.x, best.y, best.w, best.h);
      planks.push({ id: planks.length, x: best.x, y: best.y, w: best.w, h: best.h, alive: true, layer: 0, left: 0 });
    }
    /* Placement order is removal order; layer descends so nothing later can
     * ever cover something earlier. */
    for (var k = 0; k < planks.length; k++) planks[k].layer = planks.length - 1 - k;
    return planks;
  }

  function buildScrewSequence(planks) {
    /* Removal order = plank index order, which the layer assignment proves is
     * legal. Within a plank the screws can come off in any order. */
    var seq = [];
    for (var i = 0; i < planks.length; i++) {
      var holes = plankHoles(planks[i].x, planks[i].y, planks[i].w, planks[i].h);
      for (var j = 0; j < holes.length; j++) {
        seq.push({ plank: i, cx: holes[j][0], cy: holes[j][1] });
      }
    }
    return seq;
  }

  /* Assign a colour to every entry of `seq` such that taking them in exactly
   * that order never overflows the holder. Returns the box queue too, since
   * the queue order is part of the guarantee. */
  function assignColours(rnd, seq, cfg) {
    var n = seq.length;
    var boxes = [];          /* authored in the order they will open */
    var openSlots = [null, null, null];  /* box indices currently open */
    var nextBox = 0;
    var trayCount = 0;
    var trayByBox = {};      /* box index -> screws of it waiting in the tray */
    var assignment = new Array(n);
    var maxTray = 0;
    var palette = COLOURS.slice(0, cfg.colours);

    function openInto(slot) {
      if (nextBox >= boxes.length) return false;
      var bi = nextBox++;
      openSlots[slot] = bi;
      boxes[bi].open = true;
      var waiting = trayByBox[bi] || 0;
      boxes[bi].inside += waiting;
      trayCount -= waiting;
      trayByBox[bi] = 0;
      if (boxes[bi].inside >= BOX_CAP) { openSlots[slot] = null; boxes[bi].done = true; }
      return true;
    }
    function fillOpenSlots() {
      var moved = true;
      while (moved) {
        moved = false;
        for (var s = 0; s < OPEN_BOXES; s++) {
          if (openSlots[s] === null && nextBox < boxes.length) { if (openInto(s)) moved = true; }
        }
      }
    }
    function newBox() {
      /* Prefer a colour that is not already sitting open, otherwise two open
       * boxes of one colour swallow everything and the holder never gets used. */
      var open = [];
      for (var s = 0; s < OPEN_BOXES; s++) if (openSlots[s] !== null) open.push(boxes[openSlots[s]].colour);
      var fresh = palette.filter(function (c) { return open.indexOf(c) < 0; });
      var colour = fresh.length ? pick(rnd, fresh) : pick(rnd, palette);
      boxes.push({ colour: colour, assigned: 0, inside: 0, open: false, done: false });
      return boxes.length - 1;
    }

    /* Seed the three open slots. */
    for (var s0 = 0; s0 < OPEN_BOXES; s0++) newBox();
    fillOpenSlots();

    for (var t = 0; t < n; t++) {
      var remaining = n - t;
      var deficit = 0;
      for (var b = 0; b < boxes.length; b++) deficit += (BOX_CAP - boxes[b].assigned);

      var openIdx = [];
      for (var s1 = 0; s1 < OPEN_BOXES; s1++) {
        var oi = openSlots[s1];
        if (oi !== null && boxes[oi].assigned < BOX_CAP) openIdx.push(oi);
      }

      var futureIdx = [];
      for (var f = 0; f < boxes.length; f++) {
        if (!boxes[f].open && !boxes[f].done && boxes[f].assigned < BOX_CAP) futureIdx.push(f);
      }

      var target = -1;
      var wantTray = rnd() < cfg.pTray;
      var roomInTray = trayCount + 1 <= cfg.trayCap - 1;
      /* Never author a box we cannot afford to finish - the last screws have
       * to close every box exactly, or the level ends with a box half full and
       * nothing left to put in it. */
      var canAuthor = (deficit + BOX_CAP) <= remaining;

      if (wantTray && roomInTray && (futureIdx.length || canAuthor)) {
        if (!futureIdx.length || (canAuthor && rnd() < 0.4)) target = newBox();
        else target = pick(rnd, futureIdx);
      } else if (openIdx.length) {
        /* Finish the fullest box first: that is what makes boxes clear, slots
         * free up and the holder drain, which is the rhythm of the game. */
        openIdx.sort(function (a, b2) { return boxes[b2].assigned - boxes[a].assigned; });
        target = (rnd() < 0.7) ? openIdx[0] : pick(rnd, openIdx);
      } else if (futureIdx.length && roomInTray) {
        target = pick(rnd, futureIdx);
      } else if (canAuthor && roomInTray) {
        target = newBox();
      } else {
        return null; /* should not happen; caller reseeds rather than shipping a guess */
      }

      boxes[target].assigned++;
      assignment[t] = { colour: boxes[target].colour, box: target };

      if (boxes[target].open) {
        boxes[target].inside++;
        if (boxes[target].inside >= BOX_CAP) {
          boxes[target].done = true;
          for (var s2 = 0; s2 < OPEN_BOXES; s2++) if (openSlots[s2] === target) openSlots[s2] = null;
          fillOpenSlots();
        }
      } else {
        trayByBox[target] = (trayByBox[target] || 0) + 1;
        trayCount++;
        if (trayCount > maxTray) maxTray = trayCount;
      }
    }

    for (var c = 0; c < boxes.length; c++) if (boxes[c].assigned !== BOX_CAP) return null;

    return {
      colours: assignment.map(function (a) { return a.colour; }),
      queue: boxes.map(function (b3) { return b3.colour; }),
      maxTray: maxTray
    };
  }

  function makeState(planks, seq, colours, queue, trayCap) {
    var st = {
      planks: planks.map(function (p) {
        return { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, layer: p.layer, alive: true, left: 0 };
      }),
      screws: [],
      boxes: [null, null, null],
      queue: queue.slice(),
      tray: [],
      trayCap: trayCap,
      traySlotsBought: 0,
      cleared: 0,
      moves: 0,
      status: 'play'
    };
    for (var i = 0; i < seq.length; i++) {
      st.screws.push({
        id: i, plank: seq[i].plank, cx: seq[i].cx, cy: seq[i].cy,
        colour: colours[i], state: 'board', box: -1
      });
      st.planks[seq[i].plank].left++;
    }
    var ev = [];
    refillBoxes(st, ev);
    settle(st, ev);
    return st;
  }

  /* The construction order, replayed through the same tap() a finger reaches.
   * A generator bug that produces an unwinnable board dies here rather than in
   * a player's hands. */
  function replayWitness(st, order) {
    for (var i = 0; i < order.length; i++) {
      var r = tap(st, order[i]);
      if (!r.ok) return { ok: false, at: i, reason: r.reason };
      if (st.status === 'lost') return { ok: false, at: i, reason: 'lost' };
    }
    return { ok: st.status === 'won', at: order.length, reason: st.status };
  }

  /* A solver that has never seen the construction order. Greedy with random
   * tie-breaks, restarted a few times. If none of these beat the board, the
   * board is thrown away - a level only its own recipe can beat is a level
   * nobody beats. */
  function blindSolve(level, tries, seed) {
    var rnd = mkRng(seed || 12345);
    for (var attempt = 0; attempt < tries; attempt++) {
      var st = instantiate(level);
      var guard = 0;
      while (st.status === 'play' && guard++ < 4000) {
        var free = freeScrews(st).filter(function (id) { return canTap(st, id); });
        if (!free.length) break;
        var best = null, bestScore = -1e9;
        for (var i = 0; i < free.length; i++) {
          var id = free[i];
          var col = st.screws[id].colour;
          var slot = openBoxWithColour(st, col);
          var score;
          if (slot >= 0) score = 100 + st.boxes[slot].filled * 10;
          else score = 10 - st.tray.length * 6 - st.queue.indexOf(col);
          /* Freeing a plank opens the board up, which is nearly always worth
           * more than it looks one move ahead. */
          if (st.planks[st.screws[id].plank].left === 1) score += 18;
          score += rnd() * (attempt === 0 ? 0.01 : 14);
          if (score > bestScore) { bestScore = score; best = id; }
        }
        tap(st, best);
      }
      if (st.status === 'won') return { won: true, attempt: attempt };
    }
    return { won: false, attempt: tries };
  }

  function config(level) {
    var L = Math.max(1, level | 0);
    /* Calibrated against measured boards, not against a curve that looked
     * tidy in advance. The numbers that actually move difficulty are how many
     * screws start buried and how hard the holder is pushed. */
    var planks = Math.round(clamp(6 + L * 1.05, 6, 24));
    /* Three colours and three open boxes means every colour is always open,
     * the holder is never used, and the level cannot be lost by anyone.
     *
     * The first version of this ramped colours in over the first eighteen
     * levels, which measured at a 100% random-tap win rate all the way to
     * level ten - and a player who got there said exactly that: you tap
     * everything, it fills, you go next. He was right. One level of teaching
     * the tap is enough; from level two there has to be a decision, and a
     * decision needs more colours than there are open boxes. */
    var colours = L <= 1 ? 3 : L < 3 ? 5 : 6;
    var pTray = clamp(0.05 + L * 0.045, 0.05, 0.62);
    /* The board stays phone-shaped and does not grow much; extra planks go on
     * top of each other instead of sideways, which is what deepens the puzzle. */
    var W = L < 4 ? 6 : L < 12 ? 7 : 8;
    var H = L < 4 ? 8 : L < 12 ? 9 : 11;
    return {
      W: W, H: H, planks: planks, colours: colours, pTray: pTray,
      minLen: 2, maxLen: L < 5 ? 3 : L < 14 ? 4 : 5,
      coverTarget: clamp(0.24 + L * 0.016, 0.24, 0.72),
      /* The holder is what makes a level loseable, and on a short board it
       * never fills: boxes cycle fast, waiting colours open quickly, and five
       * slots are simply more than a fifteen-screw board can ever use. Levels
       * two to seven get a narrower holder instead, so the pressure exists
       * from the start and widens as the boards grow into it. */
      trayCap: L < 4 ? 3 : L < 8 ? 4 : 5
    };
  }

  function generate(level, seed, tweak) {
    var cfg = config(level);
    if (tweak && tweak.pTrayScale) cfg.pTray = clamp(cfg.pTray * tweak.pTrayScale, 0.02, 0.8);
    if (tweak && tweak.coloursDelta) cfg.colours = clamp(cfg.colours + tweak.coloursDelta, 3, COLOURS.length);
    for (var attempt = 0; attempt < 220; attempt++) {
      var rnd = mkRng((seed || 1) * 7919 + attempt * 104729 + level * 31);
      var planks = layout(rnd, cfg);
      if (planks.length < Math.max(3, cfg.planks - 2)) continue;

      var seq = buildScrewSequence(planks);
      /* Every box holds exactly three, so the screw count has to be a multiple
       * of three or the level ends with an unclosable box. Trimming from the
       * last plank keeps the guaranteed removal order intact - it is the last
       * thing taken apart, so nothing depends on it. */
      while (seq.length % BOX_CAP !== 0 && seq.length > 3) seq.pop();
      if (seq.length < 6) continue;
      var used = {};
      for (var q = 0; q < seq.length; q++) used[seq[q].plank] = 1;
      planks = planks.filter(function (p) { return used[p.id]; });
      var remap = {};
      planks.forEach(function (p, i) { remap[p.id] = i; });
      planks.forEach(function (p, i) { p.id = i; });
      seq.forEach(function (s) { s.plank = remap[s.plank]; });

      var col = assignColours(rnd, seq, cfg);
      if (!col) continue;

      var level0 = {
        level: level, W: cfg.W, H: cfg.H, trayCap: cfg.trayCap,
        planks: planks.map(function (p) { return { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, layer: p.layer }; }),
        seq: seq, colours: col.colours, queue: col.queue
      };

      var probe = instantiate(level0);
      var order = [];
      for (var i = 0; i < seq.length; i++) order.push(i);
      var rep = replayWitness(probe, order);
      if (!rep.ok) continue;

      if (!blindSolve(level0, level < 4 ? 6 : 30, 5501 + level).won) continue;

      var start = instantiate(level0);
      level0.stats = {
        screws: seq.length,
        planks: planks.length,
        buried: seq.length - freeScrews(start).length,
        maxTray: col.maxTray,
        boxes: col.queue.length,
        colours: cfg.colours
      };
      return level0;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* difficulty, measured                                                */
  /* ------------------------------------------------------------------ */

  /* How often does careless play win? That is the only honest measure of
   * whether a board contains a decision. A level a random tapper always beats
   * is not an easy level, it is a level with no puzzle in it. */
  function playRandom(level, seed) {
    var r = mkRng(seed);
    var st = instantiate(level), g = 0;
    while (st.status === 'play' && g++ < 5000) {
      var f = freeScrews(st).filter(function (i) { return canTap(st, i); });
      if (!f.length) break;
      tap(st, f[(r() * f.length) | 0]);
    }
    return st.status === 'won';
  }

  /* A fair model of a competent human: fills open boxes, notices that taking a
   * plank's last screw drops it and opens the board, keeps the holder light,
   * and when forced to park a screw picks the colour whose box is coming
   * soonest. Plans exactly one move ahead. If this player cannot get through
   * a level reasonably often, the level is not fair. */
  function playGreedy(level, seed) {
    var r = mkRng(seed);
    var st = instantiate(level), g = 0;
    while (st.status === 'play' && g++ < 5000) {
      var f = freeScrews(st).filter(function (i) { return canTap(st, i); });
      if (!f.length) break;
      var best = null, bs = -1e9;
      for (var i = 0; i < f.length; i++) {
        var id = f[i], col = st.screws[id].colour;
        var slot = openBoxWithColour(st, col);
        var s;
        if (slot >= 0) s = 100 + st.boxes[slot].filled * 12;
        else {
          var wait = st.queue.indexOf(col);
          s = -20 - st.tray.length * 5 - (wait < 0 ? 6 : wait);
        }
        if (st.planks[st.screws[id].plank].left === 1) s += 15;
        s += r() * 3;
        if (s > bs) { bs = s; best = id; }
      }
      tap(st, best);
    }
    return st.status === 'won';
  }

  function measure(level, n, seed) {
    var rw = 0, gw = 0;
    for (var i = 0; i < n; i++) {
      if (playRandom(level, seed + i * 7 + 1)) rw++;
      if (playGreedy(level, seed + i * 13 + 3)) gw++;
    }
    return { random: rw / n, greedy: gw / n };
  }

  /* Where careless play should land. Level one is the only free one - long
   * enough to learn that screws go into matching boxes, short enough that the
   * game starts before anyone gets bored. The floor is about a quarter,
   * because a game you fail three times out of four stops being a game. */
  function targetRandom(L) {
    if (L <= 1) return 1;
    return clamp(1 - 0.78 * (1 - Math.exp(-(L - 1) / 9)), 0.24, 1);
  }

  /* Generate several boards and keep the one whose measured difficulty sits
   * closest to the target, rather than trusting the knobs to have produced it.
   *
   * The candidates are not just different seeds. Seeds alone gave a jagged
   * curve - level 35 came out easier than level 18 - because whether a board
   * was hard was luck. So the search sweeps the one knob that moves difficulty
   * monotonically, the share of screws deliberately committed to boxes that
   * are not open yet, and lets the measurement pick the point on that sweep. */
  function generateTuned(level, seed, opts) {
    opts = opts || {};
    var K = opts.candidates || 12;
    var N = opts.samples || 40;
    var want = targetRandom(level);
    var best = null, bestCost = 1e9;
    for (var k = 0; k < K; k++) {
      var f = K > 1 ? k / (K - 1) : 0.5;
      var lv = generate(level, (seed || 1) + k * 1013, { pTrayScale: 0.25 + 1.85 * f });
      if (!lv) continue;
      var m = measure(lv, N, 4001 + k * 97);
      /* A competent player has to get through. Rollic's own line is that every
       * level is beatable without buying anything, and that only holds if
       * playing well is reliably enough. */
      var fair = m.greedy >= Math.max(0.45, m.random + 0.05) || level <= 1;
      var cost = Math.abs(m.random - want) + (fair ? 0 : 1.5);
      lv.stats.random = m.random;
      lv.stats.greedy = m.greedy;
      if (cost < bestCost) { bestCost = cost; best = lv; }
      if (cost < 0.04) break;
    }
    return best;
  }

  function instantiate(level) {
    var planks = level.planks.map(function (p) {
      return { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h, layer: p.layer, alive: true, left: 0 };
    });
    var st = makeState(planks, level.seq, level.colours, level.queue, level.trayCap);
    st.W = level.W; st.H = level.H; st.level = level.level;
    return st;
  }

  return {
    BOX_CAP: BOX_CAP, OPEN_BOXES: OPEN_BOXES, COLOURS: COLOURS,
    mkRng: mkRng, shuffle: shuffle, pick: pick,
    plankCovers: plankCovers, plankHoles: plankHoles,
    isFree: isFree, freeScrews: freeScrews, canTap: canTap, anyMove: anyMove,
    openBoxWithColour: openBoxWithColour, trayFull: trayFull,
    tap: tap, addTraySlot: addTraySlot, snapshot: snapshot,
    config: config, generate: generate, instantiate: instantiate,
    replayWitness: replayWitness, blindSolve: blindSolve,
    playRandom: playRandom, playGreedy: playGreedy, measure: measure,
    targetRandom: targetRandom, generateTuned: generateTuned
  };
}));
