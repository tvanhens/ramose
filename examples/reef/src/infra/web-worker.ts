interface WebEnv {
  readonly PUBLIC_URL: string;
  readonly AUTH: Fetcher;
  readonly DATA: Fetcher;
}

export default {
  fetch(request: Request, env: WebEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      const headers = new Headers(request.headers);
      headers.set("x-reef-origin", new URL(env.PUBLIC_URL).origin);
      return env.AUTH.fetch(new Request(request, { headers }));
    }
    if (path.startsWith("/db/")) return env.DATA.fetch(request);
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  },
};
