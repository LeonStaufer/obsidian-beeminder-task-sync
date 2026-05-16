import { requestUrl } from "obsidian";

const BASE_URL = "https://www.beeminder.com/api/v1";

export interface BeeminderGoal {
  slug: string;
  title: string;
  goaltype: string;
  gunits: string;
  curval: number;
  rate: number;
  losedate: number;
}

export interface BeeminderDatapoint {
  value: number;
  comment?: string;
  daystamp?: string; // format: YYYYMMDD
  requestid?: string; // idempotency key
}

export interface CreateDatapointResult {
  id: string;
  alreadyExisted: boolean;
}

function getErrorMessage(json: unknown): string | null {
  if (!json || typeof json !== "object" || !("errors" in json)) {
    return null;
  }

  const { errors } = json;
  return typeof errors === "string" ? errors : String(errors);
}

function looksLikeDuplicateError(json: unknown, text: string): boolean {
  const needle = "duplicate datapoint";
  if (typeof text === "string" && text.toLowerCase().includes(needle)) return true;
  const message = getErrorMessage(json);
  return !!message && message.toLowerCase().includes(needle);
}

export class BeeminderApi {
  private readonly getToken: () => Promise<string | null>;

  constructor(getToken: () => Promise<string | null>) {
    this.getToken = getToken;
  }

  private async requestRaw(
    path: string,
    options: { method?: "GET" | "POST" | "DELETE"; body?: string; contentType?: string } = {}
  ) {
    const token = await this.getToken();
    if (!token) {
      throw new Error("Missing Beeminder auth token.");
    }

    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("auth_token", token);

    return requestUrl({
      url: url.toString(),
      method: options.method ?? "GET",
      body: options.body,
      contentType: options.contentType,
      throw: false,
    });
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "DELETE"; body?: string; contentType?: string } = {}
  ): Promise<T> {
    const resp = await this.requestRaw(path, options);

    if (resp.status >= 400) {
      const error = getErrorMessage(resp.json) ?? resp.text;
      throw new Error(error || `Beeminder API returned ${resp.status}`);
    }

    return resp.json as T;
  }

  async getUser(): Promise<{ username: string; goals: string[] }> {
    return this.request("/users/me.json");
  }

  async getGoals(username: string): Promise<BeeminderGoal[]> {
    return this.request(`/users/${encodeURIComponent(username)}/goals.json`);
  }

  async getGoalSlugs(username: string): Promise<string[]> {
    const goals = await this.getGoals(username);
    return goals.map((g) => g.slug);
  }

  async createDatapoint(
    username: string,
    goalSlug: string,
    datapoint: BeeminderDatapoint
  ): Promise<CreateDatapointResult> {
    const params = new URLSearchParams({
      value: String(datapoint.value),
    });
    if (datapoint.comment) params.set("comment", datapoint.comment);
    if (datapoint.daystamp) params.set("daystamp", datapoint.daystamp);
    if (datapoint.requestid) params.set("requestid", datapoint.requestid);

    const path = `/users/${encodeURIComponent(username)}/goals/${encodeURIComponent(goalSlug)}/datapoints.json`;
    const resp = await this.requestRaw(path, {
      method: "POST",
      body: params.toString(),
      contentType: "application/x-www-form-urlencoded",
    });

    // Beeminder returns 422 "duplicate datapoint" when a datapoint with the same
    // requestid (and identical fields) already exists. Recover its id so undo works.
    if (resp.status === 422 && datapoint.requestid && looksLikeDuplicateError(resp.json, resp.text)) {
      const existingId = await this.findDatapointIdByRequestId(username, goalSlug, datapoint.requestid);
      if (existingId) {
        return { id: existingId, alreadyExisted: true };
      }
    }

    if (resp.status >= 400) {
      const error = getErrorMessage(resp.json) ?? resp.text;
      throw new Error(error || `Beeminder API returned ${resp.status}`);
    }

    const json = resp.json as { id: string };
    return { id: json.id, alreadyExisted: false };
  }

  private async findDatapointIdByRequestId(
    username: string,
    goalSlug: string,
    requestId: string
  ): Promise<string | null> {
    const datapoints = await this.request<Array<{ id: string; requestid?: string }>>(
      `/users/${encodeURIComponent(username)}/goals/${encodeURIComponent(goalSlug)}/datapoints.json?sort=updated_at&count=300`
    );
    const match = datapoints.find((d) => d.requestid === requestId);
    return match ? match.id : null;
  }

  async deleteDatapoint(
    username: string,
    goalSlug: string,
    datapointId: string
  ): Promise<void> {
    await this.request(
      `/users/${encodeURIComponent(username)}/goals/${encodeURIComponent(goalSlug)}/datapoints/${encodeURIComponent(datapointId)}.json`,
      { method: "DELETE" }
    );
  }
}
