export type Source = "claude-code" | "codex" | "copilot-cli" | "eureka";

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
}

export interface Session {
  id: string;
  machineId: string;
  source: Source;
  projectPath: string;
  project: string;
  summary?: string;
  firstPrompt?: string;
  model: string;
  createdAt: string;
  modifiedAt: string;
  durationSeconds: number;
  turns: number;
  messageCount: number;
  toolCallCount: number;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  toolBreakdown: Record<string, number>;
  /** Per-model token breakdown from individual API calls. Used for "Cost by Model" aggregation. */
  modelUsage?: Record<string, TokenBreakdown>;
}

export interface FileCursor {
  path: string;
  inode: number;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  lastUpdatedAt?: string;
  processedAt: string;
}

export interface CursorState {
  version: 1;
  updatedAt: string;
  files: Record<string, FileCursor>;
}

export interface MachineData {
  machineId: string;
  hostname: string;
  os: string;
  lastUpdatedAt: string;
  sessions: Record<string, Session>;
  _cursor: CursorState;
}

export interface PrivacyConfig {
  sync: {
    includeSummary: boolean;
    includeFirstPrompt: boolean;
    includeProjectPath: boolean;
    includeProjectName: boolean;
  };
}

export interface ProjectDefinition {
  folders: string[];
  description?: string;
}

export interface ProjectConfig {
  projects: Record<string, ProjectDefinition>;
  excludeFolders: string[];
}

export interface PricingConfig {
  autoUpdate: boolean;
  updateIntervalHours: number;
}

export interface GitHubConfig {
  repo: string;
  branch: string;
}

export interface AppConfig extends ProjectConfig {
  machineId?: string;
  github: GitHubConfig;
  privacy: PrivacyConfig;
  pricing: PricingConfig;
}

export interface MachineInfo {
  machineId: string;
  hostname: string;
  sessionCount: number;
  lastUpdatedAt: string;
}

export interface DataFilters {
  days?: number;
  months?: number;
  project?: string;
  machine?: string;
}

export interface BreakdownItem {
  key: string;
  label: string;
  cost: number;
  sessions: number;
}

export interface ProjectTrend {
  previousCost: number;
  delta: number;
  deltaPct?: number;
}

export interface ProjectSummary {
  projectKey: string;
  projectLabel: string;
  totalCost: number;
  totalTokens: number;
  sessionCount: number;
  totalTurns: number;
  avgCostPerSession: number;
  avgTurnsPerSession: number;
  activeDays: number;
  topSource?: string;
  topModel?: string;
  topMachine?: string;
  tokenBreakdown: TokenBreakdown;
  costBreakdown: CostBreakdown;
  sourceBreakdown: BreakdownItem[];
  modelBreakdown: BreakdownItem[];
  machineBreakdown: BreakdownItem[];
  trend?: ProjectTrend;
}

export interface DataResponse {
  machines: MachineInfo[];
  sessions: Session[];
  totals: {
    sessions: number;
    turns: number;
    durationSeconds: number;
    tokens: TokenBreakdown;
    cost: CostBreakdown;
    cacheHitRate: number;
  };
  projects: ProjectSummary[];
}

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface LiteLLMPricingEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

export type LiteLLMPricing = Record<string, LiteLLMPricingEntry>;

export interface PricingSnapshot {
  fetchedAt: string;
  source: string;
  pricing: LiteLLMPricing;
}

export interface SyncResult {
  pulled: number;
  pushed: boolean;
}

export interface ParseResult {
  sessions: Session[];
  cursorUpdates: Record<string, FileCursor>;
}

export interface ParserContext {
  machineId: string;
  existingCursor: CursorState;
}

export interface Parser {
  source: Source;
  parse(context: ParserContext): Promise<ParseResult>;
}

export interface ParsedSessionSeed {
  id: string;
  source: Source;
  projectPath: string;
  summary?: string;
  firstPrompt?: string;
  model: string;
  createdAt: string;
  modifiedAt: string;
  durationSeconds: number;
  turns: number;
  messageCount: number;
  toolCallCount: number;
  tokens: TokenBreakdown;
  toolBreakdown: Record<string, number>;
}
