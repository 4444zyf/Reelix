import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * A Douban subject page as recorded (the parts Reelix reads, in Douban's markup), for `reelix plugin check` and
 * this plugin's tests.
 */
export const PAGE = `<!DOCTYPE html><html><head><title>奥本海默 (豆瓣)</title></head><body>
<h1><span property="v:itemreviewed">奥本海默 Oppenheimer</span> <span class="year">(2023)</span></h1>
<div id="info"><span><span class="pl">导演</span>: <span class="attrs"><a href="/celebrity/1054524/" rel="v:directedBy">克里斯托弗·诺兰</a></span></span><br/>
<span class="pl">片长:</span> <span property="v:runtime" content="180">180分钟</span><br/>
<span class="pl">IMDb:</span> tt15398776<br/></div>
<div class="rating_self clearfix"><strong class="ll rating_num" property="v:average">8.8</strong><span property="v:votes">412345</span></div>
</body></html>`;

export default {
	http: [{ url: "https://movie.douban.com/subject/35593344/", body: PAGE }],
	seams: {
		"reelix:metadata.source@1": { provider: "douban", link: { text: "https://movie.douban.com/subject/35593344/", ids: { douban: "35593344", imdb: "tt15398776" } }, enrich: { douban: "35593344" }, notMine: "https://bgm.tv/subject/400602" },
	},
} satisfies PluginCheck;
