// UI polish only. No business logic here.

// Theme toggle (persist in localStorage)
(function themeToggle() {
  const root = document.documentElement;
  const btn = document.getElementById("btnTheme");
  const key = "theme";
  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch {}
  function nextTheme() {
    const cur = root.getAttribute("data-theme") || "dark";
    return cur === "dark" ? "light" : "dark";
  }
  btn?.addEventListener("click", () => {
    const t = nextTheme();
    root.setAttribute("data-theme", t);
    try { localStorage.setItem(key, t); } catch {}
    // Small tap animation
    btn.animate({ transform: ["scale(1)", "scale(0.92)", "scale(1)"] }, { duration: 180, easing: "ease-out" });
  });
})();

// Button ripple
(function ripples() {
  const addRipple = (e) => {
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const span = document.createElement("span");
    span.className = "ripple";
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    span.style.left = `${x}px`;
    span.style.top = `${y}px`;
    btn.appendChild(span);
    setTimeout(() => span.remove(), 650);
  };
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest(".btn");
    if (btn && !btn.hasAttribute("disabled")) addRipple.call(btn, e);
  });
})();

// Reveal on scroll
(function revealOnScroll() {
  const els = Array.from(document.querySelectorAll(".reveal"));
  if (!("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12 });
  els.forEach((el) => io.observe(el));
})();

// Soft parallax on the hero (optional subtle)
(function parallax() {
  const hero = document.querySelector(".hero__title");
  if (!hero) return;
  let raf = 0;
  window.addEventListener("pointermove", (e) => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const dx = (e.clientX / window.innerWidth - 0.5) * 2;
      const dy = (e.clientY / window.innerHeight - 0.5) * 2;
      hero.style.transform = `translate3d(${dx * 4}px, ${dy * 3}px, 0)`;
    });
  }, { passive: true });
  window.addEventListener("pointerleave", () => {
    hero.style.transform = "";
  });
})();