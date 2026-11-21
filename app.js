/* GEM Mining — Mini App logic (GitHub Pages + sendData edition).
 *
 * There is NO backend server for this page. The bot embeds a signed
 * per-user state snapshot in the URL fragment when it builds the
 * 🎮 Main GEM keyboard button:
 *
 *   https://<pages-url>/#s=<base64url(JSON)>&sig=<hex>
 *
 * The fragment never reaches any server. This page only *renders* that
 * payload (signature is NOT verified client-side — display only; the bot
 * re-validates every action against its database). Actions go back to
 * the bot with Telegram.WebApp.sendData(), which only works because the
 * page is opened from a reply-keyboard web_app button; the bot replies
 * in chat with the result and a fresh keyboard (fresh payload).
 */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  var $ = function (id) { return document.getElementById(id); };
  var state = null;       // render state, built from the URL payload
  var tickTimer = null;   // 1-second UI ticker while a session runs

  /* ---------------- formatting (mirrors bot.py) ---------------- */
  function fmtPoints(n) {
    n = Number(n) || 0;
    if (Number.isInteger(n)) return n.toLocaleString("en-US");
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return h + " jam " + m + " menit";
    if (m) return m + " menit " + s + " detik";
    return s + " detik";
  }

  function haptic(kind) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === "success") tg.HapticFeedback.notificationOccurred("success");
      else if (kind === "error") tg.HapticFeedback.notificationOccurred("error");
      else tg.HapticFeedback.impactOccurred("medium");
    } catch (e) { /* haptics are best-effort */ }
  }

  /* ---------------- payload (display-only snapshot from the bot) ------- */
  function parsePayload() {
    var hash = (location.hash || "").replace(/^#/, "");
    if (!hash) return null;
    var qs = new URLSearchParams(hash);
    var b64 = qs.get("s");
    if (!b64) return null;
    try {
      var bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var p = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      if (!p || p.v !== 1 || typeof p.balance !== "number") return null;
      return p;
    } catch (e) {
      return null;
    }
  }

  function accruedOf(session, rate, full) {
    if (!session) return 0;
    var elapsedH = Math.max(0, (Date.now() / 1000 - session.start_ts) / 3600);
    var hours = (session.end_ts - session.start_ts) / 3600;
    return Math.min(elapsedH, hours) * rate;
  }

  function stateFromPayload(p) {
    var rate = Number(p.rate_per_hour) || 10;
    var full = Number(p.session_full) || 80;
    var session = null;
    if (p.session && p.session.start_ts && p.session.end_ts) {
      session = {
        start_ts: Number(p.session.start_ts),
        end_ts: Number(p.session.end_ts),
        rate_per_hour: rate,
        full_amount: full,
        claimable: Date.now() / 1000 >= Number(p.session.end_ts),
        accrued: 0
      };
      session.accrued = accruedOf(session, rate, full);
    }
    var rows = (p.leaderboard || []).map(function (r, i) {
      return {
        rank: i + 1,
        name: r.name || "Miner",
        balance: Number(r.balance) || 0,
        is_you: !!p.name && (r.name === p.name)
      };
    });
    return {
      user: { id: p.uid, first_name: p.name || "Miner" },
      balance: Number(p.balance) || 0,
      session: session,
      referral: {
        link: p.referral && p.referral.link ? p.referral.link : null,
        invited: p.referral ? (p.referral.invited || 0) : 0,
        earnings: p.referral ? (Number(p.referral.earnings) || 0) : 0
      },
      leaderboard: rows,
      rank: p.my_rank || null
    };
  }

  /* ---------------- rendering ---------------- */
  function showScreen(which) {
    $("blocked").classList.toggle("hidden", which !== "blocked");
    $("loading").classList.toggle("hidden", which !== "loading");
    $("app").classList.toggle("hidden", which !== "app");
  }

  function render() {
    if (!state) return;
    var s = state.session;

    $("balanceValue").textContent = fmtPoints(state.balance);
    if (state.user && state.user.first_name) {
      $("userChip").textContent = "Halo, " + state.user.first_name + " 👋";
    }

    // Mining tab: three mutually exclusive states.
    $("miningIdle").classList.toggle("hidden", !!s);
    $("miningRunning").classList.toggle("hidden", !s || s.claimable);
    $("miningDone").classList.toggle("hidden", !s || !s.claimable);
    document.body.classList.toggle("is-mining", !!s && !s.claimable);
    document.body.classList.toggle("is-done", !!s && s.claimable);

    if (s && s.claimable) {
      $("doneAmount").textContent = fmtPoints(s.accrued) + " poin";
      $("claimAmount").textContent = fmtPoints(s.accrued);
      setRing(1);
    } else if (s) {
      tick(); // paints progress immediately; interval keeps it live
    } else {
      setRing(0);
    }

    // Referral tab.
    if (state.referral && state.referral.link) {
      $("refLink").value = state.referral.link;
      $("refLinkBox").classList.remove("hidden");
      $("refNoLink").classList.add("hidden");
    } else {
      $("refLinkBox").classList.add("hidden");
      $("refNoLink").classList.remove("hidden");
    }
    $("refInvited").textContent = state.referral ? state.referral.invited : 0;
    $("refEarnings").textContent = fmtPoints(state.referral ? state.referral.earnings : 0) + " poin";

    // Leaderboard tab.
    var list = $("boardList");
    list.innerHTML = "";
    var rows = state.leaderboard || [];
    if (!rows.length) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Belum ada miner. Jadilah yang pertama! 💎";
      list.appendChild(empty);
    }
    rows.forEach(function (row) {
      var li = document.createElement("li");
      if (row.is_you) li.className = "you";
      var medal = row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : row.rank + ".";
      var rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = medal;
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = row.name + (row.is_you ? " (kamu)" : "");
      var pts = document.createElement("span");
      pts.className = "pts";
      pts.textContent = fmtPoints(row.balance) + " poin";
      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(pts);
      list.appendChild(li);
    });
    var inTop = rows.some(function (r) { return r.is_you; });
    if (state.rank && !inTop) {
      $("myRank").classList.remove("hidden");
      $("myRank").textContent = "Peringkat kamu: #" + state.rank + " — terus mining biar masuk Top 10! 🚀";
    } else if (state.rank && inTop) {
      $("myRank").classList.remove("hidden");
      $("myRank").textContent = "Peringkat kamu: #" + state.rank + " — kamu ada di Top 10! 🔥";
    } else {
      $("myRank").classList.add("hidden");
    }
  }

  function setRing(frac) {
    var c = 2 * Math.PI * 100; // r=100 -> ~628.3
    $("ringFg").style.strokeDashoffset = String(c * (1 - Math.min(1, Math.max(0, frac))));
  }

  /* Live ticker: recomputes progress from the payload timestamps. */
  function tick() {
    if (!state || !state.session || state.session.claimable) return;
    var s = state.session;
    var now = Date.now() / 1000;

    if (now >= s.end_ts) {
      // Session over: flip to the claim state locally. The bot confirms
      // the real numbers in chat when the user taps Klaim.
      s.claimable = true;
      s.accrued = s.full_amount;
      render();
      haptic("success");
      return;
    }

    var total = s.end_ts - s.start_ts;
    var elapsed = Math.max(0, now - s.start_ts);
    var frac = total > 0 ? Math.min(1, elapsed / total) : 1;
    var accrued = Math.min(elapsed / 3600, total / 3600) * (s.rate_per_hour || 10);
    s.accrued = accrued;

    setRing(frac);
    $("progressBar").style.width = (frac * 100).toFixed(1) + "%";
    $("progressPct").textContent = Math.floor(frac * 100) + "%";
    $("statAccrued").textContent = fmtPoints(accrued) + " poin";
    $("statElapsed").textContent = fmtDuration(elapsed);
    $("statRemaining").textContent = fmtDuration(s.end_ts - now);
    $("statTarget").textContent = fmtPoints(s.full_amount) + " poin";
  }

  function startTicker() {
    stopTicker();
    tickTimer = setInterval(tick, 1000);
  }
  function stopTicker() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function showError(msg) {
    var el = $("miningError");
    el.textContent = "⚠️ " + msg;
    el.classList.remove("hidden");
    setTimeout(function () { el.classList.add("hidden"); }, 6000);
  }

  /* ---------------- actions: sendData back to the bot ------------------ */
  function sendAction(action) {
    // sendData only exists for web apps opened from a reply-keyboard
    // button; anywhere else it throws or is missing -> caller shows a hint.
    if (!tg || typeof tg.sendData !== "function") return false;
    try {
      tg.sendData(JSON.stringify({ action: action }));
    } catch (e) {
      return false;
    }
    // Give Telegram a beat to deliver the data, then close the app;
    // the bot posts the result (and a fresh keyboard) into the chat.
    setTimeout(function () { try { tg.close(); } catch (e) {} }, 200);
    return true;
  }

  function fallbackHint() {
    haptic("error");
    showError("Tombol ini cuma jalan kalau Mini App dibuka dari tombol 🎮 Main GEM di chat bot. Atau pakai tombol ⛏️ Mining / ✅ Klaim langsung di chat ya.");
  }

  $("btnStart").addEventListener("click", function () {
    haptic("tap");
    if (!sendAction("start")) fallbackHint();
  });

  $("btnClaim").addEventListener("click", function () {
    haptic("tap");
    if (!sendAction("claim")) fallbackHint();
  });

  $("btnCopy").addEventListener("click", function () {
    var input = $("refLink");
    function done() {
      $("copyOk").classList.remove("hidden");
      haptic("success");
      setTimeout(function () { $("copyOk").classList.add("hidden"); }, 2500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, function () {
        input.select();
        document.execCommand("copy");
        done();
      });
    } else {
      input.select();
      document.execCommand("copy");
      done();
    }
  });

  /* ---------------- tabs ---------------- */
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      $("panel-" + tab.getAttribute("data-tab")).classList.add("active");
      haptic("tap");
      if (tg && tg.HapticFeedback) { try { tg.HapticFeedback.selectionChanged(); } catch (e) {} }
    });
  });

  /* ---------------- boot ---------------- */
  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    var tp = tg.themeParams;
    var root = document.documentElement.style;
    if (tp.bg_color) root.setProperty("--tg-bg", tp.bg_color);
    if (tp.secondary_bg_color) root.setProperty("--tg-secondary-bg", tp.secondary_bg_color);
    if (tp.text_color) root.setProperty("--tg-text", tp.text_color);
    if (tp.hint_color) root.setProperty("--tg-hint", tp.hint_color);
    if (tp.button_color) root.setProperty("--tg-button", tp.button_color);
    if (tp.button_text_color) root.setProperty("--tg-button-text", tp.button_text_color);
    try { tg.setHeaderColor("secondary_bg_color"); } catch (e) {}
  }

  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) {}
    applyTheme();
  }

  var payload = parsePayload();
  if (!payload) {
    // No (valid) state snapshot: the page was opened directly or the link
    // is stale — it must be launched from the bot's 🎮 Main GEM button.
    showScreen("blocked");
    return;
  }
  state = stateFromPayload(payload);
  showScreen("app");
  render();
  startTicker();
})();
