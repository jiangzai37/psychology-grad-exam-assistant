import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
const dataDir = path.join(root, 'data');
const kbDir = path.join(root, 'knowledge-base');
const dailyDir = path.join(kbDir, '每日更新');
const articlesPath = path.join(dataDir, 'articles.json');
const statePath = path.join(dataDir, 'state.json');
const errorsPath = path.join(dataDir, 'errors.json');

await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(dailyDir, { recursive: true });

const rules = config.rules;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = new Date();
const runId = now.toISOString();
const errors = [];
const studyCategory = `${config.app.exportPrefix} 备考知识`;
const categories = ['官方报考信息', studyCategory, '院校与导师动态', '经验帖与课程资源'];
const schoolWords = [config.profile.school, ...(config.targets || []).map(target => target.school)]
  .filter(name => name && !/待选择|请修改/.test(name));
const examCodes = [config.app.exportPrefix, config.profile.exam.match(/\d{3}/)?.[0]].filter(Boolean);
const discovered = new Map();
const existing = await readJson(articlesPath, []);
const previousState = await readJson(statePath, { seenUrls: [], titleHashes: [] });
const existingByUrl = new Map(existing.map(item => [item.url, item]));
const existingByTitle = new Map(existing.map(item => [titleKey(item.title), item]));
const seenUrls = new Set(previousState.seenUrls || []);
const titleHashes = new Set(previousState.titleHashes || []);

function decodeEntities(text = '') {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(html = '') {
  return decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' '))
    .trim();
}

function titleKey(title = '') {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}_—–-]+/gu, '');
}

function canonicalUrl(value, base) {
  try {
    const url = new URL(value, base);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|from|spm|share|source)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return '';
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), rules.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': rules.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml,text/xml,application/javascript;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
    if (!charset) {
      const head = buffer.subarray(0, 4096).toString('ascii');
      charset = /charset=["']?([\w-]+)/i.exec(head)?.[1] || 'utf-8';
    }
    try {
      return { text: new TextDecoder(charset).decode(buffer), finalUrl: response.url };
    } catch {
      return { text: new TextDecoder('utf-8').decode(buffer), finalUrl: response.url };
    }
  } finally {
    clearTimeout(timer);
  }
}

function sourceFor(url) {
  return config.officialSources.find(source => {
    try { return new URL(url).hostname === new URL(source.url).hostname; }
    catch { return false; }
  });
}

function classify(text, fallback = studyCategory) {
  if (/招生简章|专业目录|报考|复试|分数线|推免|推荐.{0,8}免试|免试攻读|录取|调剂|硕士招生/.test(text)) return '官方报考信息';
  if (/经验|上岸|攻略|课程|讲义/.test(text)) return '经验帖与课程资源';
  if (/导师|师资|讲座|学术动态|学院新闻|研究团队|心理学院/.test(text)) return '院校与导师动态';
  if (/备考|复习|参考书|真题|大纲|知识点|心理学/.test(text)) return studyCategory;
  return fallback;
}

function isRelevantCandidate(title = '', summary = '') {
  const text = `${title} ${summary}`;
  if (/baike\.baidu\.com|nike\.com|luogu\.com/.test(title + summary)) return false;
  const relevantWords = ['心理学', '心理学院', '考研', '研究生', ...examCodes, ...schoolWords];
  if (!relevantWords.some(word => text.includes(word))) return false;
  if (/高考|本科录取|专科|薪资招聘|博士后招聘|运动鞋|公路|自然数|奥运会|币圈/.test(title)) return false;
  return true;
}

function relevanceScore(text, url) {
  let score = sourceFor(url) ? 100 : 0;
  try {
    const hostname = new URL(url).hostname;
    if (/(?:^|\.)(edu\.cn|icourse163\.org|psych\.ac\.cn)$/.test(hostname)) score += 25;
    for (const source of config.officialSources) {
      try { if (hostname === new URL(source.url).hostname) score += 80; } catch {}
    }
  } catch {}
  for (const word of [...examCodes, '心理学', ...schoolWords]) {
    if (text.includes(word)) score += examCodes.includes(word) ? 35 : 12;
  }
  if (/心理统计|心理测量|实验心理|发展心理|教育心理|社会心理/.test(text)) score += 12;
  if (/考研政治|马克思主义基本原理|考研英语|学术英语阅读|大学英语创新写作/.test(text) && /icourse163\.org/.test(url)) score += 50;
  if (new RegExp(String(config.profile.examYear)).test(text)) score += 5;
  if (/广告|推广|私信|扫码|加微信|领取资料/.test(text)) score -= 30;
  if (/book118|renrendoc|doc88|shuashuati/.test(url)) score -= 60;
  return score;
}

