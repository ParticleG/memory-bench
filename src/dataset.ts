import { countTokens } from './runtime';
import type { Corpus, Dataset, Document, EvalQuery, GoldFact } from './types';

const COMPONENTS = ['scheduler', 'session-store', 'renderer', 'backup', 'task-inbox', 'router', 'upload-worker', 'auth-broker', 'cache', 'notifier', 'compiler', 'exporter', 'indexer', 'sync-worker', 'billing', 'migration', 'webhook', 'queue', 'search', 'preview', 'auditor', 'allocator', 'scanner', 'watcher'];
const CATEGORIES = ['direct', 'paraphrase', 'cross-language', 'multi-hop', 'knowledge-update', 'temporal', 'short-correction', 'rejected-decision', 'scope-isolation', 'abstention', 'long-tail', 'multi-hop'];
function literal(seed: number, corpus: number, component: number, slot: number): string {
  let value = (seed ^ Math.imul(corpus + 1, 2654435761) ^ Math.imul(component + 1, 2246822519) ^ Math.imul(slot + 1, 3266489917)) >>> 0;
  value ^= value >>> 16;
  return `v${(value >>> 0).toString(36).padStart(7, '0')}`;
}

/** Replays dated conversations; identifiers never encode gold-answer membership. */
export function createDataset(seed = 20261018, now = new Date(), small = false): Dataset {
  const corpora: Corpus[] = [];
  const facts: GoldFact[] = [];
  const queries: EvalQuery[] = [];
  const base = now.getTime() - 9 * 86400000;
  const components = small ? COMPONENTS.slice(0, 4) : COMPONENTS;
  for (let c = 0; c < (small ? 2 : 4); c++) {
    const language = c % 2 === 0 ? 'en' : 'zh';
    const corpusId = `workspace-${c + 1}`;
    const projectId = `atlas-${['east', 'west', 'north', 'south'][c]}`;
    const documents: Document[] = [];
    const byComponent: { guard: GoldFact; route: GoldFact; old: GoldFact; current: GoldFact; short?: GoldFact }[] = [];
    const addFact = (component: number, slot: number, text: string, value: string, source: string, stale = false): GoldFact => {
      const fact: GoldFact = { id: `f-${c}-${component}-${slot}`, corpusId, text, aliases: [value], sourceDocumentIds: [source], ...(stale ? { stale: true } : {}) };
      facts.push(fact);
      return fact;
    };
    for (let i = 0; i < components.length; i++) {
      const name = components[i];
      const id = `session-${c}-${i}`;
      const guardValue = `atlas-${literal(seed, c, i, 0)}-guard`;
      const routeValue = `route-${literal(seed, c, i, 1)}`;
      const oldValue = `profile-${literal(seed, c, i, 2)}`;
      const newValue = `profile-${literal(seed, c, i, 3)}`;
      const guard = addFact(i, 0, `The ${name} regression guard in ${projectId} is ${guardValue}.`, guardValue, id);
      const route = addFact(i, 1, `The ${name} failover route in ${projectId} is ${routeValue}.`, routeValue, id);
      const old = addFact(i, 2, `Before its correction, the ${name} recovery profile in ${projectId} was ${oldValue}.`, oldValue, id, true);
      const current = addFact(i, 3, `The corrected current ${name} recovery profile in ${projectId} is ${newValue}.`, newValue, `revision-${c}-${i}`);
      let user = language === 'en'
        ? `We are working in ${projectId}, in the Atlas ${name} subsystem. The previous release regressed after the implementation was simplified. Keep these subtle non-code-visible operational invariants across sessions. Run the regression guard \`${guardValue}\` before publishing a build; this check is required even when unit tests pass. The failover route must be \`${routeValue}\`; routing to a generic fallback caused duplicate jobs. Our current recovery profile is \`${oldValue}\`. This profile is an operations decision rather than a fact discoverable from repository code. Please remember these exact opaque identifiers: near-matching identifiers refer to different environments. We will explicitly correct the profile in a later session if operations changes it.`
        : `现在处理 ${projectId} 的 Atlas ${name} 子系统。上一次简化实现后发生了回归，请跨会话保留这些无法从代码推导的运行约束。发布前必须运行回归检查 \`${guardValue}\`，不能用单元测试通过代替。故障转移路由必须是 \`${routeValue}\`，通用 fallback 曾经导致任务重复。当前恢复配置是 \`${oldValue}\`。这是运营决策，不是仓库代码中的事实。请保留这些不透明标识符的精确拼写，近似标识符属于不同环境；如果之后更换配置，我会明确更正。`;
      if (!small) {
        const transient: string[] = [];
        for (let n = 0; n < 15; n++) {
          transient.push(`Trace segment ${i * 15 + n}: the ${name} staging probe visited temporary shard ${String.fromCharCode(65 + n)} during the exploratory run. A request entered the local buffer, crossed the asynchronous callback boundary, and reached the observer after the next event-loop turn. The provisional trace attached the local sequence to the rendering ticket, emitted a diagnostic line, then discarded the ticket after the simulated worker returned. This output documents a one-off investigation, not a durable setting or user preference. The timing and trace order are illustrative and do not change any release invariant above.`);
        }
        user += `\n\nThe following disposable diagnostic transcript is not a durable instruction:\n\`\`\`text\n${transient.join('\n')}\n\`\`\``;
      }
      documents.push({ id, timestamp: new Date(base + i * 900000).toISOString(), messages: [{ role: 'user', content: user }, { role: 'assistant', content: language === 'en' ? `Understood. I will preserve the ${name} guard, route, and recovery profile; the disposable trace is not a long-term decision.` : `已记录 ${name} 的回归检查、路由和恢复配置；一次性日志不作为长期决策。` }] });
      byComponent.push({ guard, route, old, current });
    }
    for (let i = 0; i < components.length; i++) {
      const name = components[i];
      const pair = byComponent[i];
      const newValue = pair.current.aliases[0];
      const oldValue = pair.old.aliases[0];
      const messages: Document['messages'] = [{ role: 'user', content: language === 'en'
        ? `Explicit reversal for Atlas ${name} in ${projectId}: do not use the recovery profile ${oldValue} any more. It caused a production regression. The current recovery profile is now ${newValue}. Preserve the guard and failover route from the earlier session. This is an ongoing operational constraint, not a request to edit code in this turn.`
        : `明确更正 ${projectId} 的 Atlas ${name}：恢复配置不能再用 ${oldValue}，该方案导致了生产回归。现在改为 ${newValue}。之前的回归检查和故障转移路由不变。这是持续有效的运行约束，不是本轮临时修改代码的请求。` }];
      if (i === 6 || i === 7 || (small && i === 1)) {
        const shortValue = literal(seed, c, i, 4).slice(-6);
        messages.push({ role: 'assistant', content: language === 'en' ? `Confirm the final recovery alias for ${name}; the operations team may replace ${newValue}.` : `请确认 ${name} 最终恢复配置别名，运营团队可能替换 ${newValue}。` });
        messages.push({ role: 'user', content: language === 'en' ? `Use ${shortValue}.` : `改用${shortValue}。` });
        const short = addFact(i, 4, `After the short correction, the current ${name} recovery alias in ${projectId} is ${shortValue}.`, shortValue, `revision-${c}-${i}`);
        pair.short = short;
        pair.current.stale = true;
      }
      messages.push({ role: 'assistant', content: language === 'en' ? `I will use the latest explicit ${name} correction and will not silently restore a rejected profile.` : `会遵循 ${name} 最新明确更正，不会擅自恢复已经否定的配置。` });
      documents.push({ id: `revision-${c}-${i}`, timestamp: new Date(base + 2 * 86400000 + i * 900000).toISOString(), messages });
    }
    corpora.push({ id: corpusId, projectId, language, documents });
    const queryCount = small ? 6 : 24;
    for (let q = 0; q < queryCount; q++) {
      const category = small ? ['direct', 'knowledge-update', 'multi-hop', 'short-correction', 'scope-isolation', 'abstention'][q] : CATEGORIES[Math.floor(q / 2)];
      const i = category === 'short-correction' ? (small ? 1 : 6 + q % 2) : q % components.length;
      const name = components[i];
      const pair = byComponent[i];
      const current = pair.short ?? pair.current;
      let required = [pair.guard];
      let forbidden: GoldFact[] = [];
      let text = language === 'en' ? `What is the exact regression guard for Atlas ${name} in this workspace?` : `当前工作区 Atlas ${name} 的回归检查精确名称是什么？`;
      if (category === 'paraphrase' || category === 'long-tail') text = language === 'en' ? `Before shipping changes to ${name}, which non-obvious release check must not be omitted, even if the unit suite is green? Give its exact identifier.` : `${name} 即使单元测试全绿，发布前仍然不能省略哪个曾防止回归的检查？给出精确标识符。`;
      if (category === 'cross-language') text = language === 'en' ? `Atlas ${name} 发生故障时应切换到哪个路由？给出精确标识符。` : `Which exact failover route must Atlas ${name} use after an outage?`;
      if (category === 'cross-language') required = [pair.route];
      if (category === 'multi-hop') {
        const next = (i + 5) % components.length;
        required = [pair.route, byComponent[next].guard];
        text = language === 'en' ? `List two exact identifiers: the failover route for Atlas ${name}, and the regression guard for Atlas ${components[next]}.` : `给出两个精确标识符：Atlas ${name} 的故障转移路由，以及 Atlas ${components[next]} 的回归检查。`;
      }
      if (['knowledge-update', 'short-correction', 'rejected-decision'].includes(category)) {
        required = [current]; forbidden = [pair.old, ...(pair.short ? [pair.current] : [])];
        text = language === 'en' ? `After all explicit corrections, what recovery profile or alias should Atlas ${name} use now? Give only the final current identifier, not a rejected one.` : `全部明确更正之后，Atlas ${name} 现在应使用哪个恢复配置或别名？只给最终有效标识符，不要给已否定的配置。`;
      }
      if (category === 'temporal') {
        required = [pair.old]; forbidden = [current];
        text = language === 'en' ? `Before the explicit recovery-profile reversal, what recovery profile did Atlas ${name} use? I need the historical value, not today's replacement.` : `恢复配置被明确否定之前，Atlas ${name} 使用哪个配置？需要历史值，而不是今天的替代值。`;
      }
      if (category === 'scope-isolation') { required = [pair.route]; text = language === 'en' ? `For ${projectId} ONLY, what is the Atlas ${name} failover route? Ignore other Atlas workspaces.` : `只针对 ${projectId}，Atlas ${name} 的故障转移路由是什么？忽略其他 Atlas 工作区。`; }
      if (category === 'abstention') { required = []; text = language === 'en' ? `What is the one-time disaster-recovery unlock secret for Atlas ${name}? If it was never supplied, say UNKNOWN.` : `Atlas ${name} 的一次性灾难恢复解锁秘密是什么？从未提供过就回答 UNKNOWN。`; }
      queries.push({ id: `q-${c}-${q}`, corpusId, projectId, text, asOf: new Date(base + 6 * 86400000).toISOString(), category, language: category === 'cross-language' ? language === 'en' ? 'zh' : 'en' : language, requiredFactIds: required.map(fact => fact.id), forbiddenFactIds: forbidden.map(fact => fact.id), answerable: required.length > 0 });
    }
  }
  const aliases = facts.flatMap(fact => fact.aliases);
  if (new Set(aliases).size !== aliases.length) throw new Error('Dataset has colliding literal answer values');
  for (const corpus of corpora) {
    const input = JSON.stringify(corpus);
    for (const query of queries.filter(query => query.corpusId === corpus.id)) if (input.includes(query.text)) throw new Error('Question leaked into ingestion');
  }
  return { version: small ? 'coding-literals-smoke-v1' : 'coding-literals-v1', corpora, facts, queries, provenance: { author: 'Controlled synthetic coding-memory workload', seed, generatedAt: now.toISOString(), historicalReplay: true, goldScoring: 'Unique literal evidence coverage; not general semantic recall', queryLabelsExcludedFromIngestion: true, corpusTokens: Object.fromEntries(corpora.map(corpus => [corpus.id, corpus.documents.reduce((sum, doc) => sum + countTokens(doc.messages.map(message => message.content).join('\n')), 0)])), counts: { corpora: corpora.length, documents: corpora.reduce((sum, corpus) => sum + corpus.documents.length, 0), facts: facts.length, queries: queries.length }, publicBenchmarkScoresComparable: false } };
}

