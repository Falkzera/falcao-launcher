export type WorktreeInfo = {
  parent_id: string;
  parent_path: string;
  branch: string;
};

export type MonorepoParentInfo = {
  id: string;
  name: string;
  path: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  detected_script: string | null;
  available_scripts: string[];
  has_package_json: boolean;
  package_manager: string;
  favicon_data_uri: string | null;
  hidden: boolean;
  extra: boolean;
  worktree: WorktreeInfo | null;
  monorepo_parent: MonorepoParentInfo | null;
};

export type LogLine = {
  stream: "stdout" | "stderr";
  line: string;
  ts: number;
};

export type LogPayload = {
  id: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type StatusPayload = {
  id: string;
  status: "running" | "stopped" | "crashed";
  code: number | null;
  message: string | null;
};

export type PortPayload = {
  id: string;
  port: number;
  url: string;
};

export type AllocatedPortsPayload = {
  id: string;
  frontend_port: number | null;
  backend_port: number | null;
};

export type ProjectConfig = {
  frontend_port: number | null;
  backend_port: number | null;
  custom_icon_path: string | null;
};

export type IconCandidate = {
  relative_path: string;
  data_uri: string;
  size_bytes: number;
};

export type ProjectStatus = "idle" | "running" | "crashed" | "external";

export type SystemListener = {
  port: number;
  pid: number;
  address: string;
  cwd: string | null;
  cmd: string | null;
};

export type AggregatedUsage = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
};

export type ClaudeSession = {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  title: string | null;
  model: string | null;
  started_at: number;
  last_activity: number;
  message_count: number;
  duration_ms: number;
  usage: AggregatedUsage;
};

export type ClaudeProjectState = {
  project_path: string;
  sessions: ClaudeSession[];
  active_session_id: string | null;
  total_usage: AggregatedUsage;
};

export type Granularity = "day" | "month" | "year";

export type TokenBucket = {
  bucket_start: number;
  usage: AggregatedUsage;
};
