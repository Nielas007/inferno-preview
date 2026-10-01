// SHOWROOM HERO — boot (Phase 70).
// The hero's first frame is the static band poster in index.html (<picture class="stage__poster">): it is on screen with
// the headline and actions at first paint. This module only decides whether the live 3D scene may take over, and then
// loads it (showroom-scene.js), which reveals the canvas (body.is-3d) once its first frame — the poster's frame — is drawn.
//   · no WebGL 2          → body.hero-static: the poster stays the hero; nothing else is fetched
//   · Save-Data requested → body.hero-static: the poster stays; the hero model is not fetched
//   · otherwise           → the live scene loads behind the poster and fades in over it when ready
function webgl2Available() {
  try {
    const c = document.createElement('canvas'), gl = window.WebGL2RenderingContext && c.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();   // give the probe context back at once
    return true;
  } catch (e) { return false; }
}
function start() {
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  if (!webgl2Available() || saveData) {
    document.body.classList.add('hero-static');
  } else {
    import('./showroom-scene.js?v=1').catch((err) => {
      document.body.classList.add('hero-static');              // the poster simply stays
      console.warn('[showroom] live hero unavailable, keeping the poster', err && err.message);
    });
  }
}
// This module is async (index.html), so it runs as soon as it arrives — often before the first frame. The first frame is the
// poster + headline, so the WebGL probe and the scene import wait until that frame has been painted (one frame), and still
// start long before the page's deferred modules have finished.
requestAnimationFrame(() => setTimeout(start, 0));