/** Grow the same banks with distinct, similarly named subsystems, not isolated extra users. */
export function createScaleDataset(source: Dataset, factor: number): Dataset {
  if (!Number.isInteger(factor) || factor < 2) throw new Error('Scale factor must be an integer >=2');
  const result = structuredClone(source);
  const seed = Number(source.provenance.seed);
  const generatedAt = new Date(String(source.provenance.generatedAt));
  const queryCohorts: Record<string, string> = Object.fromEntries(source.queries.map(query => [query.id, 'anchor']));
  const componentPattern = new RegExp(`\\b(${COMPONENTS.join('|')})\\b`, 'g');
  for (let shard = 1; shard < factor; shard++) {
    const extra = createDataset(seed + shard * 7919, generatedAt);
    const prefix = `scale-${shard}-`;
    const qualify = (text: string) => text.replace(componentPattern, name => `${name}-cell-${String(shard).padStart(3, '0')}`);
    for (const corpus of extra.corpora) {
      const target = result.corpora.find(item => item.id === corpus.id)!;
      const original = source.corpora.find(item => item.id === corpus.id)!;
      const start = Math.max(...original.documents.map(document => Date.parse(document.timestamp))) + 60_000;
      const end = Math.min(...source.queries.filter(query => query.corpusId === corpus.id).map(query => Date.parse(query.asOf))) - 60_000;
      if (end <= start) throw new Error('Source history has no pre-query interval for chronological growth');
      const ordered = corpus.documents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      for (let index = 0; index < ordered.length; index++) {
        const document = ordered[index];
        const position = (index * (factor - 1) + shard - 1) / (ordered.length * (factor - 1) - 1);
        target.documents.push({
          id: prefix + document.id,
          timestamp: new Date(start + Math.floor(position * (end - start))).toISOString(),
          messages: document.messages.map(message => ({ ...message, content: qualify(message.content) })),
        });
      }
    }
    result.facts.push(...extra.facts.map(fact => ({
      ...fact, id: prefix + fact.id, text: qualify(fact.text),
      sourceDocumentIds: fact.sourceDocumentIds.map(id => prefix + id),
    })));
    // Four stratified held-out questions per new cell/workspace; original questions stay unchanged.
    const selected = new Set(Array.from({ length: 4 }, (_, index) => ((shard - 1) * 4 + index) % 24));
    for (const query of extra.queries) {
      if (!selected.has(Number(query.id.split('-').at(-1)))) continue;
      const id = prefix + query.id;
      result.queries.push({
        ...query, id, text: qualify(query.text),
        requiredFactIds: query.requiredFactIds.map(id => prefix + id),
        forbiddenFactIds: query.forbiddenFactIds.map(id => prefix + id),
      });
      queryCohorts[id] = 'new';
    }
  }
  for (const corpus of result.corpora) corpus.documents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const aliases = result.facts.flatMap(fact => fact.aliases);
  if (new Set(aliases).size !== aliases.length) throw new Error('Scaled dataset has colliding identifiers');
  result.version = 'coding-literals-scale-v1';
  result.provenance = {
    ...source.provenance, scaleFactor: factor, queryCohorts,
    scaleDesign: 'Chronological same-bank growth with distinct qualified subsystem names and independently generated opaque values. Original anchor documents/questions remain unchanged; new held-out questions are reported separately. This is a controlled density experiment, not a public conversational benchmark.',
    corpusTokens: Object.fromEntries(result.corpora.map(corpus => [corpus.id, corpus.documents.reduce((sum, document) => sum + countTokens(document.messages.map(message => message.content).join('\n')), 0)])),
    counts: { corpora: result.corpora.length, documents: result.corpora.reduce((sum, corpus) => sum + corpus.documents.length, 0), facts: result.facts.length, queries: result.queries.length },
  };
  return result;
}
