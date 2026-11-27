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
const newItems = [];
const categoryNames = Object.fromEntries(config.resourceCategories.map(category => [category.id, category.name]));
const categories = config.resourceCategories.map(category => category.name);
const placeholder = /待填写|请修改|TARGET|PRIMARY|ALTERNATE|FALLBACK|我的考试|目标项目/i;
const cleanTerms = values => [...new Set(values.map(value => String(value || '').trim()).filter(value => value && !placeholder.test(value)))];
const organizationWords = cleanTerms([config.profile.organization, ...config.targets.map(target => target.organization)]);
const programCodes = cleanTerms([
  config.profile.programCode,
  ...(config.collector.catalog.programCodes || [])
]);
const searchTerms = cleanTerms([
  config.profile.exam,
  config.profile.program,
  ...programCodes,
  ...organizationWords,
  ...(config.collector.keywords || [])
]);
const excludedKeywords = config.collector.excludeKeywords || [];
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
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
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

function isTrustedDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return (config.collector.trustedDomains || []).some(domain =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function classify(text, fallback = categoryNames.study) {
  if (/招生|报考|报名|考试|大纲|分数线|成绩|录取|政策|通知|公告/.test(text)) return categoryNames.official;
  if (/经验|攻略|课程|讲义|视频|题库/.test(text)) return categoryNames.resources;
  if (/导师|师资|讲座|新闻|动态|机构|研究团队/.test(text)) return categoryNames.updates;
  if (/备考|复习|参考书|真题|知识点|练习/.test(text)) return categoryNames.study;
  return fallback;
}

function isRelevantCandidate(title = '', summary = '') {
  const text = `${title} ${summary}`;
  return searchTerms.some(term => text.toLowerCase().includes(term.toLowerCase()));
}

function relevanceScore(text, url) {
  let score = sourceFor(url) ? 180 : 0;
  if (isTrustedDomain(url)) score += 25;
  for (const term of searchTerms) {
    if (text.toLowerCase().includes(term.toLowerCase())) score += programCodes.includes(term) ? 35 : 12;
  }
  if (String(config.profile.examYear) && text.includes(String(config.profile.examYear))) score += 5;
  if (excludedKeywords.some(keyword => text.includes(keyword))) score -= 30;
  return score;
}

function shouldKeep(item, trusted = false) {
  const text = `${item.title} ${item.summary}`;
  if (/javascript:|^$/i.test(item.url)) return false;
  if (!item.title || item.title.trim().length < 4) return false;
  if (trusted || sourceFor(item.url)) return true;
  if (excludedKeywords.some(keyword => text.includes(keyword))) return false;
  if (!isRelevantCandidate(item.title, item.summary)) return false;
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
  let title = stripHtml(ogTitle || titleTag).replace(/\s*[|_\-–—].*?(?:官网|招生|考试|机构).*$/u, '').trim();
  const published = html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|pubdate|publishdate|date)["'][^>]+content=["']([^"']+)/i)?.[1]
    || (html.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/) || []).slice(1).map((value, index) => index === 0 ? value : value.padStart(2, '0')).join('-')
    || '';
  const mainMatch = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  const body = stripHtml(mainMatch?.[1] || html)
    .replace(/^.*?(?:当前位置|您所在的位置).*?(?=[一-龥]{4,})/u, '')
    .slice(0, rules.keepRawTextChars);
  const summary = fallbackSummary || body.split(/(?<=[。！？])/u).filter(sentence => sentence.length > 18).slice(0, 3).join('');
  return { title, published, text: body, summary: summary.slice(0, 700) };
}

async function searchProvider(query) {
  const endpoint = config.collector.searchEndpoint.replace('{query}', encodeURIComponent(query));
  const { text } = await fetchText(endpoint);
  return parseRss(text).slice(0, rules.maxSearchResultsPerQuery);
}

