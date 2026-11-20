// The website's behaviour: theme switch, tabs, copy buttons, the conversation illustration, reveal on scroll.
// Without JavaScript the page is complete: every pane's first tab and the whole conversation are visible.
const root = document.documentElement;
root.classList.add("js");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

document.getElementById("theme").addEventListener("click", () => {
	const next = root.dataset.theme === "paper" ? "marquee" : "paper";
	root.dataset.theme = next;
	try {
		localStorage.setItem("reelix-site-theme", next);
	} catch {
		// Private browsing: the choice lasts for this page only.
	}
});

for (const list of document.querySelectorAll("[data-tabs]")) {
	const group = list.dataset.tabs;
	const tabs = [...list.querySelectorAll("[data-tab]")];
	const select = (tab) => {
		for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
		for (const pane of document.querySelectorAll(`[data-pane="${group}"]`)) pane.hidden = pane.dataset.id !== tab.dataset.tab;
	};
	list.addEventListener("click", (event) => {
		const tab = event.target.closest("[data-tab]");
		if (tab) select(tab);
	});
	list.addEventListener("keydown", (event) => {
		const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		const next = tabs[(tabs.indexOf(document.activeElement) + step + tabs.length) % tabs.length];
		next.focus();
		select(next);
	});
}

for (const button of document.querySelectorAll("[data-copy]")) {
	const label = button.textContent;
	button.addEventListener("click", async () => {
		await navigator.clipboard.writeText(button.dataset.copy);
		button.textContent = button.dataset.done;
		setTimeout(() => (button.textContent = label), 1600);
	});
}

// The conversation plays once when it comes into view, and again on request.
const demo = document.getElementById("demo");
const steps = [...demo.querySelectorAll("[data-step]")];
let run = 0;
async function play() {
	const mine = ++run;
	for (const s of steps) s.classList.add("wait");
	for (const s of steps) {
		await new Promise((done) => setTimeout(done, s.matches(".bubble") ? 500 : s.matches(".title-card, .releases, .answer") ? 1100 : 750));
		if (mine !== run) return;
		s.classList.remove("wait");
	}
}
document.getElementById("replay").addEventListener("click", play);
if (!still) {
	for (const s of steps) s.classList.add("wait");
	new IntersectionObserver((entries, observer) => {
		if (!entries[0].isIntersecting) return;
		observer.disconnect();
		play();
	}).observe(demo);
}

const reveal = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			entry.target.classList.add("in");
			reveal.unobserve(entry.target);
		}
	},
	{ rootMargin: "0px 0px -10% 0px" },
);
if (!still) for (const el of document.querySelectorAll(".head, .strip, .three, .screen, .grid, .term")) {
	el.classList.add("reveal");
	reveal.observe(el);
}
