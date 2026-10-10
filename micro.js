// Phase 86 step 3 — micro-interactions (owner: "more user friendly and modern / cool"). Mouse + trackpad only; touch and reduced
// motion get none of it. 1. a "View" cursor that trails the pointer over the showcase product; 2. the product leans a few degrees
// toward the pointer; 3. the main buttons are magnetic; 4. a soft light follows the pointer across the rail items.

const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (fine && !reduce) init();

function init() {
  // 1 + 2: the View cursor and the lean, over the showcase stage
  const stage = document.querySelector('.showcase__stage');
  if (stage) {
    const cur = document.createElement('div');
    cur.className = 'mx-cursor'; cur.setAttribute('aria-hidden', 'true'); cur.innerHTML = '<span>View</span>';
    document.body.appendChild(cur);
    let x = 0, y = 0, cx = 0, cy = 0, on = false, raf = 0;
    const loop = () => {
      cx += (x - cx) * 0.2; cy += (y - cy) * 0.2;
      cur.style.transform = `translate(${cx}px, ${cy}px)`;
      raf = (on || Math.abs(x - cx) + Math.abs(y - cy) > 0.5) ? requestAnimationFrame(loop) : 0;
    };
    const lean = () => {};   // Phase 89: products stand on the showroom floor — no lean (owner: "must not look like it floats")
    const isLive = () => !!stage.closest('.showcase.has-3d, .showcase.is-loading');
    stage.addEventListener('pointerenter', e => { if (e.pointerType !== 'mouse' || isLive()) return; on = true; x = cx = e.clientX; y = cy = e.clientY; cur.classList.add('is-on'); stage.classList.add('mx-hide-cursor'); if (!raf) raf = requestAnimationFrame(loop); });
    stage.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      if (isLive()) { if (on) { on = false; cur.classList.remove('is-on'); stage.classList.remove('mx-hide-cursor'); lean(0, 0); } return; }
      if (!on) { on = true; cx = e.clientX; cy = e.clientY; cur.classList.add('is-on'); stage.classList.add('mx-hide-cursor'); if (!raf) raf = requestAnimationFrame(loop); }
      x = e.clientX; y = e.clientY;
      const r = stage.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width - 0.5, ny = (e.clientY - r.top) / r.height - 0.5;
      lean((-ny * 6).toFixed(2), (nx * 9).toFixed(2));
    });
    stage.addEventListener('pointerleave', () => { on = false; cur.classList.remove('is-on'); stage.classList.remove('mx-hide-cursor'); lean(0, 0); });
    stage.addEventListener('pointerdown', () => cur.classList.add('is-down'));
    window.addEventListener('pointerup', () => cur.classList.remove('is-down'));
  }

  // 3: magnetic buttons — they drift a little toward the pointer and spring back
  const MAG = '.showcase__cta, .psheet__quote, .site-nav__cta, .hero__cue, .pv-quote, .psheet__close';
  const STRENGTH = 0.28, REACH = 26;
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    document.querySelectorAll(MAG).forEach(el => {
      if (!el.getClientRects().length) return;
      const r = el.getBoundingClientRect();
      const inside = e.clientX > r.left - REACH && e.clientX < r.right + REACH && e.clientY > r.top - REACH && e.clientY < r.bottom + REACH;
      if (inside) {
        const dx = (e.clientX - (r.left + r.width / 2)) * STRENGTH, dy = (e.clientY - (r.top + r.height / 2)) * STRENGTH;
        el.style.setProperty('--mx', dx.toFixed(1) + 'px'); el.style.setProperty('--my', dy.toFixed(1) + 'px'); el.classList.add('mx-mag');
      } else if (el.classList.contains('mx-mag')) {
        el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px'); el.classList.remove('mx-mag');
      }
    });
  }, { passive: true });

  // 4: a soft light that follows the pointer across the rail items
  const rail = document.querySelector('.showcase__rail');
  if (rail) rail.addEventListener('pointermove', e => {
    const it = e.target.closest('.showcase__item'); if (!it) return;
    const r = it.getBoundingClientRect();
    it.style.setProperty('--lx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    it.style.setProperty('--ly', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
  }, { passive: true });
}