function shouldKeep(item) {
  const text = `${item.title} ${item.summary}`;
  if (/baike\.baidu\.com|nike\.com|luogu\.com/i.test(item.url)) return false;
  if (/book118|renrendoc|doc88|shuashuati/.test(item.url)) return false;
  if (!item.title || item.title.length < 4) return false;
  const publicCourse = /icourse163\.org/.test(item.url) && /考研政治|马克思主义基本原理|考研英语|学术英语阅读|大学英语创新写作/.test(text);
  const relevantWords = ['心理学', '心理学院', '心理统计', '心理测量', '心理发展', '社会心理', '实验心理', '教育心理', ...examCodes, ...schoolWords];
  if (!relevantWords.some(word => text.includes(word)) && !publicCourse) return false;
  if (/高考|本科录取|专科|薪资招聘|博士后招聘/.test(item.title) && !/研究生|硕士|考研/.test(item.title)) return false;
  if (/本科生.*转专业|转专业.*拟录取/.test(item.title) && !/研究生|硕士/.test(item.title)) return false;
  return relevanceScore(text, item.url) >= 30;
}

function parseRss(xml) {
  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const pick = tag => decodeEntities((block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i')) || [])[1] || '').trim();
    const title = pick('title');
    const url = pick('link');
    const summary = stripHtml(pick('description'));
    if (title && url) items.push({ title, url, summary });
  }
  return items;
}

function extractArticle(html, url, fallbackSummary = '') {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const ogTitle = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1];
  let title = stripHtml(ogTitle || titleTag).replace(/\s*[|_\-–—].*?(?:研究生院|学院|招生).*$/u, '').trim();
  const published = html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|pubdate|publishdate|date)["'][^>]+content=["']([^"']+)/i)?.[1]
    || (html.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/) || []).slice(1).map((v, i) => i === 0 ? v : v.padStart(2, '0')).join('-')
    || '';
  const mainMatch = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  const body = stripHtml(mainMatch?.[1] || html)
    .replace(/^.*?(?:当前位置|您所在的位置).*?(?=[一-龥]{4,})/u, '')
    .slice(0, rules.keepRawTextChars);
  const summary = fallbackSummary || body.split(/(?<=[。！？])/u).filter(s => s.length > 18).slice(0, 3).join('');
  return { title, published, text: body, summary: summary.slice(0, 700) };
}

async function searchBing(query) {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const { text } = await fetchText(url);
  return parseRss(text).slice(0, rules.maxSearchResultsPerQuery);
}

async function discoverFromPage(url) {
  const { text: html, finalUrl } = await fetchText(url);
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const link = canonicalUrl(match[1], finalUrl);
    const title = stripHtml(match[2]);
    if (!link || !/^https?:/.test(link) || !title || title.length < 4) continue;
    if (/javascript:|\.pdf(?:$|\?)|\.docx?(?:$|\?)|\.xlsx?(?:$|\?)/i.test(link)) continue;
    if (!/招生|心理学|心理学院|考研|研究生|复试|推免|导师|讲座|学术|硕士|大纲|真题/.test(title) && !examCodes.some(code => title.includes(code)) && !schoolWords.some(name => title.includes(name))) continue;
    if (new URL(link).hostname !== new URL(finalUrl).hostname) continue;
    links.push({ url: link, title });
  }
  const unique = [...new Map(links.map(item => [item.url, item])).values()];
  return unique.slice(0, rules.maxDiscoveredLinksPerSource);
}

