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

function getErrorMessage(json: unknown): string | null {
  if (!json || typeof json !== "object" || !("errors" in json)) {
    return null;
  }

  const { errors } = json as { errors: unknown };
  return typeof errors === "string" ? errors : String(errors);
}

export class BeeminderApi {
  private readonly getToken: () => Promise<string | null>;

  // eslint-disable-next-line obsidianmd/prefer-active-doc
  constructor(getToken: () => Promise<string | null>) {
    this.getToken = getToken;
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "DELETE"; body?: string; contentType?: string } = {}
  ): Promise<T> {
    const token = await this.getToken();
    if (!token) {
      throw new Error("Missing Beeminder auth token.");
    }

    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("auth_token", token);

    const resp = await requestUrl({
      url: url.toString(),
      method: options.method ?? "GET",
      body: options.body,
      contentType: options.contentType,
    });

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
  ): Promise<string> {
    const params = new URLSearchParams({
      value: String(datapoint.value),
    });
    if (datapoint.comment) params.set("comment", datapoint.comment);
    if (datapoint.daystamp) params.set("daystamp", datapoint.daystamp);
    if (datapoint.requestid) params.set("requestid", datapoint.requestid);

    const resp = await this.request<{ id: string }>(
      `/users/${encodeURIComponent(username)}/goals/${encodeURIComponent(goalSlug)}/datapoints.json`,
      {
        method: "POST",
        body: params.toString(),
        contentType: "application/x-www-form-urlencoded",
      }
    );
    return resp.id;
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
