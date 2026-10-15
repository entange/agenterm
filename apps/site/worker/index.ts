/**
 * The site is static assets; this Worker only answers /download/*. It counts
 * the download in D1, then sends the browser on to the DMG on GitHub. A row
 * holds the version, the architecture, the country, and the time: nothing
 * that identifies a person.
 */

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

const REPO = 'entange/agenterm';
const DOWNLOAD = /^\/download\/(arm64|x64)\/(\d+\.\d+\.\d+)$/;
/** Link previews and crawlers that follow links without downloading anything. */
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly/i;

export default {
  fetch(request, env, ctx) {
    const match = DOWNLOAD.exec(new URL(request.url).pathname);
    if (match === null) return env.ASSETS.fetch(request);
    const [, arch = '', version = ''] = match;

    if (request.method === 'GET' && !BOTS.test(request.headers.get('user-agent') ?? '')) {
      const count = env.DB.prepare('INSERT INTO downloads (version, arch, country) VALUES (?, ?, ?)')
        .bind(version, arch, request.cf?.country ?? null)
        .run()
        .catch((error: unknown) => console.error('could not count a download', error));
      // The redirect does not wait for the write.
      ctx.waitUntil(count);
    }

    return Response.redirect(
      `https://github.com/${REPO}/releases/download/v${version}/agenterm-${version}-${arch}-mac.dmg`,
      302
    );
  }
} satisfies ExportedHandler<Env>;
