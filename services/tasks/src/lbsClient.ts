export type LbsTaskStatus = "todo" | "done" | "skipped";

export interface LbsClientConfig {
  baseUrl: string;
  authBaseUrl?: string;
  authLoginPath?: string;
  authUserCreatePath?: string;
  timezone: string;
  apiKey?: string;
  sharedToken?: string;
}

type QueryPrimitive = string | number | boolean | Date | null | undefined;
type QueryValue = QueryPrimitive | QueryPrimitive[];

interface LbsRequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  authToken?: string;
  allowSharedAuth?: boolean;
  expectText?: boolean;
  contentType?: string;
}

export interface LbsScheduleTask {
  task_id: string;
  task_name: string;
  context: string;
  status?: string | null;
  load?: number;
  start_time?: string | null;
  end_time?: string | null;
  is_locked?: boolean | null;
}

export interface LbsScheduleDay {
  date: string;
  total_load?: number;
  base_load?: number;
  cap?: number;
  level?: string;
  tasks: LbsScheduleTask[];
}

function toQueryString(query?: Record<string, QueryValue>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      if (value instanceof Date) {
        params.append(key, value.toISOString().slice(0, 10));
        continue;
      }
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export class LbsClient {
  private readonly baseUrl: string;
  private readonly authBaseUrl: string;
  private readonly timezone: string;
  private readonly apiKey?: string;
  private readonly sharedToken?: string;
  private readonly authLoginPath: string;
  private readonly authUserCreatePath: string;
  private authToken?: string;

  constructor(config: LbsClientConfig, authToken?: string) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.authBaseUrl = normalizeBaseUrl(config.authBaseUrl || config.baseUrl);
    this.timezone = config.timezone;
    this.apiKey = config.apiKey;
    this.sharedToken = config.sharedToken;
    this.authLoginPath = config.authLoginPath || "/auth/login";
    this.authUserCreatePath = config.authUserCreatePath || "/users/";
    this.authToken = authToken;
  }

  setAuthToken(authToken?: string): void {
    this.authToken = authToken;
  }

  private resolveAuthHeader(explicitToken?: string, allowSharedAuth = false): Record<string, string> {
    const token = explicitToken || this.authToken;
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }
    if (allowSharedAuth && this.apiKey) {
      return { "X-API-KEY": this.apiKey };
    }
    if (allowSharedAuth && this.sharedToken) {
      return { Authorization: `Bearer ${this.sharedToken}` };
    }
    throw new Error("LBS user token is missing for this request");
  }

  private async request<T>(method: string, path: string, options: LbsRequestOptions = {}): Promise<T> {
    const query = toQueryString(options.query);
    const endpoint = path.replace(/^\/+/, "");
    const url = `${this.baseUrl}/${endpoint}${query}`;
    const headers: Record<string, string> = {
      Accept: options.expectText ? "text/plain" : "application/json",
      "X-Timezone": this.timezone,
      ...this.resolveAuthHeader(options.authToken, options.allowSharedAuth),
      ...(options.headers || {})
    };

    if (!options.expectText) {
      headers["Content-Type"] = options.contentType || "application/json";
    } else if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined
          ? undefined
          : (options.contentType && options.contentType !== "application/json")
            ? String(options.body)
            : JSON.stringify(options.body)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown network error";
      throw new Error(`LBS_UNREACHABLE: unable to reach ${this.baseUrl} (${detail})`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `LBS request failed: ${method} ${path} (${response.status})`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    if (options.expectText) {
      return (await response.text()) as T;
    }

    const text = await response.text();
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  private async requestAuth<T>(method: string, basePath: string, body?: unknown): Promise<T> {
    const endpoint = basePath.startsWith("/") ? basePath : `/${basePath}`;
    const url = `${this.authBaseUrl}${endpoint}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown network error";
      throw new Error(`LBS_UNREACHABLE: unable to reach ${this.authBaseUrl} (${detail})`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `LBS auth request failed: ${method} ${endpoint} (${response.status})`);
    }
    if (!text.trim()) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  async login(usernameOrEmail: string, password: string): Promise<Record<string, unknown>> {
    return this.requestAuth("POST", this.authLoginPath, {
      username_or_email: usernameOrEmail,
      password
    });
  }

  async createUser(email: string, name: string, password: string): Promise<Record<string, unknown>> {
    return this.requestAuth("POST", this.authUserCreatePath, {
      email,
      name,
      password
    });
  }

  async authMe(): Promise<Record<string, unknown>> {
    return this.request("GET", "auth/me", { allowSharedAuth: true });
  }

  async provisionApiKey(rotate = false, scopes: string[] = ["read"]): Promise<Record<string, unknown>> {
    return this.request("POST", "auth/api-keys/provision", {
      allowSharedAuth: true,
      body: { rotate, scopes }
    });
  }

  async listApiKeys(): Promise<Record<string, unknown>[]> {
    return this.request("GET", "auth/api-keys", { allowSharedAuth: true });
  }

  async createApiKey(clientId: string, scopes: string[] = ["read"], expiresInDays = 30): Promise<Record<string, unknown>> {
    return this.request("POST", "auth/api-keys", {
      allowSharedAuth: true,
      body: { client_id: clientId, scopes, expires_in_days: expiresInDays }
    });
  }

  async revokeApiKey(keyId: string): Promise<Record<string, unknown>> {
    return this.request("DELETE", `auth/api-keys/${encodeURIComponent(keyId)}`, { allowSharedAuth: true });
  }

  async listTasks(context?: string, active?: boolean): Promise<Record<string, unknown>[]> {
    return this.request("GET", "tasks", {
      query: {
        context,
        active: active === undefined ? undefined : String(active)
      }
    });
  }

  async getTask(taskId: string, targetDate?: string): Promise<Record<string, unknown>> {
    return this.request("GET", `tasks/${encodeURIComponent(taskId)}`, {
      query: { target_date: targetDate }
    });
  }

  async createTask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "tasks", { body: payload });
  }

  async updateTask(taskId: string, payload: Record<string, unknown>, forceOverride = false): Promise<Record<string, unknown>> {
    return this.request("PUT", `tasks/${encodeURIComponent(taskId)}`, {
      query: { force_override: String(forceOverride) },
      body: payload
    });
  }

  async deleteTask(taskId: string, forceOverride = false): Promise<void> {
    await this.request<void>("DELETE", `tasks/${encodeURIComponent(taskId)}`, {
      query: { force_override: String(forceOverride) }
    });
  }

  async bulkDeleteTasks(taskIds: string[], forceOverride = false): Promise<Record<string, unknown>> {
    return this.request("POST", "tasks/bulk-delete", {
      query: { force_override: String(forceOverride) },
      body: { task_ids: taskIds }
    });
  }

  async bulkUpdateActive(taskIds: string[], active: boolean, forceOverride = false): Promise<Record<string, unknown>> {
    return this.request("POST", "tasks/bulk-update-active", {
      query: { force_override: String(forceOverride) },
      body: { task_ids: taskIds, active }
    });
  }

  async resolveTask(taskId: string, targetDate: string): Promise<Record<string, unknown>> {
    return this.request("GET", `tasks/${encodeURIComponent(taskId)}/resolved`, {
      query: { target_date: targetDate }
    });
  }

  async completeTask(taskId: string, targetDate: string, status: LbsTaskStatus): Promise<Record<string, unknown>> {
    return this.request("POST", `tasks/${encodeURIComponent(taskId)}/complete`, {
      body: {
        target_date: targetDate,
        status
      }
    });
  }

  async getTaskHistory(taskId: string, startDate: string, endDate: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `tasks/${encodeURIComponent(taskId)}/history`, {
      query: {
        start_date: startDate,
        end_date: endDate
      }
    });
  }

  async uploadTasksCsv(csvContent: string): Promise<Record<string, unknown>> {
    return this.request("POST", "tasks/upload-csv", {
      body: csvContent,
      contentType: "text/csv"
    });
  }

  async exportTasksCsv(): Promise<string> {
    return this.request<string>("GET", "tasks/export-csv", { expectText: true });
  }

  async getSchedule(startDate: string, endDate: string): Promise<LbsScheduleDay[]> {
    return this.request("GET", "schedule", {
      query: {
        start_date: startDate,
        end_date: endDate
      }
    });
  }

  async getDashboard(startDate?: string): Promise<Record<string, unknown>> {
    return this.request("GET", "dashboard", { query: { start_date: startDate } });
  }

  async getHeatmap(start: string, end: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>[]> {
    return this.request("GET", "heatmap", {
      query: {
        start,
        end,
        status: statuses
      }
    });
  }

  async getTrends(weeks = 12, startDate?: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>> {
    return this.request("GET", "trends", {
      query: {
        weeks,
        start_date: startDate,
        status: statuses
      }
    });
  }

  async getContextDistribution(start: string, end: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>> {
    return this.request("GET", "context-distribution", {
      query: {
        start,
        end,
        status: statuses
      }
    });
  }

  async calculateLoad(targetDate: string, statuses?: LbsTaskStatus[]): Promise<Record<string, unknown>> {
    return this.request("GET", `calculate/${encodeURIComponent(targetDate)}`, {
      query: { status: statuses }
    });
  }

  async forceExpand(startDate: string, endDate: string): Promise<Record<string, unknown>> {
    return this.request("POST", "expand", {
      query: {
        start_date: startDate,
        end_date: endDate
      }
    });
  }

  async listExceptions(taskId?: string, startDate?: string, endDate?: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", "exceptions", {
      query: {
        task_id: taskId,
        start_date: startDate,
        end_date: endDate
      }
    });
  }

  async createException(payload: Record<string, unknown>, forceOverride = false): Promise<Record<string, unknown>> {
    return this.request("POST", "exceptions", {
      query: { force_override: String(forceOverride) },
      body: payload
    });
  }

  async updateException(exceptionId: number, payload: Record<string, unknown>, forceOverride = false): Promise<Record<string, unknown>> {
    return this.request("PUT", `exceptions/${exceptionId}`, {
      query: { force_override: String(forceOverride) },
      body: payload
    });
  }

  async deleteException(exceptionId: number, forceOverride = false): Promise<void> {
    await this.request<void>("DELETE", `exceptions/${exceptionId}`, {
      query: { force_override: String(forceOverride) }
    });
  }

  async createCondition(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "conditions", { body: payload });
  }

  async getCondition(targetDate: string): Promise<Record<string, unknown>> {
    return this.request("GET", `conditions/${encodeURIComponent(targetDate)}`);
  }

  async deleteCondition(targetDate: string): Promise<void> {
    await this.request<void>("DELETE", `conditions/${encodeURIComponent(targetDate)}`);
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    return this.request("GET", "health", { allowSharedAuth: true });
  }
}
