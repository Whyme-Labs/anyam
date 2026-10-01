interface SiteEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
