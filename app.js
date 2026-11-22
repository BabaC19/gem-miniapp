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
 *
 * API mode: when API_BASE below is filled in (Cloudflare Worker relay
 * deployed), actions instead travel app -> Worker -> bot and the bot
 * answers in-app with the reply + a fresh payload, so the app is never
 * force-closed the way sendData closes it. sendData stays as fallback.
 */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  // Diisi pas deploy Worker (URL https://...workers.dev). Kosong = mode sendData.
  var API_BASE = "https://gem-api.muhamadikmal3456.workers.dev";

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

  /* Early-claim availability, mirroring bot.py session_available():
   * accrual since the last-claim watermark at the locked rate, capped
   * at what is left of the session target, never negative. */
  function availableOf(s, now) {
    if (!s) return 0;
    var t = Math.min(now, s.end_ts);
    var last = s.last_claim_ts || s.start_ts;
    var since = (s.rate_per_hour || 10) * Math.max(0, t - last) / 3600;
    var remaining = s.full_amount - (s.claimed_total || 0);
    return Math.max(0, Math.min(since, remaining));
  }

  function stateFromPayload(p) {
    var rate = Number(p.rate_per_hour) || 10;
    var full = Number(p.session_full) || 80;
    var session = null;
    if (p.session && p.session.start_ts && p.session.end_ts) {
      // A running session mines at its own LOCKED rate (from when it
      // started), which may differ from the user's current-level rate.
      var sRate = Number(p.session.rate_per_hour) || rate;
      var sFull = Number(p.session.full_amount) || full;
      session = {
        start_ts: Number(p.session.start_ts),
        end_ts: Number(p.session.end_ts),
        rate_per_hour: sRate,
        full_amount: sFull,
        claimed_total: Number(p.session.claimed_total) || 0,
        last_claim_ts: Number(p.session.last_claim_ts) || Number(p.session.start_ts),
        min_claim: Number(p.session.min_claim) || 1,
        claimable: Date.now() / 1000 >= Number(p.session.end_ts),
        accrued: 0
      };
      session.accrued = accruedOf(session, sRate, sFull);
      if (session.claimable) {
        // The final claim pays only the remainder after early claims.
        session.accrued = Math.max(0, sFull - session.claimed_total);
      }
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
      wallet: p.wallet && p.wallet.address ? String(p.wallet.address) : null,
      walletVerified: !!(p.wallet && p.wallet.verified),
      walletPending: !!(p.wallet && p.wallet.pending),
      verify: p.verify && typeof p.verify === "object" ? p.verify : null,
      withdraw: p.withdraw && typeof p.withdraw === "object" ? p.withdraw : null,
      tasks: Array.isArray(p.tasks) ? p.tasks : [],
      level: p.level && typeof p.level === "object" ? p.level : null,
      idleFull: session ? null : full,
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

    renderWallet();
    renderWithdraw();
    renderLevel();
    renderTasks();

    // Mining tab: three mutually exclusive states.
    $("miningIdle").classList.toggle("hidden", !!s);
    $("miningRunning").classList.toggle("hidden", !s || s.claimable);
    $("miningDone").classList.toggle("hidden", !s || !s.claimable);
    document.body.classList.toggle("is-mining", !!s && !s.claimable);
    document.body.classList.toggle("is-done", !!s && s.claimable);

    if (s && s.claimable) {
      $("doneAmount").textContent = fmtPoints(s.accrued) + " GEM";
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
    $("refEarnings").textContent = fmtPoints(state.referral ? state.referral.earnings : 0) + " GEM";

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
      pts.textContent = fmtPoints(row.balance) + " GEM";
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

  /* Live counter format: 4 decimals so the mined amount visibly runs
   * (at 10 GEM/hour the 4th decimal moves several times per second). */
  function fmtLive(n) {
    return Number(n || 0).toLocaleString("en-US", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
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
      s.accrued = Math.max(0, s.full_amount - (s.claimed_total || 0));
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
    $("statAccrued").textContent = fmtLive(accrued) + " GEM";
    $("statElapsed").textContent = fmtDuration(elapsed);
    $("statRemaining").textContent = fmtDuration(s.end_ts - now);
    $("statTarget").textContent = fmtPoints(s.full_amount) + " GEM";

    // Early-claim button: live amount, enabled once it reaches the
    // session's minimum (1 GEM); the bot re-checks server-side anyway.
    var avail = availableOf(s, now);
    var earlyBtn = $("btnEarlyClaim");
    if (earlyBtn) {
      if (avail >= (s.min_claim || 1)) {
        earlyBtn.disabled = false;
        earlyBtn.textContent = "💰 Klaim " + fmtLive(avail) + " GEM";
      } else {
        earlyBtn.disabled = true;
        earlyBtn.textContent = "Klaim (min. 1 GEM)";
      }
    }
  }

  function startTicker() {
    stopTicker();
    tickTimer = setInterval(tick, 100);
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

  /* ---------------- wallet card ---------------- */
  function shortAddr(a) {
    if (!a) return "";
    return a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
  }

  function walletNote(msg) {
    var el = $("walletNote");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    setTimeout(function () { el.classList.add("hidden"); }, 6000);
  }

  function renderWallet() {
    var on = !!state.wallet;
    $("walletOff").classList.toggle("hidden", on);
    $("walletOn").classList.toggle("hidden", !on);
    if (!on) return;
    $("walletAddr").textContent = shortAddr(state.wallet);
    $("walletBadge").textContent = state.walletVerified ? " 🛡️ Terverifikasi" : "";
    // Verify step: only while connected, unverified, not already
    // pending, and the bot actually sent a verify object (it doesn't
    // when GEM_PROJECT_WALLET is unset or right after a fresh connect
    // in this page session — reopening the app brings a fresh payload).
    var showVerify = !state.walletVerified && !state.walletPending && !!state.verify;
    $("walletVerify").classList.toggle("hidden", !showVerify);
    $("walletPending").classList.toggle(
      "hidden", !(state.walletPending && !state.walletVerified));
  }

  /* Indonesian-style number for the withdraw card: 7500 -> "7.500"
   * (fmtPoints with the thousand/decimal separators swapped). */
  function fmtId(n) {
    return fmtPoints(n)
      .replace(/,/g, "\u0001")
      .replace(/\./g, ",")
      .replace(/\u0001/g, ".");
  }

  /* ---------------- withdraw (request queue) ----------------
   * The GEM jetton is not launched yet: a withdraw here only files a
   * request — the bot locks the amount out of the balance and queues
   * it for manual processing at distribution. Client-side checks are
   * loose hints; the bot re-validates everything server-side. */
  function wdNote(msg) {
    var el = $("wdNote");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    setTimeout(function () { el.classList.add("hidden"); }, 6000);
  }

  function renderWithdraw() {
    var wd = state.withdraw;
    var min = wd && wd.min ? Number(wd.min) : 7500;
    $("wdBalance").textContent = fmtId(state.balance) + " GEM";
    $("wdAddress").textContent = state.wallet ? shortAddr(state.wallet) : "—";
    $("wdMinNote").textContent = "Minimal withdraw " + fmtId(min) + " GEM.";

    var pending = wd && wd.pending ? wd.pending : null;
    $("wdForm").classList.toggle("hidden", !!pending);
    var pEl = $("wdPending");
    pEl.classList.toggle("hidden", !pending);
    if (pending) {
      pEl.textContent = "⏳ Withdraw pending: " + fmtId(pending.amount)
        + " GEM — lagi antri diproses.";
    }

    var hist = wd && Array.isArray(wd.history) ? wd.history : [];
    $("wdHistory").classList.toggle("hidden", !hist.length);
    var list = $("wdHistoryList");
    list.innerHTML = "";
    hist.forEach(function (h) {
      var li = document.createElement("li");
      li.textContent = fmtId(h.amount) + " GEM · "
        + (h.status === "pending" ? "⏳ pending" : h.status);
      list.appendChild(li);
    });
  }

  $("btnWithdraw").addEventListener("click", function () {
    haptic("tap");
    var min = state.withdraw && state.withdraw.min
      ? Number(state.withdraw.min) : 7500;
    if (!state.wallet) {
      wdNote("Hubungkan wallet dulu di bagian 🔗 Wallet TON di atas ya.");
      return;
    }
    if (!state.walletVerified) {
      wdNote("Wallet kamu belum terverifikasi — verifikasi dulu ya (0,05 TON).");
      return;
    }
    if (state.withdraw && state.withdraw.pending) {
      wdNote("Masih ada request withdraw yang pending — tunggu diproses dulu ya.");
      return;
    }
    var amount = parseFloat(String($("wdAmount").value || "").replace(",", "."));
    if (!amount || isNaN(amount) || amount < min) {
      haptic("error");
      wdNote("Minimal withdraw " + fmtId(min) + " GEM.");
      return;
    }
    if (amount > state.balance) {
      haptic("error");
      wdNote("Saldo GEM kamu nggak cukup.");
      return;
    }
    if (!sendAction({ action: "withdraw", amount: amount },
                    function () { applyOptimistic("withdraw", amount); })) {
      wdNote("Buka Mini App dari tombol 🎮 Main GEM di chat bot ya.");
    } else {
      toast("🧾 Withdraw terkirim — konfirmasi final ada di chat.");
    }
  });

  /* ---------------- level card ---------------- */
  function renderLevel() {
    var card = $("levelCard");
    if (!card) return;
    var lv = state.level;
    if (!lv) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    $("levelBadge").textContent = "⭐ Lv " + lv.level;
    $("levelMult").textContent = "pengkali ×" + fmtPoints(lv.multiplier);
    $("levelRate").textContent = fmtPoints(lv.rate_per_hour) + " GEM/jam";
    // The level comes from GEM held in the TON wallet (on-chain),
    // never from the in-app balance.
    $("levelHoldings").textContent = fmtPoints(lv.holdings || 0) + " GEM";
    $("levelLiveNote").classList.toggle("hidden", !!lv.live);
    var frac = Math.min(1, Math.max(0, Number(lv.progress_frac) || 0));
    $("levelBar").style.width = (frac * 100).toFixed(1) + "%";
    if (lv.next_level) {
      $("levelNext").textContent = fmtPoints(lv.holdings || 0) + " / "
        + fmtPoints(lv.next_threshold) + " GEM ke Lv " + lv.next_level
        + " — makin banyak GEM kamu simpan di wallet, makin cepat mining-nya!";
    } else {
      $("levelNext").textContent = "Level MAX 🔥 — pengkali tertinggi!";
    }
    if (state.idleFull != null) {
      $("idleFull").textContent = fmtPoints(state.idleFull) + " GEM";
    }
  }

  /* ---------------- tasks ---------------- */
  var TASK_ICONS = {
    wallet_connect: "🔗",
    first_claim: "⛏️",
    referral_1: "👥",
    join_channel: "📣",
    follow_x: "🐦"
  };

  function renderTasks() {
    var list = $("taskList");
    if (!list) return;
    list.innerHTML = "";
    var tasks = state.tasks || [];
    if (!tasks.length) {
      var empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Belum ada tugas saat ini. Cek lagi nanti ya. 💎";
      list.appendChild(empty);
      return;
    }
    tasks.forEach(function (t) {
      var card = document.createElement("div");
      card.className = "task-card" + (t.state === "locked" ? " locked" : "")
        + (t.state === "claimed" ? " claimed" : "");

      var icon = document.createElement("span");
      icon.className = "task-icon";
      icon.textContent = TASK_ICONS[t.id] || "📋";

      var main = document.createElement("div");
      main.className = "task-main";
      var title = document.createElement("div");
      title.className = "task-title";
      title.textContent = t.title;
      var desc = document.createElement("div");
      desc.className = "task-desc";
      desc.textContent = t.desc;
      var chip = document.createElement("span");
      chip.className = "task-reward";
      chip.textContent = "+" + fmtPoints(t.reward) + " GEM";
      main.appendChild(title);
      main.appendChild(desc);
      main.appendChild(chip);

      var actions = document.createElement("div");
      actions.className = "task-actions";
      if (t.state === "claimed") {
        var done = document.createElement("span");
        done.className = "task-state done";
        done.textContent = "✅ Selesai";
        actions.appendChild(done);
      } else if (t.state === "ready") {
        if (t.url) {
          var open = document.createElement("button");
          open.className = "btn btn-task-open";
          open.textContent = "Buka";
          open.addEventListener("click", function () {
            haptic("tap");
            openExternal(t.url);
          });
          actions.appendChild(open);
        }
        var claim = document.createElement("button");
        claim.className = "btn btn-task";
        claim.textContent = "Klaim +" + fmtPoints(t.reward);
        claim.addEventListener("click", function () {
          haptic("tap");
          if (!sendAction({ action: "task", task_id: t.id },
                          function () { applyOptimistic("task", t); })) {
            fallbackHint();
          } else {
            toast("✅ Klaim terkirim — konfirmasi final ada di chat.");
          }
        });
        actions.appendChild(claim);
      } else {
        var lock = document.createElement("span");
        lock.className = "task-state locked";
        lock.textContent = "🔒 Belum terpenuhi";
        actions.appendChild(lock);
      }

      card.appendChild(icon);
      card.appendChild(main);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function openExternal(url) {
    try {
      if (tg && typeof tg.openLink === "function") { tg.openLink(url); return; }
    } catch (e) { /* fall through */ }
    window.open(url, "_blank");
  }

  /* ---------------- actions: back to the bot ------------------ */
  // Two transports, one entry point (sendAction):
  //
  // 1) API relay (preferred when API_BASE is set): the action goes to
  //    the Cloudflare Worker, the bot polls it there, runs the same
  //    action cores as always, and answers with the one-line reply +
  //    a FRESH payload. The payload replaces `state` wholesale, so
  //    the still-open app stays exact — and the app is never closed,
  //    unlike sendData, after which Telegram closes a keyboard-
  //    launched Mini App (the bug this mode exists to fix).
  //
  // 2) sendData (fallback): only exists for web apps opened from a
  //    reply-keyboard button; anywhere else it throws or is missing
  //    -> caller shows a hint. The bot's chat reply is then the
  //    confirmation and the next open brings a fresh payload.
  //
  // Either way the UI first updates optimistically (applyOptimistic).
  function sendDataOnly(obj) {
    if (!tg || typeof tg.sendData !== "function") return false;
    try {
      tg.sendData(JSON.stringify(obj));
    } catch (e) {
      return false;
    }
    return true;
  }

  var sending = false; // in-flight guard against double-taps

  var API_POLL_TRIES = 20;  // 20 x 800ms = ~16s for the bot to answer
  var API_POLL_MS = 800;

  function apiAvailable() {
    return !!API_BASE && !!tg && !!tg.initData
      && typeof window.fetch === "function";
  }

  function newActionId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (e) { /* fall through to the manual id */ }
    return "a-" + Date.now().toString(36) + "-"
      + Math.floor(Math.random() * 1e9).toString(36);
  }

  function apiDone(reply, payload) {
    if (payload) {
      var fresh = stateFromPayload(payload);
      if (fresh) state = fresh;
    }
    render();
    toast(reply || "✅ Berhasil.");
    sending = false;
  }

  function apiFallback(obj) {
    // The relay POST failed or no answer landed in time: deliver the
    // action the old way. The optimistic update is already on screen;
    // the bot re-validates everything server-side, so even if the
    // relay copy ALSO gets processed later, the duplicate is rejected
    // or a no-op (claims, tasks and withdrawals are all guarded).
    if (sendDataOnly(obj)) {
      toast("⚠️ Koneksi API gagal — hasil dikirim lewat chat.");
    } else {
      toast("⚠️ Koneksi lagi bermasalah — coba lagi ya.");
    }
    sending = false;
  }

  function apiPoll(id, obj, triesLeft) {
    window.fetch(API_BASE + "/result/" + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.status === "done") {
          apiDone(res.reply, res.payload);
          return;
        }
        throw new Error("pending");
      })
      .catch(function () {
        if (triesLeft > 1) {
          setTimeout(function () { apiPoll(id, obj, triesLeft - 1); }, API_POLL_MS);
        } else {
          apiFallback(obj);
        }
      });
  }

  function apiSend(obj) {
    var id = newActionId();
    window.fetch(API_BASE + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, initData: tg.initData, data: obj })
    }).then(function (r) {
      if (!r.ok) throw new Error("relay rejected the action");
      apiPoll(id, obj, API_POLL_TRIES);
    }).catch(function () {
      apiFallback(obj);
    });
  }

  function sendAction(obj, applyFn) {
    if (sending) return true; // a send is already landing; swallow the tap
    if (apiAvailable()) {
      // Relay path: paint the optimistic update now; the bot's reply
      // toast + fresh payload land when the poll completes. The
      // in-flight flag stays up until then so actions can't interleave.
      sending = true;
      if (applyFn) applyFn();
      render();
      apiSend(obj);
      return true;
    }
    if (!sendDataOnly(obj)) return false;
    sending = true;
    if (applyFn) applyFn();
    render();
    sending = false;
    return true;
  }

  /* Optimistic local state updates, mirroring the server's rules, so
   * the still-open app stays correct until the next fresh payload. */
  function applyOptimistic(kind, data) {
    var now = Date.now() / 1000;
    if (kind === "start") {
      var rate = state.level && state.level.rate_per_hour
        ? Number(state.level.rate_per_hour) : 10;
      state.session = {
        start_ts: now,
        end_ts: now + 8 * 3600,
        rate_per_hour: rate,
        full_amount: rate * 8,
        claimed_total: 0,
        last_claim_ts: now,
        min_claim: 1,
        claimable: false,
        accrued: 0
      };
      state.idleFull = null;
    } else if (kind === "claim") {
      var s = state.session;
      if (!s) return;
      if (s.claimable) {
        // Final claim: same formula as the server (full − claimed).
        state.balance += Math.max(0, s.full_amount - (s.claimed_total || 0));
        state.session = null;
        var nextRate = state.level && state.level.rate_per_hour
          ? Number(state.level.rate_per_hour) : 10;
        state.idleFull = nextRate * 8;
      } else {
        // Early claim: pay the live available amount, move the
        // watermark — availability restarts from ~0 and ticks up again.
        var amount = availableOf(s, now);
        if (amount <= 0) return;
        state.balance += amount;
        s.claimed_total = (s.claimed_total || 0) + amount;
        s.last_claim_ts = now;
      }
    } else if (kind === "task") {
      var t = data;
      if (!t || t.state === "claimed") return;
      t.state = "claimed";
      state.balance += Number(t.reward) || 0;
    } else if (kind === "withdraw") {
      var wdAmount = Number(data) || 0;
      if (!state.withdraw) {
        state.withdraw = { min: 7500, pending: null, history: [] };
      }
      state.balance -= wdAmount;
      state.withdraw.pending = { id: null, amount: wdAmount, created_ts: now };
      state.withdraw.history = [{
        amount: wdAmount, status: "pending", created_ts: now
      }].concat(state.withdraw.history || []);
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 3500);
  }

  function fallbackHint() {
    haptic("error");
    showError("Tombol ini cuma jalan kalau Mini App dibuka dari tombol 🎮 Main GEM di chat bot ya.");
  }

  $("btnStart").addEventListener("click", function () {
    haptic("tap");
    if (!sendAction({ action: "start" }, function () { applyOptimistic("start"); })) {
      fallbackHint();
    } else {
      toast("⛏️ Mining dimulai — konfirmasi ada di chat.");
    }
  });

  $("btnClaim").addEventListener("click", function () {
    haptic("tap");
    if (!sendAction({ action: "claim" }, function () { applyOptimistic("claim"); })) {
      fallbackHint();
    } else {
      toast("✅ Klaim terkirim — konfirmasi final ada di chat.");
    }
  });

  // Early claim while the session runs — same "claim" action; the bot
  // resolves early-vs-final itself from the session state, and so
  // does applyOptimistic (via session.claimable).
  $("btnEarlyClaim").addEventListener("click", function () {
    haptic("tap");
    if (!sendAction({ action: "claim" }, function () { applyOptimistic("claim"); })) {
      fallbackHint();
    } else {
      toast("✅ Klaim terkirim — konfirmasi final ada di chat.");
    }
  });

  /* ---------------- TonConnect (wallet) ----------------
   * Headless SDK use: we render our own buttons and only borrow the
   * SDK's modal + connection state. The SDK bundle exposes
   * TON_CONNECT_UI.toUserFriendlyAddress(raw, testnet) — verified
   * against the actual @tonconnect/ui dist — so the raw "0:..." address
   * from wallet.account is converted here (chain "-3" = testnet,
   * "-239" = mainnet); if the helper is ever missing we fall back to
   * the raw form, which bot.py also accepts and stores as-is. */
  var tcUI = null;

  function getTonConnectUI() {
    if (tcUI) return tcUI;
    if (typeof window.TON_CONNECT_UI === "undefined"
        || !window.TON_CONNECT_UI.TonConnectUI) {
      return null;
    }
    try {
      tcUI = new window.TON_CONNECT_UI.TonConnectUI({
        manifestUrl: "https://babac19.github.io/gem-miniapp/tonconnect-manifest.json"
      });
      tcUI.onStatusChange(function (wallet) {
        if (wallet && wallet.account && wallet.account.address) {
          onWalletConnected(wallet);
        }
      });
    } catch (e) {
      return null;
    }
    return tcUI;
  }

  function friendlyAddress(wallet) {
    var raw = wallet.account.address;
    try {
      if (typeof window.TON_CONNECT_UI.toUserFriendlyAddress === "function") {
        return window.TON_CONNECT_UI.toUserFriendlyAddress(
          raw, wallet.account.chain === "-3");
      }
    } catch (e) { /* fall through to raw */ }
    return raw;
  }

  function onWalletConnected(wallet) {
    var addr = friendlyAddress(wallet);
    if (state.wallet === addr) return; // already synced with the bot
    if (sendAction({ action: "wallet", address: addr }, function () {
      state.wallet = addr;
      state.walletVerified = false;
      state.walletPending = false;
    })) {
      renderWallet();
      haptic("success");
      walletNote("✅ Alamat terkirim — tersimpan di bot. Buka lagi Mini App-nya buat langkah verifikasi wallet ya. 🛡️");
    } else {
      walletNote("Buka Mini App dari tombol 🎮 Main GEM di chat bot biar alamat wallet-mu tersimpan ya.");
    }
  }

  /* Wallet verification: pay the one-time 0.05 TON fee to the project
   * wallet with the user's "GEM-<id>" comment payload. The bot's
   * on-chain checker matches the payment (comment + amount + sender)
   * and flips the verified flag; here we just send the transaction and
   * tell the bot it went out ("verify_sent"). */
  $("btnVerify").addEventListener("click", function () {
    haptic("tap");
    var v = state.verify;
    var ui = getTonConnectUI();
    if (!v || !ui) {
      walletNote("Langkah verifikasi belum tersedia — buka lagi Mini App-nya dari chat bot ya.");
      return;
    }
    var tx = {
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [{
        address: v.to,
        amount: String(v.amount_nanoton),
        payload: v.payload_boc
      }]
    };
    var sent;
    try {
      sent = ui.sendTransaction(tx);
    } catch (e) {
      haptic("error");
      walletNote("Transaksinya dibatalkan/gagal.");
      return;
    }
    Promise.resolve(sent).then(function () {
      if (sendAction({ action: "verify_sent" }, function () {
        state.walletPending = true;
      })) {
        renderWallet();
        haptic("success");
        walletNote("⏳ Pembayaran terkirim — lagi dicek di jaringan. Bot bakal ngabarin di chat kalo wallet kamu udah terverifikasi. 🛡️");
      } else {
        walletNote("Buka Mini App dari tombol 🎮 Main GEM di chat bot ya.");
      }
    }, function () {
      haptic("error");
      walletNote("Transaksinya dibatalkan/gagal.");
    });
  });

  $("btnWalletConnect").addEventListener("click", function () {
    haptic("tap");
    var ui = getTonConnectUI();
    if (!ui) {
      showError("SDK wallet gagal dimuat, coba lagi ya.");
      return;
    }
    try {
      ui.openModal();
    } catch (e) {
      showError("SDK wallet gagal dimuat, coba lagi ya.");
    }
  });

  $("btnWalletDisconnect").addEventListener("click", function () {
    haptic("tap");
    var ui = getTonConnectUI();
    if (ui) {
      try {
        var p = ui.disconnect();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) { /* best-effort */ }
    }
    if (sendAction({ action: "wallet_disconnect" }, function () {
      state.wallet = null;
      state.walletVerified = false;
      state.walletPending = false;
      state.verify = null;
    })) {
      renderWallet();
      walletNote("✅ Wallet diputuskan — alamatmu dihapus dari bot.");
    } else {
      walletNote("Buka Mini App dari tombol 🎮 Main GEM di chat bot ya.");
    }
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
