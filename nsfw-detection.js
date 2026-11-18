// NSFW Detection for Online Galli using NSFWJS + TensorFlow.js
// Loaded only during active video chats. No frames uploaded.

(function() {
  let model = null;
  let localInterval = null;
  let remoteInterval = null;
  let localStrikes = 0;
  let remoteStrikes = 0;
  const STRIKE_THRESHOLD = 3; // consecutive detections
  const CHECK_INTERVAL = 2500; // ms
  const PORN_THRESHOLD = 0.85;
  const HENTAI_THRESHOLD = 0.80;

  async function loadModel() {
    if (model) return model;
    try {
      model = await nsfwjs.load();
      console.log("[NSFW] Model loaded");
      return model;
    } catch (e) {
      console.warn("[NSFW] Model load failed", e);
      return null;
    }
  }

  function analyzeVideo(video, isLocal) {
    if (!video || video.readyState < 2 || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = 224;
    canvas.height = 224;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 224, 224);
    model.classify(canvas).then(predictions => {
      const porn = predictions.find(p => p.className === 'Porn');
      const hentai = predictions.find(p => p.className === 'Hentai');
      const isViolation = (porn && porn.probability > PORN_THRESHOLD) || (hentai && hentai.probability > HENTAI_THRESHOLD);
      if (isViolation) {
        if (isLocal) {
          localStrikes++;
          if (localStrikes >= STRIKE_THRESHOLD) triggerLocalBan(porn || hentai);
        } else {
          remoteStrikes++;
          if (remoteStrikes >= STRIKE_THRESHOLD) triggerRemoteReport(porn || hentai);
        }
      } else {
        if (isLocal) localStrikes = Math.max(0, localStrikes - 1);
        else remoteStrikes = Math.max(0, remoteStrikes - 1);
      }
    }).catch(() => {});
  }

  function triggerLocalBan(pred) {
    stopDetection();
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localVideo.srcObject = null;
    }
    socket.emit('nsfw-local-violation', {
      category: pred.className,
      confidence: pred.probability,
      strikes: localStrikes
    });
    showBanScreen('local', pred);
  }

  function triggerRemoteReport(pred) {
    stopDetection();
    remoteVideo.style.filter = 'blur(30px)';
    socket.emit('nsfw-remote-report', {
      category: pred.className,
      confidence: pred.probability,
      strikes: remoteStrikes
    });
    // Disconnect current chat
    if (typeof stop === 'function') stop();
    else socket.emit('stop');
  }

  function showBanScreen(type, pred) {
    const screen = document.getElementById('nsfwBanScreen') || createBanScreen();
    screen.style.display = 'flex';
    document.getElementById('nsfwBanReason').textContent = `Nudity detected (${pred.className}, ${(pred.probability*100).toFixed(0)}%)`;
    document.getElementById('nsfwBanRef').textContent = 'OG-' + Date.now().toString(36).toUpperCase();
  }

  function createBanScreen() {
    const div = document.createElement('div');
    div.id = 'nsfwBanScreen';
    div.innerHTML = `
      <div style="background:#111;color:#fff;padding:40px;border-radius:16px;max-width:480px;text-align:center;margin:auto;">
        <h1 style="color:#ff4444;margin:0 0 16px;">ACCESS SUSPENDED</h1>
        <p>Our automated safety system detected a possible violation of Online Galli's community guidelines.</p>
        <p><strong>Reason:</strong> <span id="nsfwBanReason">Nudity detected.</span></p>
        <p><strong>Status:</strong> Banned.</p>
        <p><strong>Ban reference ID:</strong> <span id="nsfwBanRef">—</span></p>
        <p style="margin-top:24px;"><a href="/guidelines.html" style="color:#ffe247;">View Community Guidelines</a> · <a href="mailto:support@onlinegalli.com" style="color:#ffe247;">Appeal</a></p>
      </div>`;
    div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:none;align-items:center;justify-content:center;';
    document.body.appendChild(div);
    return div;
  }

  function startDetection() {
    if (!model) return;
    stopDetection();
    localInterval = setInterval(() => analyzeVideo(localVideo, true), CHECK_INTERVAL);
    remoteInterval = setInterval(() => analyzeVideo(remoteVideo, false), CHECK_INTERVAL);
  }

  function stopDetection() {
    if (localInterval) clearInterval(localInterval);
    if (remoteInterval) clearInterval(remoteInterval);
    localInterval = remoteInterval = null;
    localStrikes = remoteStrikes = 0;
  }

  // Hook into existing events
  window.addEventListener('load', () => {
    const origMatched = socket._callbacks && socket._callbacks['$matched'];
    // We'll rely on existing matched handler and add our own listener
  });

  // Expose for manual control if needed
  window.GalliNSFW = { loadModel, startDetection, stopDetection };

  // Auto-start when video is active
  const observer = new MutationObserver(() => {
    if (localVideo && localVideo.srcObject && !localInterval) {
      loadModel().then(() => startDetection());
    }
  });
  if (localVideo) observer.observe(localVideo, { attributes: true, attributeFilter: ['srcObject'] });
})();