async function discoverFromPage(url) {
  const { text: html, finalUrl } = await fetchText(url);
  const links = [];
  const linkWords = [...(config.collector.linkKeywords || []), ...searchTerms];
  for (const match of html.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const link = canonicalUrl(match[1], finalUrl);
    const title = stripHtml(match[2]);
    if (!link || !/^https?:/.test(link) || !title || title.length < 4) continue;
    if (/javascript:|\.pdf(?:$|\?)|\.docx?(?:$|\?)|\.xlsx?(?:$|\?)/i.test(link)) continue;
    if (!linkWords.some(word => title.includes(word))) continue;
    if (new URL(link).hostname !== new URL(finalUrl).hostname) continue;
    links.push({ url: link, title });
  }
  const unique = [...new Map(links.map(item => [item.url, item])).values()];
  return unique.slice(0, rules.maxDiscoveredLinksPerSource);
}

async function parseOfficialCatalog() {
  const catalog = config.collector.catalog;
  if (!catalog.url) return null;
  const { text: html, finalUrl } = await fetchText(catalog.url);
  const body = stripHtml(html).slice(0, rules.keepRawTextChars);
  const title = catalog.title || `${config.profile.organization}官方考试目录`;
  const codes = catalog.programCodes || programCodes;
  const summary = `${title}。${codes.length ? `重点关注代码 ${codes.join('、')} 的` : '请核对'}考试科目、报考条件、时间安排与备注；完整信息以官方页面为准。`;
  return { title, url: finalUrl, published: '', summary, text: body };
}

function articleMarkdown(item) {
  const warning = item.isOfficial
    ? '官方来源，但仍应以当前考试周期的最新公告为准。'
    : '第三方来源，仅作线索与经验参考；涉及考试科目、名额、分数、条件和时间必须回到官网复核。';
  return `---\ntitle: "${item.title.replace(/"/g, '\\"')}"\ncategory: "${item.category}"\nsource: "${item.sourceName}"\nurl: "${item.url}"\npublished: "${item.published || '未知'}"\ncollected: "${item.collectedAt}"\nofficial: ${item.isOfficial}\n---\n\n# ${item.title}\n\n> ${warning}\n\n- 分类：${item.category}\n- 来源：${item.sourceName}\n- 发布：${item.published || '页面未明确标注'}\n- 原文：[打开链接](${item.url})\n- 采集时间：${item.collectedAt}\n\n## 摘要\n\n${item.summary || '未提取到摘要，请查看原文。'}\n\n## 正文摘录\n\n${item.text || '正文未能自动提取。'}\n`;
}

