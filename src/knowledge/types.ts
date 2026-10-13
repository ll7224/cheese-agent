export type Scope = 'public' | 'project';

export type KnowledgeStatus =
  | 'candidate'
  | 'effective'
  | 'needs_review'
  | 'invalidated';

export type SourceKind =
  | 'local'
  | 'managed'
  | 'capture'
  | 'context7'
  | 'firecrawl';

export type QueryMode = 'fact' | 'experience';

export interface KnowledgeContext {
  workspaceId: string;
  workspacePath: string;
  agentId: string;
  runId?: string;
  role: 'owner' | 'collaborator' | 'guest';
}

export interface SourceSpan {
  startOffset: number;
  endOffset: number;
  startLine: number; // 1-based
  endLine: number;
}

export interface Citation {
  id: string;
  documentId: string;
  revisionId: string;
  sourceUri: string;
  span: SourceSpan;
  hash: string;
  commit?: string;
  status: KnowledgeStatus;
  evidenceKind: 'code' | 'document' | 'decision' | 'observation' | 'inference';
  libraryId?: string;
}

export interface CitationView {
  citation: Citation;
  content: string;
  currentRevisionId?: string;
  current: boolean;
}

export interface KnowledgeHit {
  text: string;
  score: number;
  citation: Citation;
}

export interface SearchRequest {
  query: string;
  mode: QueryMode;
  topK: number;
  libraryIds?: string[];
  includeGraph?: boolean;
}

export interface SearchResponse {
  generation: number;
  libraryIds: string[];
  hits: KnowledgeHit[];
  warnings: string[];
}

export type KnowledgeRequest =
  | { op: 'search'; input: SearchRequest }
  | { op: 'citation'; input: { citationId: string } }
  | { op: 'graph'; input: { entityId: string; hops: 1 | 2 } }
  | { op: 'ingest'; input: { path?: string; content?: string; name?: string; libraryId: string } };

export type KnowledgeRpc = (request: KnowledgeRequest) => Promise<unknown>;

export interface Library {
  id: string;
  name: string;
  description: string;
  scope: Scope;
  workspaceId?: string;
  role: 'basic' | 'domain' | 'project' | 'legacy';
  createdAt?: number;
}

export interface Source {
  id: string;
  libraryId: string;
  kind: SourceKind;
  locator: string;
  enabled: boolean;
  versionConstraint?: string;
  lastSyncAt?: number;
  lastError?: string;
  syncStatus?: 'ready' | 'syncing' | 'error';
  createdAt?: number;
}

export interface SourceProposal extends Source {
  sourceId: string;
  reason: string;
  enabled: false;
}

export interface ChunkRefDraft {
  text: string;
  span: SourceSpan;
  embedding?: number[];
  evidenceKind?: 'code' | 'document' | 'decision' | 'observation' | 'inference';
}

export interface RevisionDraft {
  sourceId: string;
  sourceKey: string;
  content: string;
  hash: string;
  commit?: string;
  expectedPreviousRevisionId: string | null;
  chunks: ChunkRefDraft[];
}

export interface EntityDraft {
  id: string;
  workspaceId: string;
  path: string;
  container?: string;
  kind: string;
  name: string;
  span: SourceSpan;
}

export interface EdgeDraft {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  kind: string;
  span?: SourceSpan;
}

export interface CodeIndex {
  entities: EntityDraft[];
  edges: EdgeDraft[];
}

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  path: string;
  libraryId?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  status: KnowledgeStatus;
}

export interface GraphView {
  generation: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface KnowledgeItem {
  id: string;
  kind: 'decision' | 'observation' | 'experience';
  status: KnowledgeStatus;
  text: string;
  libraryId: string;
  evidenceIds: string[];
  applicability?: string;
  originRunId?: string;
  supersedes?: string;
  createdAt?: number;
  updatedAt?: number;
}
