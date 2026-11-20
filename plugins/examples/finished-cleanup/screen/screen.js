// A recipe for a plugin screen (docs/plugin-guide.md): it runs in a sandboxed frame and reaches Reelix
// only through window.reelix, which runs this plugin's own operations. Nothing here can remove anything:
// "propose" asks the owner, who decides in the Inbox.
const STRINGS = {
	en: { none: "No finished download has seeded that long.", some: (n) => `${n} finished downloads have seeded long enough to remove.`, refresh: "Scan again", propose: "Propose removal", proposed: (n) => `Proposed removing ${n}; decide in the Inbox.`, nothing: "Nothing to propose.", last: (s, n) => `Last proposal: ${s}, ${n} removed.` },
	zh: { none: "没有做种时间这么长的已完成下载。", some: (n) => `${n} 个已完成的下载做种时间已足够，可以移除。`, refresh: "重新扫描", propose: "建议移除", proposed: (n) => `已建议移除 ${n} 个；请在收件箱中决定。`, nothing: "没有可建议的。", last: (s, n) => `上次建议：${s}，已移除 ${n} 个。` },
	fr: { none: "Aucun téléchargement terminé n’a partagé aussi longtemps.", some: (n) => `${n} téléchargements terminés ont assez partagé pour être retirés.`, refresh: "Analyser à nouveau", propose: "Proposer le retrait", proposed: (n) => `Retrait de ${n} proposé ; décidez dans la boîte de réception.`, nothing: "Rien à proposer.", last: (s, n) => `Dernière proposition : ${s}, ${n} retirés.` },
	ru: { none: "Нет завершённых загрузок, которые раздавались так долго.", some: (n) => `${n} завершённых загрузок раздавались достаточно долго, чтобы их убрать.`, refresh: "Проверить снова", propose: "Предложить удаление", proposed: (n) => `Предложено убрать ${n}; решите во входящих.`, nothing: "Нечего предлагать.", last: (s, n) => `Последнее предложение: ${s}, убрано ${n}.` },
};
const s = () => STRINGS[window.reelix.lang] ?? STRINGS.en;
const $ = (id) => document.getElementById(id);

async function scan() {
	const { output } = await window.reelix.run("scan");
	$("summary").textContent = output.downloads.length ? s().some(output.downloads.length) : s().none;
	$("list").replaceChildren(
		...output.downloads.map((d) => {
			const li = document.createElement("li");
			const detail = document.createElement("small");
			li.textContent = d.name;
			detail.textContent = d.detail;
			li.append(detail);
			return li;
		}),
	);
	$("propose").disabled = !output.downloads.length;
	$("note").textContent = output.last ? s().last(output.last.status, output.last.done) : "";
}

function label() {
	$("refresh").textContent = s().refresh;
	$("propose").textContent = s().propose;
}

$("refresh").addEventListener("click", () => void scan());
$("propose").addEventListener("click", async () => {
	$("propose").disabled = true;
	try {
		const { output } = await window.reelix.run("propose");
		$("note").textContent = output.proposed ? s().proposed(output.proposed) : s().nothing;
	} catch (e) {
		$("note").textContent = e.message;
	}
});
window.reelix.onContext(() => {
	label();
	void scan();
});
label();