async function parseOfficialCatalog() {
  const catalog = config.collector?.catalog;
  if (!catalog?.url) return null;
  const { text: html, finalUrl } = await fetchText(catalog.url);
  const body = stripHtml(html).slice(0, rules.keepRawTextChars);
  const title = catalog.title || `${config.profile.school}硕士招生专业目录`;
  const majorCodes = catalog.majorCodes || [config.profile.majorCode];
  const summary = `${title}。重点关注专业代码 ${majorCodes.join('、')} 的考试科目、招生人数、复试科目与备注；完整信息以官方页面为准。`;
  return { title, url: finalUrl, published: '', summary, text: body };
}

function markdownEscape(text = '') {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function articleMarkdown(item) {
  const warning = item.isOfficial
    ? '官方来源，但仍应以报考当年最新公告为准。'
    : '第三方来源，仅作线索与经验参考；涉及分数、名额、科目、时间必须回到官网复核。';
  return `---\ntitle: "${item.title.replace(/"/g, '\\"')}"\ncategory: "${item.category}"\nsource: "${item.sourceName}"\nurl: "${item.url}"\npublished: "${item.published || '未知'}"\ncollected: "${item.collectedAt}"\nofficial: ${item.isOfficial}\n---\n\n# ${item.title}\n\n> ${warning}\n\n- 分类：${item.category}\n- 来源：${item.sourceName}\n- 发布：${item.published || '页面未明确标注'}\n- 原文：[打开链接](${item.url})\n- 采集时间：${item.collectedAt}\n\n## 摘要\n\n${item.summary || '未提取到摘要，请查看原文。'}\n\n## 正文摘录\n\n${item.text || '正文未能自动提取。'}\n`;
}

async function writeKnowledgeBase(newItems, runErrors) {
  const grouped = Object.fromEntries(categories.map(category => [category, existing.filter(item => item.category === category)]));
  const index = [
    `# ${config.app.exportPrefix} 心理学考研知识库｜${config.profile.school} ${config.profile.examYear}\n`,
    `> 目标：${config.profile.examYear} 年考研，${config.profile.majorCode} ${config.profile.major}，${config.profile.exam}。\n`,
    `> 重要：招生人数、考试科目、复试科目、报考条件和时间节点，只认目标院校研究生院及研招网当年正式文件。历史信息只能用于准备，不能替代报考当年文件。\n`,
    `- 最近更新：${now.toLocaleString('zh-CN')}`,
    `- 已收录：${existing.length} 条`,
    `- 官方来源：${existing.filter(item => item.isOfficial).length} 条`,
    `- 本次新增：${newItems.length} 条`,
    `- 本次错误：${runErrors.length} 条\n`,
    `## 分类入口\n`,
    ...categories.map(category => `- [${category}](./${encodeURIComponent(category)}.md)：${grouped[category].length} 条`),
    `\n## 使用原则\n`,
    `1. 招生人数、考试科目、复试科目、报考条件和时间节点，只认研究生院及研招网当年正式文件。`,
    `2. 第三方经验帖用于获取复习方法，不直接作为政策依据。`,
    `3. 每条资料都保留来源链接和采集日期；发现内容冲突时，以官方最新公告为准。`,
    `4. 当年文件发布后，重点检查 ${config.profile.majorCode} 的考试科目、招生人数、复试科目和参考书目。\n`,
    `## 最近更新\n`,
    ...(newItems.slice(0, 10).length ? newItems.slice(0, 10).map(item => `- [${item.title}](${item.url})｜${item.category}｜${item.published || '日期未知'}`) : ['- 暂无新增资料。'])
  ];
  await fs.writeFile(path.join(kbDir, '首页.md'), index.join('\n'));

  for (const category of categories) {
    const lines = [
      `# ${category}\n`,
      `> 共 ${grouped[category].length} 条，按官方优先、发布日期排序。\n`
    ];
    const sorted = [...grouped[category]].sort((a, b) => Number(b.isOfficial) - Number(a.isOfficial) || (b.published || '').localeCompare(a.published || ''));
    for (const item of sorted) {
      lines.push(`## ${item.title}\n`);
      lines.push(`- 来源：${item.isOfficial ? '官方' : '第三方'}｜${item.sourceName}`);
      lines.push(`- 发布：${item.published || '未知'}｜采集：${new Date(item.collectedAt).toLocaleDateString('zh-CN')}`);
      lines.push(`- 链接：[原文](${item.url})｜[本地摘录](./资料/${item.id}.md)`);
      lines.push(`- 摘要：${item.summary || '无'}\n`);
    }
    await fs.writeFile(path.join(kbDir, `${category}.md`), lines.join('\n'));
  }

  const daily = [
    `# ${now.toLocaleDateString('zh-CN')} 更新日报\n`,
    `本次运行：${now.toLocaleString('zh-CN')}\n`,
    `新增资料：${newItems.length} 条；失败请求：${runErrors.length} 次。\n`,
    `## 新增资料\n`,
    ...(newItems.length ? newItems.map(item => `### ${item.category}\n\n- [${item.title}](${item.url})\n- 来源：${item.sourceName}（${item.isOfficial ? '官方' : '第三方'}）\n- 摘要：${item.summary || '无'}\n`) : ['本次没有新增资料；已有资料可能已更新。\n']),
    `## 需要人工复核\n`,
    `- 所有第三方资料中的名额、分数线、科目、参考书和时间，均需与官网核对。`,
    `- 当年正式招生文件发布后，应重新核对 ${config.profile.majorCode} 的 ${config.profile.exam} 科目、复试科目和招生人数。\n`,
    `## 运行错误\n`,
    ...(runErrors.length ? runErrors.map(error => `- ${error}`) : ['- 无'])
  ];
  await fs.writeFile(path.join(dailyDir, `${now.toISOString().slice(0, 10)}.md`), daily.join('\n'));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function addItem(raw, sourceName = '') {
  const item = {
    id: crypto.createHash('sha1').update(raw.url).digest('hex').slice(0, 12),
    title: raw.title.trim(),
    url: raw.url,
    published: raw.published || '',
    collectedAt: runId,
    category: raw.category || classify(`${raw.title} ${raw.summary}`),
    sourceName: sourceName || sourceFor(raw.url)?.name || new URL(raw.url).hostname,
    isOfficial: Boolean(sourceFor(raw.url)) || /(?:^|\.)(edu\.cn|chsi\.com\.cn)$/i.test(new URL(raw.url).hostname),
    summary: raw.summary || '',
    text: raw.text || '',
    contentHash: crypto.createHash('sha1').update(`${raw.title}\n${raw.text || raw.summary}`).digest('hex')
  };
  if (!shouldKeep(item)) return null;
  const oldByUrl = existingByUrl.get(item.url);
  const oldByTitle = existingByTitle.get(titleKey(item.title));
  const old = oldByUrl || oldByTitle;
  if (old) {
    old.category = item.category || old.category;
    if (old.contentHash !== item.contentHash) {
      old.summary = item.summary || old.summary;
      old.text = item.text || old.text;
      old.published = item.published || old.published;
      old.contentHash = item.contentHash;
      old.collectedAt = runId;
      await fs.writeFile(path.join(kbDir, '资料', `${old.id}.md`), articleMarkdown(old));
      return { ...old, changed: true };
    }
    return null;
  }
  existing.push(item);
  existingByUrl.set(item.url, item);
  existingByTitle.set(titleKey(item.title), item);
  await fs.mkdir(path.join(kbDir, '资料'), { recursive: true });
  await fs.writeFile(path.join(kbDir, '资料', `${item.id}.md`), articleMarkdown(item));
  return item;
}

let fetched = 0;
async function processCandidate(candidate, sourceName = '') {
  if (fetched >= rules.maxArticlesPerRun) return;
  if (discovered.has(candidate.url) || seenUrls.has(candidate.url)) return;
  const officialCandidate = Boolean(sourceFor(candidate.url)) || /(?:^|\.)(edu\.cn|chsi\.com\.cn)$/i.test(new URL(candidate.url).hostname);
  const officialAdmissionsTitle = officialCandidate && /招生|初试|复试|推免|免试|报考|录取|考试|报名/.test(candidate.title);
  if (!isRelevantCandidate(candidate.title, candidate.summary) && !officialAdmissionsTitle) return;
  discovered.set(candidate.url, candidate);
  try {
    const { text: html, finalUrl } = await fetchText(candidate.url);
    const article = extractArticle(html, finalUrl, candidate.summary);
    const item = await addItem({ ...article, url: finalUrl }, sourceName || sourceFor(finalUrl)?.name || '');
    seenUrls.add(finalUrl);
    if (item && !item.changed) newItems.push(item);
    fetched += 1;
  } catch (error) {
    if (candidate.summary && !sourceFor(candidate.url)) {
      const item = await addItem({
        title: candidate.title,
        url: candidate.url,
        summary: `${candidate.summary}（正文抓取失败，以上为搜索摘要）`,
        text: '',
        published: ''
      }, sourceName || '必应检索');
      if (item && !item.changed) newItems.push(item);
      seenUrls.add(candidate.url);
    } else {
      errors.push(`${candidate.title}｜${candidate.url}｜${error.message}`);
    }
  } finally {
    await delay(rules.delayMs);
  }
}

async function processCuratedResource(resource) {
  try {
    const { text: html, finalUrl } = await fetchText(resource.url);
    const article = extractArticle(html, finalUrl);
    const targetUrl = new URL(finalUrl).pathname === '/' && new URL(resource.url).pathname !== '/'
      ? resource.url
      : finalUrl;
    const item = await addItem({
      ...article,
      title: resource.name,
      url: targetUrl,
      category: resource.category,
      summary: resource.summary || article.summary
    }, resource.name);
    seenUrls.add(targetUrl);
    if (item && !item.changed) newItems.push(item);
  } catch (error) {
    if (resource.summary) {
      const item = await addItem({
        title: resource.name,
        url: resource.url,
        category: resource.category,
        summary: `${resource.summary}（正文抓取失败，以上为精选资源说明）`,
        text: ''
      }, resource.name);
      if (item && !item.changed) newItems.push(item);
    } else {
      errors.push(`精选资源失败｜${resource.name}｜${resource.url}｜${error.message}`);
    }
  } finally {
    await delay(rules.delayMs);
  }
}

const newItems = [];
console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 开始采集 ${config.profile.school} ${config.profile.exam} ...`);

try {
  const catalog = await parseOfficialCatalog();
  if (catalog) {
    const catalogItem = await addItem({ ...catalog, category: '官方报考信息' }, config.collector.catalog.sourceName || `${config.profile.school}研究生院-专业目录`);
    if (catalogItem && !catalogItem.changed) newItems.push(catalogItem);
  }
} catch (error) {
  errors.push(`专业目录解析失败｜${error.message}`);
}

for (const resource of config.curatedResources || []) {
  await processCuratedResource(resource);
}

for (const query of config.searchQueries) {
  try {
    const results = await searchBing(query);
    console.log(`检索：${query} -> ${results.length} 条`);
    for (const result of results) await processCandidate(result, '必应检索');
  } catch (error) {
    errors.push(`搜索失败｜${query}｜${error.message}`);
  }
  await delay(rules.delayMs);
}

for (const source of config.officialSources) {
  try {
    const { text: html, finalUrl } = await fetchText(source.url);
    const article = extractArticle(html, finalUrl);
    const item = await addItem({ ...article, url: finalUrl, category: source.category }, source.name);
    if (item && !item.changed) newItems.push(item);
    seenUrls.add(finalUrl);
    if (source.discoverLinks) {
      const links = await discoverFromPage(finalUrl);
      console.log(`官方栏目：${source.name} -> ${links.length} 个链接`);
      for (const link of links) await processCandidate(link, source.name);
    }
  } catch (error) {
    errors.push(`官方来源失败｜${source.name}｜${error.url || source.url}｜${error.message}`);
  }
  await delay(rules.delayMs);
}

for (const item of existing) titleHashes.add(titleKey(item.title));
await fs.writeFile(articlesPath, JSON.stringify(existing, null, 2));
await fs.writeFile(statePath, JSON.stringify({
  lastRunAt: runId,
  seenUrls: [...seenUrls],
  titleHashes: [...titleHashes]
}, null, 2));
await fs.writeFile(errorsPath, JSON.stringify({ runAt: runId, errors }, null, 2));
await writeKnowledgeBase(newItems, errors);

console.log(`完成：新增 ${newItems.length} 条，总计 ${existing.length} 条，错误 ${errors.length} 次。`);
console.log(`知识库：${kbDir}`);
if (errors.length) console.log(`错误详情：${errorsPath}`);
