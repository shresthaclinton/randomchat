// NSFW Detection for Online Galli - improved reliability
(function() {
  let model = null;
  let localInterval = null;
  let remoteInterval = null;
  let localStrikes = 0;
  let remoteStrikes = 0;
  const STRIKE_THRESHOLD = 2;
  const CHECK_INTERVAL = 2000;
  const PORN_THRESHOLD = 0.70;
  const HENTAI_THRESHOLD = 0.65;
  const SEXY_THRESHOLD = 0.85; // high bar so normal skin doesn't trigger

  async function loadModel() {
    if (model) return model;
    try {
      console.log("[NSFW] Loading model...");
      model = await nsfwjs.load();
      console.log("[NSFW] Model loaded successfully");
      return model;
    } catch (e) {
      console.error("[NSFW] Model load failed", e);
      return null;
    }
  }

  function analyzeVideo(video, isLocal) {
    if (!model || !video || video.readyState < 2 || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 224;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, 224, 224);
    model.classify(canvas).then(predictions => {
      const porn = predictions.find(p => p.className === "Porn");
      const hentai = predictions.find(p => p.className === "Hentai");
      const sexy = predictions.find(p => p.className === "Sexy");
      console.log("[NSFW]", isLocal ? "LOCAL" : "REMOTE",
        predictions.map(p => p.className + ":" + (p.probability*100).toFixed(0) + "%").join(" "));

      const isViolation = (porn && porn.probability > PORN_THRESHOLD) ||
                          (hentai && hentai.probability > HENTAI_THRESHOLD);
      if (isViolation) {
        if (isLocal) {
          localStrikes++;
          console.log("[NSFW] Local strike", localStrikes);
          if (localStrikes >= STRIKE_THRESHOLD) triggerLocalBan(porn || hentai);
        } else {
          remoteStrikes++;
          if (remoteStrikes >= STRIKE_THRESHOLD) triggerRemoteReport(porn || hentai);
        }
      } else {
        if (isLocal) localStrikes = Math.max(0, localStrikes - 1);
        else remoteStrikes = Math.max(0, remoteStrikes - 1);
      }
    }).catch(err => console.warn("[NSFW] classify error", err));
  }

  function triggerLocalBan(pred) {
    stopDetection();
    if (window.localStream) {
      window.localStream.getTracks().forEach(t => t.stop());
    }
    if (window.localVideo) window.localVideo.srcObject = null;
    if (window.socket) {
      window.socket.emit("nsfw-local-violation", {
        category: pred.className,
        confidence: pred.probability,
        strikes: localStrikes
      });
    }
    showBanScreen(pred);
  }

  function triggerRemoteReport(pred) {
    stopDetection();
    if (window.remoteVideo) window.remoteVideo.style.filter = "blur(30px)";
    if (window.socket) {
      window.socket.emit("nsfw-remote-report", {
        category: pred.className,
        confidence: pred.probability,
        strikes: remoteStrikes
      });
      window.socket.emit("stop");
    }
  }

  function showBanScreen(pred) {
    let screen = document.getElementById("nsfwBanScreen");
    if (!screen) {
      screen = document.createElement("div");
      screen.id = "nsfwBanScreen";
      screen.innerHTML = `
        <div style="background:#111;color:#fff;padding:40px;border-radius:16px;max-width:480px;text-align:center;margin:auto;">
          <h1 style="color:#ff4444;margin:0 0 16px;">ACCESS SUSPENDED</h1>
          <p>Our automated safety system detected a possible violation of Online Galli's community guidelines.</p>
          <p><strong>Reason:</strong> <span id="nsfwBanReason">Nudity detected.</span></p>
          <p><strong>Status:</strong> Banned.</p>
          <p><strong>Ban reference ID:</strong> <span id="nsfwBanRef">—</span></p>
          <p style="margin-top:24px;"><a href="/guidelines.html" style="color:#ffe247;">View Community Guidelines</a></p>
        </div>`;
      screen.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:99999;display:none;align-items:center;justify-content:center;";
      document.body.appendChild(screen);
    }
    screen.style.display = "flex";
    const reason = document.getElementById("nsfwBanReason");
    const ref = document.getElementById("nsfwBanRef");
    if (reason) reason.textContent = `Nudity detected (${pred.className}, ${(pred.probability*100).toFixed(0)}%)`;
    if (ref) ref.textContent = "OG-" + Date.now().toString(36).toUpperCase();
  }

  function startDetection() {
    if (!model) return;
    stopDetection();
    console.log("[NSFW] Detection started");
    localInterval = setInterval(() => analyzeVideo(window.localVideo, true), CHECK_INTERVAL);
    remoteInterval = setInterval(() => analyzeVideo(window.remoteVideo, false), CHECK_INTERVAL);
  }

  function stopDetection() {
    if (localInterval) clearInterval(localInterval);
    if (remoteInterval) clearInterval(remoteInterval);
    localInterval = remoteInterval = null;
    localStrikes = remoteStrikes = 0;
  }

  window.GalliNSFW = { loadModel, startDetection, stopDetection };

  // Start when camera is on
  function tryStart() {
    if (window.localVideo && window.localVideo.srcObject && !localInterval) {
      loadModel().then(m => { if (m) startDetection(); });
    }
  }

  setInterval(tryStart, 3000);
  document.addEventListener("DOMContentLoaded", tryStart);
})();
