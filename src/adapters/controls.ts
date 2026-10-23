import { Database } from 'bun:sqlite';
import type { AdapterFactory, Corpus, MemoryItem } from '../types';

export const createNoMemoryAdapter: AdapterFactory = async () => ({ id: 'no-memory', name: 'No memory', mode: 'control', ingest: async () => {}, retrieve: async () => ({ items: [] }), close: async () => {}, diagnostics: () => ({ implementation: 'Empty-context negative control' }) });

/** Actual SQLite FTS5/BM25 over raw conversation sessions; not presented as an omp backend. */
export const createBm25Adapter: AdapterFactory = async () => {
  const databases = new Map<string, Database>();
  const corpusStats: Record<string, { documents: number }> = {};
  return { id: 'bm25', name: 'SQLite FTS5 BM25 control', mode: 'query-retrieval',
    async ingest(corpora: Corpus[]) {
      for (const corpus of corpora) {
        const database = new Database(':memory:');
        database.exec("CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED, text, tokenize='trigram')");
        const insert = database.prepare('INSERT INTO documents (id,text) VALUES (?,?)');
        database.transaction(() => { for (const document of corpus.documents) insert.run(document.id, `${document.timestamp}\n${document.messages.map(message => `${message.role}: ${message.content}`).join('\n')}`); })();
        databases.set(corpus.id, database); corpusStats[corpus.id] = { documents: corpus.documents.length };
      }
    },
    async retrieve(query) {
      const database = databases.get(query.corpusId);
      if (!database) throw new Error(`Unknown corpus: ${query.corpusId}`);
      const english = query.text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
      const han = (query.text.match(/\p{Script=Han}+/gu) ?? []).flatMap(segment => Array.from({ length: Math.max(0, [...segment].length - 2) }, (_, index) => [...segment].slice(index, index + 3).join('')));
      const terms = [...new Set([...english, ...han])];
      if (!terms.length) return { items: [], metadata: { engine: 'SQLite FTS5', tokenizer: 'trigram' } };
      const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const rows = database.prepare('SELECT id,text,bm25(documents) AS rank FROM documents WHERE documents MATCH ? ORDER BY rank LIMIT 32').all(expression) as { id: string; text: string; rank: number }[];
      const items: MemoryItem[] = rows.map(row => ({ id: row.id, text: row.text, sourceIds: [row.id], score: -row.rank }));
      return { items, metadata: { engine: 'SQLite FTS5', tokenizer: 'trigram', queryTerms: terms, candidateLimit: 32 } };
    },
    async close() { for (const database of databases.values()) database.close(); databases.clear(); },
    diagnostics: () => ({ implementation: 'SQLite FTS5 built-in BM25', tokenizer: 'trigram', queryOperator: 'OR', candidateLimit: 32, corpora: corpusStats }),
  };
};