async function writeKnowledgeBase(items, runErrors) {
  const grouped = Object.fromEntries(categories.map(category => [category, existing.filter(item => item.category === category)]));
  const index = [
    `# ${config.app.name} 知识库｜${config.profile.organization} ${config.profile.examYear}\n`,
    `> 考试：${config.profile.examYear} 年${config.profile.examType}，${config.profile.programCode ? config.profile.programCode + ' ' : ''}${config.profile.program}，${config.profile.exam}。\n`,
    `> 重要：考试科目、报考条件、考试时间和相关安排，只认考试机构与官方平台当前正式文件。\n`,
    `- 最近更新：${now.toLocaleString('zh-CN')}`,
    `- 已收录：${existing.length} 条`,
    `- 官方来源：${existing.filter(item => item.isOfficial).length} 条`,
    `- 本次新增：${items.length} 条`,
    `- 本次错误：${runErrors.length} 条\n`,
    `## 分类入口\n`,
    ...categories.map(category => `- [${category}](./${encodeURIComponent(category)}.md)：${grouped[category].length} 条`),
    `\n## 使用原则\n`,
    `1. 考试科目、报考条件、考试时间和相关安排，以官方当前正式文件为准。`,
    `2. 第三方经验帖用于获取学习方法，不直接作为政策依据。`,
    `3. 每条资料都保留来源链接和采集日期；内容冲突时，以官方最新公告为准。`,
    `4. 考试信息变化后，重新核对范围、日期、条件和资料版本。\n`,
    `## 最近更新\n`,
    ...(items.slice(0, 10).length ? items.slice(0, 10).map(item => `- [${item.title}](${item.url})｜${item.category}｜${item.published || '日期未知'}`) : ['- 暂无新增资料。'])
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
    `新增资料：${items.length} 条；失败请求：${runErrors.length} 次。\n`,
    `## 新增资料\n`,
    ...(items.length ? items.map(item => `### ${item.category}\n\n- [${item.title}](${item.url})\n- 来源：${item.sourceName}（${item.isOfficial ? '官方' : '第三方'}）\n- 摘要：${item.summary || '无'}\n`) : ['本次没有新增资料；已有资料可能已更新。\n']),
    `## 需要人工复核\n`,
    `- 所有第三方资料中的名额、分数线、科目、参考书和时间，均需与官网核对。`,
    `- 当前正式文件发布后，重新核对 ${config.profile.programCode || config.profile.program} 的 ${config.profile.exam} 范围、条件和时间安排。\n`,
    `## 运行错误\n`,
    ...(runErrors.length ? runErrors.map(error => `- ${error}`) : ['- 无'])
  ];
  await fs.writeFile(path.join(dailyDir, `${now.toISOString().slice(0, 10)}.md`), daily.join('\n'));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function addItem(raw, sourceName = '', trusted = false) {
  let url;
  try { url = new URL(raw.url).toString(); }
  catch { return null; }
  const official = trusted || Boolean(sourceFor(url)) || isTrustedDomain(url);
  const item = {
    id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 12),
    title: raw.title.trim(),
    url,
    published: raw.published || '',
    collectedAt: runId,
    category: categories.includes(raw.category) ? raw.category : classify(`${raw.title} ${raw.summary}`),
    sourceName: sourceName || sourceFor(url)?.name || new URL(url).hostname,
    isOfficial: official,
    summary: raw.summary || '',
    text: raw.text || '',
    contentHash: crypto.createHash('sha1').update(`${raw.title}\n${raw.text || raw.summary}`).digest('hex')
  };
  if (!shouldKeep(item, official)) return null;
  const old = existingByUrl.get(item.url) || existingByTitle.get(titleKey(item.title));
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
  const officialCandidate = Boolean(sourceFor(candidate.url)) || isTrustedDomain(candidate.url);
  const officialTitle = officialCandidate && /招生|报考|报名|考试|大纲|成绩|录取|政策|通知|公告/.test(candidate.title);
  if (!isRelevantCandidate(candidate.title, candidate.summary) && !officialTitle) return;
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
      }, sourceName || config.collector.searchProviderName);
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
    }, resource.name, true);
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
      }, resource.name, true);
      if (item && !item.changed) newItems.push(item);
    } else {
      errors.push(`精选资源失败｜${resource.name}｜${resource.url}｜${error.message}`);
    }
  } finally {
    await delay(rules.delayMs);
  }
}

console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 开始采集 ${config.profile.organization} ${config.profile.exam} ...`);

try {
  const catalog = await parseOfficialCatalog();
  if (catalog) {
    const item = await addItem({ ...catalog, category: categoryNames.official }, config.collector.catalog.sourceName || '官方考试目录', true);
    if (item && !item.changed) newItems.push(item);
  }
} catch (error) {
  errors.push(`官方目录解析失败｜${error.message}`);
}

for (const resource of config.curatedResources) {
  await processCuratedResource(resource);
}

for (const query of config.searchQueries) {
  try {
    const results = await searchProvider(query);
    console.log(`检索：${query} -> ${results.length} 条`);
    for (const result of results) await processCandidate(result, config.collector.searchProviderName);
  } catch (error) {
    errors.push(`搜索失败｜${query}｜${error.message}`);
  }
  await delay(rules.delayMs);
}

for (const source of config.officialSources) {
  try {
    const { text: html, finalUrl } = await fetchText(source.url);
    const article = extractArticle(html, finalUrl);
    const item = await addItem({ ...article, url: finalUrl, category: source.category }, source.name, true);
    seenUrls.add(finalUrl);
    if (item && !item.changed) newItems.push(item);
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
