// berry.me motion: the hero tile field, the live console, scroll reveals and
// the small looping demos in the bento tiles. First-party, no dependencies.
// Everything checks prefers-reduced-motion and pauses while off screen.
(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Runs `tick` every `ms` only while `element` is on screen. */
  function whileVisible(element, ms, tick) {
    if (!element || reduced) return;
    let timer = 0;
    const observer = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry.isIntersecting) timer = setInterval(tick, ms);
    });
    observer.observe(element);
  }

  // ---------- Scroll reveals and in-view flags ----------
  const reveal = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add(entry.target.hasAttribute("data-reveal") ? "is-in" : "in-view");
      reveal.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  $$("[data-reveal], [data-inview]").forEach((element) => reveal.observe(element));

  // ---------- Counters ----------
  const counters = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      counters.unobserve(entry.target);
      const element = entry.target;
      const target = Number(element.dataset.count);
      const format = (value) => Math.round(value).toLocaleString("en-US");
      if (reduced) { element.textContent = format(target); continue; }
      const start = performance.now();
      const duration = 1400;
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        element.textContent = format(target * (1 - Math.pow(1 - t, 4)));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.4 });
  $$("[data-count]").forEach((element) => counters.observe(element));

  // ---------- Hero tile field ----------
  const canvas = $(".hero-tiles");
  if (canvas) {
    const context = canvas.getContext("2d");
    const glyphs = [
      ["11", "11"],
      ["101", "010", "101"],
      ["110", "011"],
      ["1001", "0110"],
    ];
    let tiles = [];
    let marks = [];
    let tile = 100;
    let x0 = 0;
    let cols = 0;
    let rows = 0;
    let width = 0;
    let height = 0;
    let visible = true;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      tile = width < 640 ? 64 : 100;
      const centre = width / 2;
      x0 = centre - Math.ceil(centre / tile) * tile;
      cols = Math.ceil((width - x0) / tile) + 1;
      rows = Math.ceil(height / tile) + 1;
      marks = Array.from({ length: 14 }, () => [1 + Math.floor(Math.random() * (cols - 1)), 1 + Math.floor(Math.random() * (rows - 1))]);
      tiles = Array.from({ length: cols * rows }, () => {
        const fill = Math.random() < 0.22 ? Math.random() * 0.05 : 0;
        return { fill, target: fill, glyph: Math.random() < 0.06 ? Math.floor(Math.random() * glyphs.length) : -1, red: Math.random() < 0.3 };
      });
      draw();
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const t = tiles[row * cols + col];
          const x = x0 + col * tile;
          const y = row * tile;
          // Wash out the middle so the copy stays clean.
          const dx = (x + tile / 2 - width / 2) / (width * 0.42);
          const dy = (y + tile / 2 - height * 0.36) / (height * 0.5);
          const fade = Math.min(1, Math.max(0, Math.hypot(dx, dy) - 0.35));
          if (t.fill > 0.002) {
            const strength = Math.max(fade, t.hot ? 0.7 : 0);
            context.fillStyle = t.hot ? `rgba(236,43,69,${(t.fill * 1.6 * strength).toFixed(3)})` : `rgba(255,255,255,${(t.fill * fade).toFixed(3)})`;
            context.fillRect(x + 1, y + 1, tile - 1, tile - 1);
          }
          if (t.glyph >= 0 && fade > 0.2) {
            const glyph = glyphs[t.glyph];
            const size = Math.max(4, Math.round(tile * 0.06));
            const span = glyph[0].length * size;
            const gx = x + (tile - span) / 2;
            const gy = y + (tile - glyph.length * size) / 2;
            glyph.forEach((line, gyIndex) => {
              [...line].forEach((cell, gxIndex) => {
                if (cell !== "1") return;
                const red = t.red && gxIndex === line.length - 1 && gyIndex === glyph.length - 1;
                context.fillStyle = red ? `rgba(236,43,69,${0.8 * fade})` : `rgba(255,255,255,${0.16 * fade})`;
                context.fillRect(gx + gxIndex * size, gy + gyIndex * size, size, size);
              });
            });
          }
        }
      }
      // Red registration crosshairs at a few grid intersections.
      for (const [col, row] of marks) {
        const x = Math.round(x0 + col * tile) + 0.5;
        const y = Math.round(row * tile) + 0.5;
        const dx = (x - width / 2) / (width * 0.42);
        const dy = (y - height * 0.36) / (height * 0.5);
        const fade = Math.min(1, Math.max(0, Math.hypot(dx, dy) - 0.3));
        if (fade < 0.15) continue;
        context.strokeStyle = `rgba(236,43,69,${0.75 * fade})`;
        context.beginPath();
        context.moveTo(x - 5, y); context.lineTo(x + 6, y);
        context.moveTo(x, y - 5); context.lineTo(x, y + 6);
        context.stroke();
      }
      context.strokeStyle = "rgba(255,255,255,0.05)";
      context.lineWidth = 1;
      context.beginPath();
      for (let col = 0; col <= cols; col += 1) {
        const x = Math.round(x0 + col * tile) + 0.5;
        context.moveTo(x, 0);
        context.lineTo(x, height);
      }
      for (let row = 0; row <= rows; row += 1) {
        const y = Math.round(row * tile) + 0.5;
        context.moveTo(0, y);
        context.lineTo(width, y);
      }
      context.stroke();
    };

    let last = 0;
    let moved = false;
    // Tiles under the pointer light up red and fade back.
    canvas.parentElement.addEventListener("pointermove", (event) => {
      if (reduced) return;
      const rect = canvas.getBoundingClientRect();
      const col = Math.floor((event.clientX - rect.left - x0) / tile);
      const row = Math.floor((event.clientY - rect.top) / tile);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const t = tiles[(row + dy) * cols + (col + dx)];
          if (!t || col + dx < 0 || col + dx >= cols) continue;
          const centre = dx === 0 && dy === 0;
          t.target = centre ? 0.16 : Math.max(t.target, 0.05);
          t.hot = centre;
        }
      }
    });
    const animate = (now) => {
      if (!visible) return;
      if (now - last > 45) {
        last = now;
        for (let i = 0; i < 5; i += 1) {
          const t = tiles[Math.floor(Math.random() * tiles.length)];
          if (t) { t.target = Math.random() < 0.45 ? 0 : 0.03 + Math.random() * 0.08; t.hot = Math.random() < 0.06; }
        }
        // Now and then a glyph moves to another tile.
        if (Math.random() < 0.25) {
          const a = tiles[Math.floor(Math.random() * tiles.length)];
          const b = tiles[Math.floor(Math.random() * tiles.length)];
          if (a && b) [a.glyph, b.glyph] = [b.glyph, a.glyph];
          moved = true;
        }
      }
      let moving = moved;
      moved = false;
      for (const t of tiles) {
        const delta = t.target - t.fill;
        if (Math.abs(delta) > 0.0008) { t.fill += delta * 0.12; moving = true; }
        else if (t.hot && t.fill > 0.02) { t.target = 0; }
        if (t.fill < 0.004) t.hot = false;
      }
      if (moving) draw();
      requestAnimationFrame(animate);
    };

    layout();
    window.addEventListener("resize", () => { clearTimeout(canvas._t); canvas._t = setTimeout(layout, 120); });
    if (!reduced) {
      new IntersectionObserver(([entry]) => {
        const was = visible;
        visible = entry.isIntersecting;
        if (visible && !was) requestAnimationFrame(animate);
      }).observe(canvas);
      requestAnimationFrame(animate);
    }
  }

  // ---------- Live console ----------
  // A product window: the request types in, steps land on a timeline on the
  // right, then the answer card appears. Tabs switch between examples.
  const consoleEl = $(".console");
  if (consoleEl) {
    const scenarios = JSON.parse($("#console-data").textContent);
    const tabs = $$(".console-tab", consoleEl);
    const typed = $(".typed", consoleEl);
    const steps = $(".tl-steps", consoleEl);
    const card = $(".answer-card", consoleEl);
    const worked = $(".worked", consoleEl);
    const runBar = $(".run-bar i", consoleEl);
    let run = 0;
    let index = 0;
    let auto = !reduced;

    const cardHtml = (sc) => {
      const [head, ...rows] = sc.table;
      return `<div class="ac-who"><span class="ac-avatar"><img src="/assets/berry-logo.svg" alt="" width="10" height="15"></span>Berry<span class="ac-worked">Worked for ${sc.worked}</span></div>
        <p class="ac-title">${sc.title}</p>
        <p class="ac-text">${sc.text}</p>
        <table class="ac-table"><thead><tr><th>${head[0]}</th><th>${head[1]}</th></tr></thead><tbody>${rows.slice(0, 3).map((r, i) => `<tr${i === 0 ? ' class="is-first"' : ""}><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</tbody></table>
        <div class="ac-sources">${sc.sources.map((src, i) => `<span><b>${i + 1}</b>${src}</span>`).join("")}</div>`;
    };
    const stepHtml = (st) => `<li class="tl-step"><span class="tl-dot"></span><span class="tl-time">${st[0]}</span><span class="tl-title">${st[1]}</span><span class="tl-tag">${st[2]}</span></li>`;

    const play = async (next) => {
      const id = ++run;
      index = next;
      const sc = scenarios[index];
      tabs.forEach((tab, i) => {
        tab.setAttribute("aria-selected", String(i === index));
        tab.classList.remove("is-running");
      });
      // The active tab's underline fills left to right over this example's run.
      const runtime = 220 + 520 + sc.steps.length * 280 + 4200;
      tabs[index].style.setProperty("--run", `${runtime}ms`);
      void tabs[index].offsetWidth;
      if (!reduced) tabs[index].classList.add("is-running");
      steps.innerHTML = sc.steps.map(stepHtml).join("");
      card.innerHTML = cardHtml(sc);
      worked.textContent = sc.worked;
      const items = $$(".tl-step", steps);
      const progress = (n) => { if (runBar) runBar.style.width = `${(n / items.length) * 100}%`; steps.style.setProperty("--fill", `${Math.max(0, n - 1) / Math.max(1, items.length - 1) * 100}%`); };
      if (reduced) {
        typed.textContent = sc.prompt;
        typed.parentElement.classList.add("is-in");
        items.forEach((li) => li.classList.add("is-done"));
        card.classList.add("is-in");
        consoleEl.classList.add("is-done");
        progress(items.length);
        return;
      }
      card.classList.remove("is-in");
      consoleEl.classList.remove("is-done");
      progress(0);
      // The request pops in as a whole message, like Berry's reply does.
      const bubble = typed.parentElement;
      bubble.classList.remove("is-in");
      typed.textContent = sc.prompt;
      await sleep(220); // a beat of empty chat before the message arrives
      if (id !== run) return;
      void bubble.offsetWidth;
      bubble.classList.add("is-in");
      await sleep(520);
      if (id !== run) return;
      for (let i = 0; i < items.length; i += 1) {
        if (id !== run) return;
        items.forEach((li) => li.classList.remove("is-now"));
        if (i > 0) items[i - 1].classList.add("is-done");
        items[i].classList.add("is-now");
        progress(i + 1);
        await sleep(280);
      }
      if (id !== run) return;
      items.at(-1).classList.remove("is-now");
      items.at(-1).classList.add("is-done");
      consoleEl.classList.add("is-done");
      card.classList.add("is-in");
      await sleep(4200);
      if (id === run && auto) play((index + 1) % scenarios.length);
    };

    tabs.forEach((tab, i) => tab.addEventListener("click", () => play(i)));
    let started = false;
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !started) { started = true; play(0); }
    }, { threshold: 0.2 }).observe(consoleEl);
  }

  // ---------- Small loops in the bento ----------
  // Highlights one child at a time (tool chips, schedule rows, routes).
  $$("[data-cycle]").forEach((group) => {
    const items = $$(group.dataset.cycle, group);
    const hot = group.dataset.hot || "is-hot";
    let i = 0;
    if (items.length) items[0].classList.add(hot);
    whileVisible(group, Number(group.dataset.every || 1400), () => {
      items[i].classList.remove(hot);
      i = (i + 1) % items.length;
      items[i].classList.add(hot);
      if (group.dataset.link) {
        const target = $(group.dataset.link);
        const links = target ? $$("[data-key]", target) : [];
        const key = items[i].dataset.key;
        links.forEach((link) => link.classList.toggle("is-hot", link.dataset.key === key));
      }
    });
  });

  // Sandbox terminal: types a short session, then starts again.
  $$("[data-term]").forEach((term) => {
    const lines = JSON.parse(document.getElementById(term.dataset.term).textContent);
    const render = (count, partial = "") =>
      lines.slice(0, count).map((line) => line.html).join("\n") + (partial ? `${count ? "\n" : ""}${partial}` : "");
    if (reduced) { term.innerHTML = render(lines.length); return; }
    let busy = false;
    const loop = async () => {
      if (busy) return;
      busy = true;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.type) {
          for (let c = 1; c <= line.type.length; c += 1) {
            term.innerHTML = render(i, `<span class="p">$</span> ${line.type.slice(0, c)}<span class="caret"></span>`);
            await sleep(34);
          }
        }
        term.innerHTML = render(i + 1);
        await sleep(line.type ? 380 : 260);
      }
      await sleep(3200);
      busy = false;
    };
    loop();
    whileVisible(term, 900, loop);
  });

  // Approval card flips between waiting and approved.
  $$("[data-approve]").forEach((card) => {
    const state = $(".approve-state", card);
    let approved = false;
    whileVisible(card, 2600, () => {
      approved = !approved;
      card.classList.toggle("is-approved", approved);
      state.textContent = approved ? "approved by j.lee · 14:02" : "waiting for approval";
    });
  });

  // Audit ticker: new events slide in at the top.
  $$("[data-audit]").forEach((list) => {
    const events = JSON.parse(document.getElementById(list.dataset.audit).textContent);
    let i = 0;
    let clock = 14 * 3600 + 2 * 60;
    const add = () => {
      const [who, act] = events[i % events.length];
      i += 1;
      clock += 7 + Math.floor(Math.random() * 40);
      const h = String(Math.floor(clock / 3600) % 24).padStart(2, "0");
      const m = String(Math.floor(clock / 60) % 60).padStart(2, "0");
      const s = String(clock % 60).padStart(2, "0");
      const row = document.createElement("div");
      row.className = "audit-row";
      row.innerHTML = `<time>${h}:${m}:${s}</time><span class="act">${act}</span><span class="who">${who}</span>`;
      list.prepend(row);
      while (list.children.length > 8) list.lastElementChild.remove();
    };
    for (let n = 0; n < 6; n += 1) add();
    whileVisible(list, 2200, add);
  });
})();

// Bento visuals: pointer spotlight, orbit routes, approval sequence, ranked
// retrieval, pixel painting, permission toggles and the router wires.
(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const onScreen = (element, ms, tick) => {
    if (!element || reduced) return;
    let timer = 0;
    new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry.isIntersecting) { tick(); timer = setInterval(tick, ms); }
    }).observe(element);
  };

  // Spotlight
  $$(".tile").forEach((tile) => {
    tile.addEventListener("pointermove", (event) => {
      const rect = tile.getBoundingClientRect();
      tile.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      tile.style.setProperty("--my", `${event.clientY - rect.top}px`);
    });
  });

  // Orbit: links from the hub to each node, one lit at a time.
  $$("[data-orbit]").forEach((orbit) => {
    const nodes = $$(".o-node", orbit);
    const status = orbit.querySelector(".o-hub .status");
    // Drawn in real pixels from the stage's size, so rings stay round and
    // lines stay hairline-thin at any width.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "links");
    svg.setAttribute("aria-hidden", "true");
    orbit.prepend(svg);
    let pulses = [];
    const draw = () => {
      const w = orbit.clientWidth;
      const h = orbit.clientHeight;
      if (!w) return;
      const cx = w / 2;
      const cy = h / 2;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const rings = [0.2, 0.31, 0.42].map((k, n) => `<ellipse class="ring-l" cx="${cx}" cy="${cy}" rx="${w * k}" ry="${h * (k + 0.14)}"${n === 1 ? ' style="opacity:.5"' : ""}/>`).join("");
      const ticks = Array.from({ length: 48 }, (_, n) => {
        const angle = (n / 48) * Math.PI * 2;
        const x = cx + Math.cos(angle) * w * 0.42;
        const y = cy + Math.sin(angle) * h * 0.56;
        return `<rect class="ring-tick" x="${(x - 0.75).toFixed(1)}" y="${(y - 0.75).toFixed(1)}" width="1.5" height="1.5"/>`;
      }).join("");
      const dots = [0.6, 2.2, 3.9, 5.1].map((angle, n) => {
        const x = cx + Math.cos(angle) * w * 0.31;
        const y = cy + Math.sin(angle) * h * 0.45;
        return `<rect class="ring-dot" x="${(x - 2).toFixed(1)}" y="${(y - 2).toFixed(1)}" width="4" height="4" style="animation-delay:-${n * 0.6}s"/>`;
      }).join("");
      const links = nodes.map((node) => {
        const x = (parseFloat(node.style.left) / 100) * w;
        const y = (parseFloat(node.style.top) / 100) * h;
        const d = `M${cx} ${cy} C${(cx + x) / 2} ${cy} ${(cx + x) / 2} ${y} ${x} ${y}`;
        return `<path class="link" d="${d}"/><path class="pulse" pathLength="100" d="${d}"/>`;
      }).join("");
      const hot = pulses.findIndex((pulse) => pulse.classList.contains("is-hot"));
      svg.innerHTML = rings + ticks + dots + links;
      pulses = $$(".pulse", svg);
      if (hot >= 0) pulses[hot].classList.add("is-hot");
    };
    draw();
    new ResizeObserver(draw).observe(orbit);
    let i = -1;
    const step = () => {
      nodes.forEach((node) => node.classList.remove("is-hot"));
      pulses.forEach((pulse) => pulse.classList.remove("is-hot"));
      i = (i + 1) % nodes.length;
      nodes[i].classList.add("is-hot");
      pulses[i]?.classList.add("is-hot");
      if (status) status.textContent = nodes[i].dataset.status || "";
    };
    if (reduced) { step(); return; }
    onScreen(orbit, 1700, step);
  });

  // Approval: waiting → pressed → running → done.
  $$("[data-approval]").forEach((card) => {
    const state = card.querySelector(".ap-state");
    const labels = ["waiting for approval", "approving…", "running in sandbox", "exit 0 · 2.1s"];
    let step = 0;
    const show = () => { card.dataset.step = String(step); state.textContent = labels[step]; };
    if (reduced) { step = 3; show(); return; }
    onScreen(card, 1500, () => { step = (step + 1) % labels.length; show(); });
  });

  // Ranked retrieval: scores shift and the best match changes.
  $$("[data-rank]").forEach((list) => {
    const rows = $$(".rank-row", list);
    const shuffle = () => {
      const scores = rows.map(() => 0.42 + Math.random() * 0.55);
      const top = scores.indexOf(Math.max(...scores));
      rows.forEach((row, index) => {
        row.querySelector(".bar-fill").style.setProperty("--w", `${Math.round(scores[index] * 100)}%`);
        row.querySelector(".s").textContent = scores[index].toFixed(2);
        row.classList.toggle("is-top", index === top);
      });
    };
    shuffle();
    onScreen(list, 2400, shuffle);
  });

  // Dot-matrix renderer: samples a picture or text into fine squares on a
  // canvas at device resolution, then reveals the dots in a random order.
  const dotMatrix = (canvas, { draw, cell, reveal = "random", loop = false, grid = false, onProgress }) => {
    const context = canvas.getContext("2d");
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    let dots = [];
    let shown = 0;
    let timer = 0;
    let cols = 0;
    let rowsN = 0;
    let frame = 0;
    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      const off = document.createElement("canvas");
      off.width = Math.ceil(rect.width / cell);
      off.height = Math.ceil(rect.height / cell);
      cols = off.width;
      rowsN = off.height;
      const o = off.getContext("2d", { willReadFrequently: true });
      draw(o, off.width, off.height);
      const data = o.getImageData(0, 0, off.width, off.height).data;
      dots = [];
      for (let y = 0; y < off.height; y += 1) {
        for (let x = 0; x < off.width; x += 1) {
          const i = (y * off.width + x) * 4;
          const alpha = data[i + 3];
          if (alpha < 90) continue;
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          // Red stays Berry red; anything else (the leaves) becomes warm white.
          const red = r > g * 1.5 && r > b * 1.5;
          const dark = (r + g + b) / 3 < 60;
          dots.push({ x, y, born: -99, colour: red ? (r < 170 ? "#7e1a29" : "#b92338") : dark ? "#2e2929" : "#bdb7b2" });
        }
      }
      if (reveal === "random") dots.sort(() => Math.random() - 0.5);
      else dots.sort((a, b) => a.x - b.x + (Math.random() - 0.5) * 6);
      shown = reduced ? dots.length : 0;
      paint();
    };
    const paint = () => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const size = Math.max(1, cell - 1);
      // The empty canvas: every cell as a faint square, like a sensor grid.
      if (grid) {
        context.fillStyle = "#171414";
        for (let y = 0; y < rowsN; y += 1) for (let x = 0; x < cols; x += 1) context.fillRect(x * cell, y * cell, size, size);
      }
      for (let i = 0; i < shown; i += 1) {
        const dot = dots[i];
        const age = frame - dot.born;
        // Newly placed dots flash white, then settle into their colour.
        context.globalAlpha = Math.min(1, 0.25 + age * 0.15);
        context.fillStyle = dot.colour;
        context.fillRect(dot.x * cell, dot.y * cell, size, size);
        context.globalAlpha = 1;
      }
      // A scanline sweeps down while the picture is still rendering.
      if (grid && shown < dots.length) {
        const y = ((frame * 1.5) % (rowsN * cell + 40)) - 20;
        context.fillStyle = "rgba(236,43,69,0.35)";
        context.fillRect(0, y, cols * cell, 1);
        context.fillStyle = "rgba(236,43,69,0.04)";
        context.fillRect(0, y - 12, cols * cell, 12);
      }
      onProgress?.(dots.length ? shown / dots.length : 1);
    };
    const step = () => {
      frame += 1;
      if (shown < dots.length) {
        const next = Math.min(dots.length, shown + Math.max(3, Math.round(dots.length / 130)));
        for (let i = shown; i < next; i += 1) dots[i].born = frame;
        shown = next;
        paint();
        return;
      }
      timer += 1;
      if (timer < 8) paint(); // let the last dots finish fading in
      if (loop && timer > 110) { timer = 0; shown = 0; dots.sort(() => Math.random() - 0.5); paint(); }
    };
    layout();
    window.addEventListener("resize", () => { clearTimeout(canvas._t); canvas._t = setTimeout(layout, 150); });
    if (document.fonts) document.fonts.ready.then(layout);
    if (!reduced) onScreen(canvas, 40, step);
  };

  $$("[data-paint]").forEach((box) => {
    const canvas = box.querySelector("canvas");
    const meta = box.querySelector(".paint-meta b");
    const image = new Image();
    image.onload = () => dotMatrix(canvas, {
      cell: 4,
      loop: true,
      grid: true,
      draw: (o, w, h) => {
        const scale = Math.min(w / image.width, h / image.height) * 0.86;
        const iw = image.width * scale;
        const ih = image.height * scale;
        o.drawImage(image, (w - iw) / 2, (h - ih) / 2, iw, ih);
      },
      onProgress: (p) => { if (meta) meta.textContent = `${Math.round(p * 100)}%`; },
    });
    image.src = box.dataset.paint;
  });


  // Durable runs: a worker restarts mid-task and another resumes the same step.
  $$("[data-durable]").forEach((box) => {
    const rows = $$(".du-row", box);
    const steps = $$(".du-steps span", box);
    const note = box.querySelector(".du-note");
    let t = 0;
    const render = () => {
      const step = Math.min(steps.length - 1, Math.floor(t / 2));
      const crashed = t >= 5 && t < 7;
      const owner = t >= 7 ? 1 : 0;
      rows.forEach((row, i) => {
        const bar = row.querySelector(".du-bar");
        const state = row.querySelector(".du-state");
        row.classList.toggle("is-down", i === 0 && crashed);
        if (i === 0) { bar.style.width = crashed ? "100%" : owner === 0 ? `${(t % 2) * 50 + 30}%` : "0%"; state.textContent = crashed ? "restarted" : owner === 0 ? "running" : "idle"; }
        else { bar.style.width = owner === 1 ? `${(t % 2) * 50 + 30}%` : "0%"; state.textContent = owner === 1 ? (t < 9 ? "resumed" : "running") : "idle"; }
      });
      steps.forEach((el, i) => { el.classList.toggle("is-done", i < step); el.classList.toggle("is-now", i === step); });
      note.innerHTML = crashed ? `worker lost · step <b>${step + 1}</b> kept in Postgres` : t >= 7 && t < 9 ? `resumed at step <b>${step + 1}</b> · nothing redone` : `step <b>${step + 1}</b> of ${steps.length} · saved to Postgres`;
    };
    render();
    if (reduced) return;
    onScreen(box, 900, () => { t = (t + 1) % 14; render(); });
  });

  // Permission toggles flip one by one.
  $$("[data-toggles]").forEach((list) => {
    const items = $$(".toggle", list);
    let i = 0;
    onScreen(list, 1300, () => { items[i].classList.toggle("is-on"); i = (i + 1) % items.length; });
  });

  // Router: wires drawn from the real positions of the cards.
  $$(".router").forEach((router) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "router-wires");
    svg.setAttribute("aria-hidden", "true");
    router.prepend(svg);
    const sources = $$(".sources .provider", router);
    const providers = $$(".providers .provider", router);
    const core = router.querySelector(".node.is-core");
    const routes = $$(".route-row", router);
    let hot = [];
    const draw = () => {
      const base = router.getBoundingClientRect();
      const c = core.getBoundingClientRect();
      const curve = (x1, y1, x2, y2) => `M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;
      const inLeft = [];
      const out = [];
      sources.forEach((source, index) => {
        const r = source.getBoundingClientRect();
        const y2 = c.top - base.top + c.height * (0.3 + 0.4 * (index / Math.max(1, sources.length - 1)));
        inLeft.push(curve(r.right - base.left, r.top - base.top + r.height / 2, c.left - base.left, y2));
      });
      providers.forEach((provider) => {
        const r = provider.getBoundingClientRect();
        out.push(curve(c.right - base.left, c.top - base.top + c.height / 2, r.left - base.left, r.top - base.top + r.height / 2));
      });
      svg.setAttribute("viewBox", `0 0 ${base.width} ${base.height}`);
      svg.innerHTML = [...inLeft, ...out].map((d) => `<path class="w" d="${d}"/>`).join("") +
        inLeft.map((d, i) => `<path class="w-hot" data-in="${i}" pathLength="100" d="${d}"/>`).join("") +
        out.map((d, i) => `<path class="w-hot" data-out="${providers[i].dataset.key}" pathLength="100" d="${d}"/>`).join("");
      light();
    };
    const light = () => {
      $$(".w-hot", svg).forEach((path) => path.classList.toggle("is-hot", hot.includes(path.dataset.in) || hot.includes(`o:${path.dataset.out}`)));
    };
    let i = -1;
    const step = () => {
      routes.forEach((row) => row.classList.remove("is-hot"));
      providers.forEach((row) => row.classList.remove("is-hot"));
      i = (i + 1) % routes.length;
      const route = routes[i];
      route.classList.add("is-hot");
      providers.forEach((row) => row.classList.toggle("is-hot", row.dataset.key === route.dataset.key));
      hot = [route.dataset.src, `o:${route.dataset.key}`];
      light();
    };
    draw();
    window.addEventListener("resize", () => { clearTimeout(svg._t); svg._t = setTimeout(draw, 150); });
    if (document.fonts) document.fonts.ready.then(draw);
    if (reduced) { step(); return; }
    onScreen(router, 1800, step);
  });
})();
