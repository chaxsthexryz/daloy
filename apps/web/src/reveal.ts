// Scroll reveal for the console (DESIGN.md, "Motion"), ported from docs/design/reveal.js.
// Each block starts low, transparent and blurred, and settles once, the first time it enters the view.
// Without IntersectionObserver, or with reduced motion, nothing is hidden: the starting state is only ever set here.
// The top-level blocks of .page and each automation card are picked up by selector. The editor has no .page and is left alone.
const TARGETS = "[data-reveal], .page > :not(header, .cards), .cards > li";

if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        (e.target as HTMLElement).dataset.reveal = "in";
        seen.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  // A data attribute, not a class: React rewrites className when the state of a card changes, but leaves this alone.
  const mark = () => {
    for (const el of document.querySelectorAll<HTMLElement>(TARGETS)) {
      if (el.dataset.reveal) continue;
      el.dataset.reveal = "pending";
      seen.observe(el);
    }
  };
  mark();
  // Pages and list rows that arrive later (a route change, a new request while polling) get the same treatment.
  new MutationObserver(mark).observe(document.body, { childList: true, subtree: true });
}
