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
};

export type ProjectStatus = "idle" | "running" | "crashed";
