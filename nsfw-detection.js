// NSFW Detection
(function () {
  const DEBUG = /[?&]nsfwtest=1/.test(location.search); // logs all 5 classes
  const STRIKE_THRESHOLD = 2;
  const CHECK_INTERVAL = 1800;
  const PORN_THRESHOLD = 0.35;
  const HENTAI_THRESHOLD = 0.30;
  // "Sexy" alone is common for swimwear/lingerie, so it only counts when
  // combined with Porn. Tune this against real samples before relying on it.
  const PORN_PLUS_SEXY_THRESHOLD = 0.75;
  const MAX_LOAD_ATTEMPTS = 3;

  let model = null;
  let modelPromise = null;
  let loadAttempts = 0;
  let localInterval = null, remoteInterval = null;
  let localBusy = false, remoteBusy = false;
  let localStrikes = 0, remoteStrikes = 0;

  function log(msg, ...a) { console.log("%c[NSFW]", "color:#ff6b6b;font-weight:bold", msg, ...a); }
  function logError(msg, ...a) { console.error("[NSFW]", msg, ...a); }

  // Load once; share the in-flight promise so concurrent callers don't load twice.
  function loadModel() {
    if (model) return Promise.resolve(model);
    if (modelPromise) return modelPromise;
    if (loadAttempts >= MAX_LOAD_ATTEMPTS) return Promise.resolve(null);
    loadAttempts++;
    modelPromise = (async () => {
      if (typeof nsfwjs === "undefined") {
        logError("nsfwjs library missing (CDN blocked or failed). Detection is OFF.");
        return null;
      }
      try {
        log("Loading model... attempt " + loadAttempts);
        const m = await nsfwjs.load("/models/nsfw/");
        model = m;
        const backend = (typeof tf !== "undefined" && tf.getBackend) ? tf.getBackend() : "unknown";
        log("Model loaded. tfjs backend: " + backend + (typeof tf !== "undefined" && tf.version_core ? ", tfjs " + tf.version_core : ""));
        return m;
      } catch (e) {
        logError("Model load failed. Detection is OFF.", e);
        return null;
      } finally {
        modelPromise = null; // allow a bounded retry if it failed
      }
    })();
    return modelPromise;
  }

  function getLV() { return window.localVideo || document.getElementById("localVideo"); }
  function getRV() { return window.remoteVideo || document.getElementById("remoteVideo"); }

  // One reusable canvas per region.
  const canvases = [0, 1, 2].map(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 224;
    return c;
  });

  // Draw a source rectangle into 224x224 preserving aspect ratio (letterboxed).
  function drawFit(video, canvas, sx, sy, sw, sh) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 224, 224);
    const scale = Math.min(224 / sw, 224 / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(video, sx, sy, sw, sh, (224 - dw) / 2, (224 - dh) / 2, dw, dh);
  }

  function sampleRegions(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return [];
    const size = Math.min(vw, vh);
    drawFit(video, canvases[0], 0, 0, vw, vh);                                   // full frame
    drawFit(video, canvases[1], (vw - size) / 2, (vh - size) / 2, size, size);    // center square
    drawFit(video, canvases[2], 0, vh * 0.45, vw, vh * 0.55);                     // lower region
    return canvases;
  }

  function prob(preds, name) {
    const p = preds.find(x => x.className === name);
    return p ? p.probability : 0;
  }

  async function analyze(video, isLocal) {
    if (!model || !video || video.readyState < 2 || !video.videoWidth) return;
    if (isLocal ? localBusy : remoteBusy) return;
    if (isLocal) localBusy = true; else remoteBusy = true;
    try {
      let worst = null; // {className, probability}
      let maxPorn = 0, maxHentai = 0, maxCombo = 0, maxSexy = 0, maxNeutral = 0, maxDrawing = 0;
      for (const canvas of sampleRegions(video)) {
        const preds = await model.classify(canvas, 5);
        const porn = prob(preds, "Porn"), hentai = prob(preds, "Hentai"), sexy = prob(preds, "Sexy");
        maxPorn = Math.max(maxPorn, porn);
        maxHentai = Math.max(maxHentai, hentai);
        maxSexy = Math.max(maxSexy, sexy);
        maxNeutral = Math.max(maxNeutral, prob(preds, "Neutral"));
        maxDrawing = Math.max(maxDrawing, prob(preds, "Drawing"));
        maxCombo = Math.max(maxCombo, porn + sexy);
        if (!worst || porn > worst.probability) worst = { className: "Porn", probability: porn };
        if (hentai > worst.probability) worst = { className: "Hentai", probability: hentai };
      }
      const pct = n => Math.round(n * 100) + "%";
      log(isLocal ? "LOCAL" : "REMOTE",
        "Porn:" + pct(maxPorn) + " Hentai:" + pct(maxHentai) +
        (DEBUG ? " Sexy:" + pct(maxSexy) + " Neutral:" + pct(maxNeutral) + " Drawing:" + pct(maxDrawing) + " Porn+Sexy:" + pct(maxCombo) : ""));

      const bad = maxPorn > PORN_THRESHOLD || maxHentai > HENTAI_THRESHOLD || maxCombo > PORN_PLUS_SEXY_THRESHOLD;
      if (bad && worst) {
        if (isLocal) {
          localStrikes++;
          log("Local strike", localStrikes);
          if (localStrikes >= STRIKE_THRESHOLD) banLocal(worst);
        } else {
          remoteStrikes++;
          log("Remote strike", remoteStrikes);
          if (remoteStrikes >= STRIKE_THRESHOLD) reportRemote(worst);
        }
      } else {
        if (isLocal) localStrikes = Math.max(0, localStrikes - 1);
        else remoteStrikes = Math.max(0, remoteStrikes - 1);
      }
    } catch (e) {
      logError("analyze error", e);
    } finally {
      if (isLocal) localBusy = false; else remoteBusy = false;
    }
  }

  function banLocal(pred) {
    stop();
    if (window.localStream) window.localStream.getTracks().forEach(t => t.stop());
    const lv = getLV(); if (lv) lv.srcObject = null;
    if (window.socket) window.socket.emit("nsfw-local-violation", { category: pred.className, confidence: pred.probability, strikes: localStrikes });
    showBan(pred);
  }

  function reportRemote(pred) {
    stop();
    const rv = getRV();
    if (rv) rv.style.filter = "blur(40px)";
    if (window.socket) {
      window.socket.emit("nsfw-remote-report", { category: pred.className, confidence: pred.probability, strikes: remoteStrikes });
      window.socket.emit("stop");
    }
  }

  function showBan(pred) {
    let s = document.getElementById("nsfwBanScreen");
    if (!s) {
      s = document.createElement("div");
      s.id = "nsfwBanScreen";
      s.innerHTML = '<div style="background:#111;color:#fff;padding:40px;border-radius:16px;max-width:480px;text-align:center;margin:auto"><h1 style="color:#ff4444">ACCESS SUSPENDED</h1><p>Automated safety system detected a possible community guidelines violation.</p><p><b>Reason:</b> <span id="nsfwBanReason">Nudity detected.</span></p><p><b>Status:</b> Banned.</p><p><b>Ref:</b> <span id="nsfwBanRef"></span></p></div>';
      s.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:99999;display:none;align-items:center;justify-content:center;";
      document.body.appendChild(s);
    }
    s.style.display = "flex";
    const reason = document.getElementById("nsfwBanReason");
    const ref = document.getElementById("nsfwBanRef");
    if (reason) reason.textContent = "Nudity detected (" + pred.className + ", " + Math.round(pred.probability * 100) + "%)";
    if (ref) ref.textContent = "OG-" + Date.now().toString(36).toUpperCase();
  }

  function start() {
    if (!model) return;
    stop();
    // Clear the blur left by a previous remote report so the next partner is visible.
    const rv = getRV(); if (rv) rv.style.filter = "";
    log("Detection started");
    localInterval = setInterval(() => analyze(getLV(), true), CHECK_INTERVAL);
    remoteInterval = setInterval(() => analyze(getRV(), false), CHECK_INTERVAL);
  }

  function stop() {
    if (localInterval) clearInterval(localInterval);
    if (remoteInterval) clearInterval(remoteInterval);
    localInterval = remoteInterval = null;
    localStrikes = remoteStrikes = 0;
  }

  function tryStart() {
    const lv = getLV();
    if (lv && lv.srcObject && !localInterval) {
      loadModel().then(m => {
        // Re-check: another tryStart may have started detection while loading.
        if (m && !localInterval && getLV() && getLV().srcObject) start();
      });
    }
  }

  setInterval(tryStart, 2000);
  window.addEventListener("load", tryStart);
})();