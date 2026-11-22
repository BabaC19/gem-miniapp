/* GEM Mining — Mini App logic (direct API edition).
 *
 * The page talks to the GEM API server (API_BASE below) with plain
 * fetch(): every action is ONE request carrying Telegram's initData,
 * and the server answers in the same response with the one-line
 * reply + a fresh state payload. The payload replaces `state`
 * wholesale, so the still-open app stays exact. There is NO sendData
 * path anymore — Telegram closes the Mini App after sendData, which
 * was the old claim-restart bug.
 *
 * Launches: a keyboard-button launch may still carry a signed state
 * snapshot in the URL fragment (#s=<base64url(JSON)>&sig=<hex>) for
 * instant first paint; a Menu Button launch carries no fragment and
 * bootstraps its state with one API call instead.
 */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  // The GEM API server (Cloudflare Worker, synchronous backend).
  var API_BASE = "https://gem-api.muhamadikmal3456.workers.dev";

  /* Mining economics (mirror bot.py): the base level earns
   * BASE_DAILY_GEM per 24 hours; payload rates are per hour and the
   * UI presents earnings per day. Only used as fallbacks — the real
   * numbers always come from the payload. */
  var BASE_DAILY_GEM = 350;
  var BASE_RATE = BASE_DAILY_GEM / 24; // per hour, base level
  var SESSION_HOURS = 8;

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
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + s + "s";
    return s + "s";
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

  /* Early-claim availability, mirroring bot.py session_available():
   * accrual since the last-claim watermark at the locked rate, capped
   * at what is left of the session target, never negative. */
  function availableOf(s, now) {
    if (!s) return 0;
    var t = Math.min(now, s.end_ts);
    var last = s.last_claim_ts || s.start_ts;
    var since = (s.rate_per_hour || BASE_RATE) * Math.max(0, t - last) / 3600;
    var remaining = s.full_amount - (s.claimed_total || 0);
    return Math.max(0, Math.min(since, remaining));
  }

  function stateFromPayload(p) {
    var rate = Number(p.rate_per_hour) || BASE_RATE;
    var full = Number(p.session_full) || BASE_RATE * SESSION_HOURS;
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
        stopped: !!p.session.stopped,
        claim_deadline_ts: p.session.claim_deadline_ts ? Number(p.session.claim_deadline_ts) : null,
        accrued: 0
      };
      session.accrued = availableOf(session, Date.now() / 1000);
      if (session.claimable) {
        // The final claim pays only the remainder after early claims.
        session.accrued = Math.max(0, sFull - session.claimed_total);
      }
    }
    return {
      user: { id: p.uid, first_name: p.name || "Miner" },
      profile: {
        name: (p.profile && p.profile.name) || p.name || "Miner",
        username: (p.profile && p.profile.username) || null,
        total_mined: p.profile ? (Number(p.profile.total_mined) || 0) : 0,
        referral_count: p.profile && p.profile.referral_count != null
          ? Number(p.profile.referral_count)
          : (p.referral ? (p.referral.invited || 0) : 0)
      },
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
      }
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
      $("userChip").textContent = "Hello, " + state.user.first_name + " 👋";
    }

    renderWallet();
    renderWithdraw();
    renderLevel();
    renderTasks();
    renderProfile();

    // Mining tab: three mutually exclusive states.
    $("miningIdle").classList.toggle("hidden", !!s);
    $("miningRunning").classList.toggle("hidden", !s || s.claimable);
    $("miningDone").classList.toggle("hidden", !s || !s.claimable);
    var mStatus = $("mineStatus");
    if (!s) {
      mStatus.textContent = "● Ready";
      mStatus.className = "mine-status ready";
      $("mineTimer").textContent = "Sessions run 8 hours ⏳";
      $("mineAccruedBig").textContent = fmtPoints(state.idleFull || 0);
    } else if (s.claimable && s.stopped) {
      mStatus.textContent = "● Stopped";
      mStatus.className = "mine-status done";
      $("mineTimer").textContent = "⏸ Mining stopped — claim to run again";
      $("mineAccruedBig").textContent = fmtPoints(s.accrued);
    } else if (s.claimable) {
      mStatus.textContent = "● Complete";
      mStatus.className = "mine-status done";
      $("mineTimer").textContent = "🎉 Session complete — claim your GEM";
      $("mineAccruedBig").textContent = fmtPoints(s.accrued);
    } else {
      mStatus.textContent = "● Running";
      mStatus.className = "mine-status running";
    }
    document.body.classList.toggle("is-mining", !!s && !s.claimable);
    document.body.classList.toggle("is-done", !!s && s.claimable);

    if (s && s.claimable) {
      $("doneAmount").textContent = fmtPoints(s.accrued) + " GEM";
      $("claimAmount").textContent = fmtPoints(s.accrued);
      if (s.stopped) {
        $("claimNote").textContent = "⏸ This session wasn't claimed within 48 hours, so mining stopped. Your GEM is safe — claim it and mining runs again.";
      } else if (s.claim_deadline_ts) {
        $("claimNote").textContent = "⏰ Claim within " + fmtDuration(Math.max(0, s.claim_deadline_ts - Date.now() / 1000)) + " — mining stops 48 hours after the session ends.";
      } else {
        $("claimNote").textContent = "";
      }
      setRing(1);
    } else if (s) {
      tick(); // paints progress immediately; interval keeps it live
    } else {
      setRing(0);
    }

    // Friends tab (referral).
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
  }

  /* ---------------- profil tab: header + stats ----------------
   * Renders from the payload's `profile` object (name, username,
   * lifetime total mined, referral count); the verification badge
   * mirrors the wallet state shown in the wallet card below it. */
  function renderProfile() {
    var prof = state.profile || {};
    var name = prof.name || (state.user && state.user.first_name) || "Miner";
    $("profileAvatar").textContent = name.trim().charAt(0).toUpperCase() || "💎";
    $("profileName").textContent = name;
    $("profileUsername").textContent = prof.username
      ? "@" + prof.username
      : "ID: " + (state.user && state.user.id != null ? state.user.id : "—");
    var badge = $("profileBadge");
    var badgeText = "";
    if (state.walletVerified) badgeText = "🛡️ Wallet verified";
    else if (state.walletPending) badgeText = "⏳ Verification being checked…";
    else if (state.wallet) badgeText = "🔗 Wallet connected · not verified yet";
    badge.textContent = badgeText;
    badge.classList.toggle("hidden", !badgeText);
    $("profileBalance").textContent = fmtPoints(state.balance) + " GEM";
    $("profileMined").textContent = fmtPoints(prof.total_mined || 0) + " GEM";
    $("profileReferrals").textContent = fmtPoints(prof.referral_count || 0);
  }

  function setRing(frac) {
    var c = 2 * Math.PI * 100; // r=100 -> ~628.3
    $("ringFg").style.strokeDashoffset = String(c * (1 - Math.min(1, Math.max(0, frac))));
  }

  /* Live counter format: 4 decimals so the mined amount visibly runs
   * (at the base rate of 350 GEM/day the 4th decimal moves several
   * times per second). */
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
    // The big number is the UNCLAIMED amount: after a claim it restarts
    // from ~0 and ticks up again (watermark), like the claim button.
    var accrued = availableOf(s, now);
    s.accrued = accrued;

    setRing(frac);
    $("progressBar").style.width = (frac * 100).toFixed(1) + "%";
    $("progressPct").textContent = Math.floor(frac * 100) + "%";
    $("mineAccruedBig").textContent = fmtLive(accrued);
    $("mineTimer").textContent = "⏳ Mining ends in " + fmtDuration(s.end_ts - now);

    // Early-claim button: live amount, enabled once it reaches the
    // session's minimum (1 GEM); the bot re-checks server-side anyway.
    var avail = availableOf(s, now);
    var earlyBtn = $("btnEarlyClaim");
    if (earlyBtn) {
      if (avail >= (s.min_claim || 1)) {
        earlyBtn.disabled = false;
        earlyBtn.textContent = "💰 Claim " + fmtLive(avail) + " GEM";
      } else {
        earlyBtn.disabled = true;
        earlyBtn.textContent = "Claim (min. 1 GEM)";
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
    $("walletBadge").textContent = state.walletVerified ? " 🛡️ Verified" : "";
    // Verify step: only while connected, unverified, not already
    // pending, and the bot actually sent a verify object (it doesn't
    // when GEM_PROJECT_WALLET is unset or right after a fresh connect
    // in this page session — reopening the app brings a fresh payload).
    var showVerify = !state.walletVerified && !state.walletPending && !!state.verify;
    $("walletVerify").classList.toggle("hidden", !showVerify);
    $("walletPending").classList.toggle(
      "hidden", !(state.walletPending && !state.walletVerified));
  }

  /* Withdraw amounts use the same English number format. */
  function fmtId(n) {
    return fmtPoints(n);
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
    var holdTxt = "";
    if (wd && wd.hold_ratio) {
      holdTxt = " You must hold at least " + Math.round(wd.hold_ratio * 100)
        + "% of the amount as GEM in your wallet (your wallet now holds "
        + fmtId(wd.holdings || 0) + " GEM).";
    }
    if (wd && wd.next_withdraw_ts) {
      var cdLeft = Number(wd.next_withdraw_ts) - Date.now() / 1000;
      if (cdLeft > 0) {
        var cdH = Math.floor(cdLeft / 3600);
        var cdM = Math.floor((cdLeft % 3600) / 60);
        holdTxt += " One withdraw per 24 hours — next available in "
          + cdH + "h " + cdM + "m.";
      }
    }
    $("wdMinNote").textContent = "Minimum withdraw is " + fmtId(min) + " GEM." + holdTxt;
    var feeEl = $("wdFeeNote");
    if (feeEl) {
      var ratio = wd && wd.fee_ratio ? Number(wd.fee_ratio) : 0.03;
      var amtEl = $("wdAmount");
      var amt = amtEl ? parseFloat(String(amtEl.value || "").replace(",", ".")) : NaN;
      if (amt && isFinite(amt) && amt > 0) {
        var fee = amt * ratio;
        feeEl.textContent = "Fee " + Math.round(ratio * 100) + "%: -" + fmtId(fee)
          + " GEM \u00B7 You receive: " + fmtId(amt - fee) + " GEM";
      } else {
        feeEl.textContent = "A " + Math.round(ratio * 100) + "% fee is deducted from every withdraw.";
      }
    }

    var pending = wd && wd.pending ? wd.pending : null;
    $("wdForm").classList.toggle("hidden", !!pending);
    var pEl = $("wdPending");
    pEl.classList.toggle("hidden", !pending);
    if (pending) {
      pEl.textContent = "⏳ Pending withdraw: " + fmtId(pending.amount)
        + " GEM — queued for processing.";
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

  $("wdAmount").addEventListener("input", function () { renderWithdraw(); });
  $("btnWithdraw").addEventListener("click", function () {
    haptic("tap");
    var min = state.withdraw && state.withdraw.min
      ? Number(state.withdraw.min) : 7500;
    if (!state.wallet) {
      wdNote("Connect your wallet first in the 🔗 TON Wallet section above.");
      return;
    }
    if (!state.walletVerified) {
      wdNote("Your wallet isn't verified yet — please verify it first (0.05 TON).");
      return;
    }
    if (state.withdraw && state.withdraw.pending) {
      wdNote("You already have a pending withdraw request — please wait for it to be processed.");
      return;
    }
    var amount = parseFloat(String($("wdAmount").value || "").replace(",", "."));
    if (!amount || isNaN(amount) || amount < min) {
      haptic("error");
      wdNote("Minimum withdraw is " + fmtId(min) + " GEM.");
      return;
    }
    if (amount > state.balance) {
      haptic("error");
      wdNote("Your GEM balance isn't enough.");
      return;
    }
    if (!sendAction({ action: "withdraw", amount: amount },
                    function () { applyOptimistic("withdraw", amount); })) {
      wdNote("Open the Mini App from the 🎮 Play GEM button in the bot chat.");
    } else {
      toast("🧾 Withdraw sent — final confirmation is in the chat.");
    }
  });

  /* ---------------- level card ---------------- */
  // Fallback level table (mirrors bot.py LEVELS × BASE_DAILY_GEM);
  // the payload's level.table wins whenever it is present.
  var LEVEL_TABLE_FALLBACK = [
    { level: 1, threshold: 0, multiplier: 1, per_day: BASE_DAILY_GEM * 1 },
    { level: 2, threshold: 500, multiplier: 1.5, per_day: BASE_DAILY_GEM * 1.5 },
    { level: 3, threshold: 2000, multiplier: 2, per_day: BASE_DAILY_GEM * 2 },
    { level: 4, threshold: 5000, multiplier: 3, per_day: BASE_DAILY_GEM * 3 },
    { level: 5, threshold: 10000, multiplier: 5, per_day: BASE_DAILY_GEM * 5 },
    { level: 6, threshold: 25000, multiplier: 6, per_day: BASE_DAILY_GEM * 6 },
    { level: 7, threshold: 50000, multiplier: 8, per_day: BASE_DAILY_GEM * 8 },
    { level: 8, threshold: 100000, multiplier: 10, per_day: BASE_DAILY_GEM * 10 },
    { level: 9, threshold: 250000, multiplier: 12, per_day: BASE_DAILY_GEM * 12 },
    { level: 10, threshold: 500000, multiplier: 15, per_day: BASE_DAILY_GEM * 15 }
  ];

  function renderLevelTable(lv) {
    var body = $("levelTableBody");
    if (!body) return;
    var rows = (lv.table && lv.table.length) ? lv.table : LEVEL_TABLE_FALLBACK;
    body.textContent = "";
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      if (Number(r.level) === Number(lv.level)) tr.className = "current";
      var cells = [
        "⭐ Lv " + r.level,
        "≥ " + fmtPoints(r.threshold) + " GEM",
        "×" + fmtPoints(r.multiplier),
        fmtPoints(r.per_day) + " GEM"
      ];
      cells.forEach(function (text) {
        var td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  function renderLevel() {
    var card = $("levelCard");
    if (!card) return;
    var lv = state.level;
    if (!lv) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    $("levelBadge").textContent = "⭐ Lv " + lv.level;
    $("levelMult").textContent = "multiplier ×" + fmtPoints(lv.multiplier);
    // Earnings are presented per day (payload rate_per_day; the
    // hourly payload field × 24 as fallback).
    $("levelRate").textContent = fmtPoints(
      lv.rate_per_day || (Number(lv.rate_per_hour) || BASE_RATE) * 24
    ) + " GEM/day";
    renderLevelTable(lv);
    // The level comes from GEM held in the TON wallet (on-chain),
    // never from the in-app balance.
    $("levelHoldings").textContent = fmtPoints(lv.holdings || 0) + " GEM";
    $("levelLiveNote").classList.toggle("hidden", !!lv.live);
    var frac = Math.min(1, Math.max(0, Number(lv.progress_frac) || 0));
    $("levelBar").style.width = (frac * 100).toFixed(1) + "%";
    if (lv.next_level) {
      $("levelNext").textContent = fmtPoints(lv.holdings || 0) + " / "
        + fmtPoints(lv.next_threshold) + " GEM to Lv " + lv.next_level
        + " — the more GEM you hold in your wallet, the faster you mine!";
    } else {
      $("levelNext").textContent = "MAX level 🔥 — highest multiplier!";
    }
    if (state.idleFull != null) {
      $("idleFull").textContent = fmtPoints(state.idleFull) + " GEM";
    }
    // Mine-tab widgets (Rifty-style home): stat row, multiplier badge,
    // next-level card.
    var perDay = lv.rate_per_day || (Number(lv.rate_per_hour) || BASE_RATE) * 24;
    $("statHourly").textContent = fmtPoints(perDay / 24);
    $("statDaily").textContent = fmtPoints(perDay);
    $("statBoost").textContent = "×" + fmtPoints(lv.multiplier);
    $("statLevel").textContent = "Lv " + lv.level;
    $("mineMultBadge").textContent = "⚡ ×" + fmtPoints(lv.multiplier);
    $("nlBadge").textContent = "Lv " + lv.level;
    $("nlBar").style.width = (frac * 100).toFixed(1) + "%";
    if (lv.next_level) {
      $("nlTitle").textContent = "Next Level: " + lv.next_level;
      $("nlText").textContent = fmtPoints(lv.holdings || 0) + " / "
        + fmtPoints(lv.next_threshold) + " GEM";
      $("nlNote").textContent = "Hold " + fmtPoints(lv.next_threshold)
        + " GEM in your wallet to reach Level " + lv.next_level;
    } else {
      $("nlTitle").textContent = "Max Level 🔥";
      $("nlText").textContent = fmtPoints(lv.holdings || 0) + " GEM";
      $("nlNote").textContent = "You hold the highest multiplier!";
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
    var mc = $("missionCount");
    if (mc) {
      mc.textContent = tasks.filter(function (t) {
        return t.state === "ready";
      }).length;
    }
    if (!tasks.length) {
      var empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No tasks right now. Check back later. 💎";
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
        done.textContent = "✅ Done";
        actions.appendChild(done);
      } else if (t.state === "ready") {
        if (t.url) {
          var open = document.createElement("button");
          open.className = "btn btn-task-open";
          open.textContent = "Open";
          open.addEventListener("click", function () {
            haptic("tap");
            openExternal(t.url);
          });
          actions.appendChild(open);
        }
        var claim = document.createElement("button");
        claim.className = "btn btn-task";
        claim.textContent = "Claim +" + fmtPoints(t.reward);
        claim.addEventListener("click", function () {
          haptic("tap");
          if (!sendAction({ action: "task", task_id: t.id },
                          function () { applyOptimistic("task", t); })) {
            fallbackHint();
          } else {
            toast("✅ Claim sent — final confirmation is in the chat.");
          }
        });
        actions.appendChild(claim);
      } else {
        var lock = document.createElement("span");
        lock.className = "task-state locked";
        lock.textContent = "🔒 Locked";
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
      // Telegram links must open INSIDE Telegram (openTelegramLink) —
      // openLink sends t.me URLs to the browser and kicks the user out
      // of the app. Non-Telegram links (STON.fi etc.) keep openLink.
      if (tg && /t\.me\//.test(url) && typeof tg.openTelegramLink === "function") {
        tg.openTelegramLink(url); return;
      }
      if (tg && typeof tg.openLink === "function") { tg.openLink(url); return; }
    } catch (e) { /* fall through */ }
    window.open(url, "_blank");
  }

  /* ---------------- actions: back to the server ------------------ */
  // ONE transport: a direct synchronous API call. The action goes to
  // the API server, which validates initData, runs the action and
  // answers IN THE SAME RESPONSE with the one-line reply + a FRESH
  // payload. The payload replaces `state` wholesale, so the app
  // stays exact — and nothing ever closes the app (there is no
  // sendData path anymore: Telegram closes the Mini App after
  // sendData, which was the old claim-restart bug). On a network
  // failure the user just gets a toast and can tap again; the app
  // stays open either way. The UI first updates optimistically
  // (applyOptimistic) so taps feel instant.
  var sending = false; // in-flight guard against double-taps

  var API_TIMEOUT_MS = 25000;

  function apiAvailable() {
    return !!API_BASE && !!tg && !!tg.initData
      && typeof window.fetch === "function";
  }

  // Persistent one-line diagnostic: the stamp on next open shows what
  // happened last time.
  function noteDiag(text) {
    try { window.localStorage.setItem("gemDiag", text); } catch (e) {}
  }
  function readDiag() {
    try { return window.localStorage.getItem("gemDiag") || ""; }
    catch (e) { return ""; }
  }
  function apiWhy() {
    if (!API_BASE) return "API_BASE empty";
    if (!tg) return "Telegram object missing";
    if (!tg.initData) return "initData empty";
    if (typeof window.fetch !== "function") return "fetch missing";
    return "";
  }

  function apiDone(reply, payload) {
    noteDiag("API ok");
    if (payload) {
      var fresh = stateFromPayload(payload);
      if (fresh) state = fresh;
    }
    render();
    // An empty reply means "render silently" — the bootstrap action
    // answers with one, and the app must come up without a toast.
    if (reply) toast(reply);
    sending = false;
  }

  function apiError(why) {
    noteDiag("API failed: " + (why || "unknown"));
    toast("⚠️ Connection to the server failed — please try again.");
    sending = false;
  }

  // POST one action to the API and resolve with its parsed JSON body
  // ({ok, reply, payload}); rejects on network error, timeout, a
  // non-200 status or an {ok:false} body.
  function fetchAction(obj) {
    var ctrl = typeof AbortController === "function"
      ? new AbortController() : null;
    var timer = ctrl
      ? setTimeout(function () { ctrl.abort(); }, API_TIMEOUT_MS) : null;
    function done() { if (timer) clearTimeout(timer); }
    return window.fetch(API_BASE + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg.initData, data: obj }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      done();
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (res) {
      if (!res || res.ok === false) {
        throw new Error((res && res.error) || "server error");
      }
      return res;
    }).catch(function (e) {
      done();
      throw e;
    });
  }

  function apiSend(obj) {
    fetchAction(obj).then(function (res) {
      apiDone(res.reply, res.payload);
    }).catch(function (e) {
      apiError(e && e.message ? e.message : "network");
    });
  }

  /* Direct-entry bootstrap: the page was opened from the chat Menu
   * Button, which launches the bare URL — no signed payload fragment
   * — but DOES carry initData. Ask the server for our state with the
   * side-effect-free "bootstrap" action; the fresh payload in the
   * result renders the app exactly like a payload launch (and the
   * bot's empty reply means no toast). Unlike normal actions there
   * app has state, so any failure (after retries) lands on the
   * blocked screen — with the reason printed on it. */
  var bootstrapAttempt = 0;
  function bootstrapFail(why) {
    // Transient network failures are common on mobile data: retry the
    // whole bootstrap a few times before giving up, and when we do
    // give up, SAY WHY on the blocked screen (self-diagnosing).
    bootstrapAttempt += 1;
    if (bootstrapAttempt < 3) {
      setTimeout(function () { apiBootstrap(); }, 1500);
      return;
    }
    var el = document.getElementById("blockedWhy");
    if (el) {
      el.textContent = "Details: " + (why || "connection failed")
        + (apiWhy() ? " • " + apiWhy() : "");
    }
    noteDiag("bootstrap failed: " + (why || "?"));
    showScreen("blocked");
  }

  function apiBootstrap() {
    fetchAction({ action: "bootstrap" }).then(function (res) {
      if (!res.payload) { bootstrapFail("session rejected by server"); return; }
      apiDone(res.reply, res.payload);
      stampVersion();
      showScreen("app");
      startTicker();
    }).catch(function (e) {
      bootstrapFail(e && e.message ? e.message : "network");
    });
  }

  function sendAction(obj, applyFn) {
    if (sending) return true; // a send is already landing; swallow the tap
    if (!apiAvailable()) {
      noteDiag("API unavailable: " + apiWhy());
      toast("⚠️ " + (apiWhy() || "Connection unavailable"));
      return false;
    }
    // Paint the optimistic update now; the server's reply toast +
    // fresh payload land when the single request answers. The
    // in-flight flag stays up until then so actions can't interleave.
    sending = true;
    if (applyFn) applyFn();
    render();
    apiSend(obj);
    return true;
  }

  /* Optimistic local state updates, mirroring the server's rules, so
   * the still-open app stays correct until the next fresh payload. */
  function applyOptimistic(kind, data) {
    var now = Date.now() / 1000;
    if (kind === "start") {
      var rate = state.level && state.level.rate_per_hour
        ? Number(state.level.rate_per_hour) : BASE_RATE;
      state.session = {
        start_ts: now,
        end_ts: now + SESSION_HOURS * 3600,
        rate_per_hour: rate,
        full_amount: rate * SESSION_HOURS,
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
        var finalAmount = Math.max(0, s.full_amount - (s.claimed_total || 0));
        state.balance += finalAmount;
        if (state.profile) state.profile.total_mined += finalAmount;
        state.session = null;
        var nextRate = state.level && state.level.rate_per_hour
          ? Number(state.level.rate_per_hour) : BASE_RATE;
        state.idleFull = nextRate * SESSION_HOURS;
      } else {
        // Early claim: pay the live available amount, move the
        // watermark — availability restarts from ~0 and ticks up again.
        var amount = availableOf(s, now);
        if (amount <= 0) return;
        state.balance += amount;
        if (state.profile) state.profile.total_mined += amount;
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
    showError("This button only works when the Mini App is opened from the 🎮 Play GEM button in the bot chat.");
  }

  $("btnStart").addEventListener("click", function () {
    haptic("tap");
    if (!sendAction({ action: "start" }, function () { applyOptimistic("start"); })) {
      fallbackHint();
    } else {
      toast("⛏️ Mining started — confirmation is in the chat.");
    }
  });

  $("btnClaim").addEventListener("click", function () {
    haptic("tap");
    if (!sendAction({ action: "claim" }, function () { applyOptimistic("claim"); })) {
      fallbackHint();
    } else {
      toast("✅ Claim sent — final confirmation is in the chat.");
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
      toast("✅ Claim sent — final confirmation is in the chat.");
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
      walletNote("✅ Address sent — saved to the bot. Reopen the Mini App for the wallet verification step. 🛡️");
    } else {
      walletNote("Open the Mini App from the 🎮 Play GEM button in the bot chat so your wallet address gets saved.");
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
      walletNote("The verification step isn't available yet — reopen the Mini App from the bot chat.");
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
      walletNote("The transaction was cancelled/failed.");
      return;
    }
    Promise.resolve(sent).then(function () {
      if (sendAction({ action: "verify_sent" }, function () {
        state.walletPending = true;
      })) {
        renderWallet();
        haptic("success");
        walletNote("⏳ Payment sent — checking on-chain now, this usually takes just a few seconds… 🛡️");
        startVerifyPolling();
      } else {
        walletNote("Open the Mini App from the 🎮 Play GEM button in the bot chat.");
      }
    }, function () {
      haptic("error");
      walletNote("The transaction was cancelled/failed.");
    });
  });

  /* After a verification payment, poll the bootstrap payload every
   * few seconds so the app flips to "verified" the moment the bot's
   * on-chain checker confirms the payment — no manual reopen needed. */
  var verifyPollTimer = null;
  function startVerifyPolling() {
    var tries = 0;
    if (verifyPollTimer) clearInterval(verifyPollTimer);
    verifyPollTimer = setInterval(function () {
      tries += 1;
      if (tries > 20 || !state.walletPending || state.walletVerified) {
        clearInterval(verifyPollTimer);
        verifyPollTimer = null;
        return;
      }
      fetchAction({ action: "bootstrap" }).then(function (res) {
        if (res.payload && res.payload.wallet && res.payload.wallet.verified) {
          clearInterval(verifyPollTimer);
          verifyPollTimer = null;
          apiDone("", res.payload);
          haptic("success");
          walletNote("✅ Wallet verified — every feature is now unlocked!");
        }
      }).catch(function () { /* keep polling quietly */ });
    }, 4000);
  }

  $("btnWalletConnect").addEventListener("click", function () {
    haptic("tap");
    var ui = getTonConnectUI();
    if (!ui) {
      showError("The wallet SDK failed to load, please try again.");
      return;
    }
    try {
      ui.openModal();
    } catch (e) {
      showError("The wallet SDK failed to load, please try again.");
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
      walletNote("✅ Wallet disconnected — your address was removed from the bot.");
    } else {
      walletNote("Open the Mini App from the 🎮 Play GEM button in the bot chat.");
    }
  });

  $("btnCopyCa").addEventListener("click", function () {
    var input = $("caText");
    function done() {
      $("copyCaOk").classList.remove("hidden");
      haptic("success");
      setTimeout(function () { $("copyCaOk").classList.add("hidden"); }, 2500);
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

  $("btnBuyStonfi").addEventListener("click", function () {
    haptic("tap");
    openExternal("https://app.ston.fi/swap?ft=TON&tt=EQAV2pGBOzyVaSagkbrc5otgPQCuUD2VYmmBXXPOo2u9Nzvv");
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

  /* Home widgets that jump to another tab (mission center, tiles). */
  document.querySelectorAll("[data-goto]").forEach(function (el) {
    el.addEventListener("click", function () {
      var btn = document.querySelector(
        '.tab[data-tab="' + el.getAttribute("data-goto") + '"]');
      if (btn) btn.click();
    });
  });
  var tileBuy = $("tileBuy");
  if (tileBuy) {
    tileBuy.addEventListener("click", function () {
      haptic("tap");
      openExternal("https://app.ston.fi/swap?ft=TON&tt=EQAV2pGBOzyVaSagkbrc5otgPQCuUD2VYmmBXXPOo2u9Nzvv");
    });
  }

  /* ---------------- boot ---------------- */
  function applyTheme() {
    /* Fixed cosmic theme: the app does NOT adopt Telegram's palette. */
    if (!tg) return;
    try { tg.setHeaderColor("#04120c"); } catch (e) {}
    try { tg.setBackgroundColor("#04120c"); } catch (e) {}
  }

  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) {}
    applyTheme();
  }

  function stampVersion() {
    var verEl = document.getElementById("appVersion");
    if (!verEl) return;
    var prev = readDiag();
    verEl.textContent = "GEM Mining v28 • mode "
      + (apiAvailable() ? "API" : ("OFFLINE (" + apiWhy() + ")"))
      + (prev ? " • prev: " + prev : "");
  }

  var payload = parsePayload();
  if (!payload) {
    // No (valid) state snapshot in the URL. Two ways to land here:
    // a direct or stale link — the blocked screen, as before — or a
    // launch from the chat Menu Button, which opens the bare page
    // with no fragment but DOES carry initData. That is enough:
    // bootstrap the state with one API call and come up exactly
    // like a payload launch. Without initData, blocked it is.
    if (apiAvailable()) {
      showScreen("loading");
      apiBootstrap();
    } else {
      showScreen("blocked");
    }
    return;
  }
  state = stateFromPayload(payload);
  stampVersion();
  showScreen("app");
  render();
  startTicker();
})();
