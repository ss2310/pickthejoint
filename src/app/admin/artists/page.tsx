import { artistTracking, budgets } from "@/config";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { monthSpend } from "@/lib/budget-guard";
import { trackedArtists } from "@/lib/pipeline/artist-tracking";
import { decideVideo, pinArtist, recheckVideos, setArtistLink, toggleUpdate } from "../artist-actions";
import { Msg, ist, usd } from "../components";

export const metadata = { title: "Artists" };

interface VideoRow {
  id: number; artist_id: number; artist: string; slug: string; video_id: string; title: string; published_year: number | null;
  blurb: string | null; channel_title: string | null; view_count: number | null; status: string; videos_note: string | null;
}

export default async function ArtistsAdminPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  const pool = getPool();
  const tracked = await trackedArtists(pool);
  const extra = new Map((await pool.query<{ id: number; youtube: string | null; videos_checked_at: Date | null; videos_note: string | null; approved: number; pending: number; is_handle: boolean }>(
    `SELECT a.id, a.official_links->>'youtube' AS youtube, a.videos_checked_at, a.videos_note,
            (SELECT count(*) FROM artist_videos v WHERE v.artist_id = a.id AND v.status = 'approved')::int AS approved,
            (SELECT count(*) FROM artist_videos v WHERE v.artist_id = a.id AND v.status = 'pending')::int AS pending,
            EXISTS (SELECT 1 FROM handles h WHERE h.active AND h.handle = lower(a.official_links->>'instagram')) AS is_handle
     FROM artists a WHERE a.id = ANY($1)`, [tracked.map((a) => a.id)])).rows.map((r) => [r.id, r]));
  const videos = (await pool.query<VideoRow>(
    `SELECT v.id, v.artist_id, a.name AS artist, a.slug, v.video_id, v.title, v.published_year, v.blurb, v.channel_title, v.view_count, v.status, a.videos_note
     FROM artist_videos v JOIN artists a ON a.id = v.artist_id WHERE v.status = 'pending' ORDER BY a.name, v.position, v.id`)).rows;
  const posts = (await pool.query<{ id: number; artist: string; slug: string; post_url: string; posted_at: Date | null; label: string; reason: string | null; update_text: string | null; hidden: boolean; confidence: string | null }>(
    `SELECT p.id, a.name AS artist, a.slug, p.post_url, p.posted_at, p.label, p.reason, p.update_text, p.hidden, p.confidence
     FROM artist_posts p JOIN artists a ON a.id = p.artist_id ORDER BY p.created_at DESC, p.id DESC LIMIT 80`)).rows;
  const spend = { scrape: await monthSpend("artistTracking", { pool }), text: await monthSpend("artistText", { pool }) };
  const byArtist = new Map<number, VideoRow[]>();
  for (const v of videos) byArtist.set(v.artist_id, [...(byArtist.get(v.artist_id) ?? []), v]);
  const updates = posts.filter((p) => p.label === "new_release");
  const LABEL: Record<string, string> = { new_show: "new show: sent to the event pipeline", event_change: "change to a show: sent to the event pipeline", new_release: "new release", other: "ignored" };

  return (
    <>
      <h1>Artists</h1>
      <Msg msg={msg} />
      <p className="small">
        This month: checking artists&apos; Instagram {usd(spend.scrape)} of {usd(budgets.artistTracking)} · sorting posts and writing notes (model) {usd(spend.text)} of {usd(budgets.artistText)}.
        {" "}YouTube look-ups are free ({artistTracking.videoLookupsPerRun} artists a run at most).{artistTracking.youtubeApiKey ? "" : " YOUTUBE_API_KEY is not set on this service."}
      </p>

      <h2>Tracked now ({tracked.length} of at most {artistTracking.maxTracked})</h2>
      <p className="muted small">
        An artist is tracked from {artistTracking.upcomingDays} days before an event in one of our cities until {artistTracking.stopAfterDays} days after their last one, or for as long as
        you pin them. Every 3 days their newest Instagram posts are read: a show announcement goes to the event pipeline, a new release becomes a dated line on their page, everything else is ignored.
      </p>
      <form action={pinArtist} className="form-grid">
        <label className="field">Pin an artist (page address or slug)<input name="slug" placeholder="/artists/the-yellow-diary" required /></label>
        <p><button className="button">Pin</button></p>
      </form>
      <table className="admin-table">
        <thead><tr><th>Artist</th><th>Why</th><th>Instagram</th><th>Posts last checked</th><th>YouTube</th><th>Videos</th><th></th></tr></thead>
        <tbody>
          {tracked.map((a) => {
            const x = extra.get(a.id);
            return (
              <tr key={a.id}>
                <td><a href={`/artists/${a.slug}`}>{a.name}</a></td>
                <td className="small">{a.pinned ? "pinned" : ""}{a.pinned && a.events.length ? "; " : ""}{a.events.length ? `event ${a.events[0].date}, ${a.events[0].city}` : ""}</td>
                <td className="small">
                  {a.handle ? <a href={`https://www.instagram.com/${a.handle}/`} rel="noopener nofollow" target="_blank">@{a.handle}</a> : (
                    <form action={setArtistLink}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="kind" value="instagram" />
                      <input name="value" placeholder="handle" aria-label={`Instagram handle for ${a.name}`} required /> <button className="button ghost small-button">Save</button></form>
                  )}
                  {x?.is_handle ? <span className="muted"> (already read as a handle)</span> : null}
                </td>
                <td className="small">{a.handle ? ist(a.tracking_checked_at) : "no account on record"}</td>
                <td className="small">
                  {x?.videos_note ?? (x?.videos_checked_at ? "" : "not looked up yet")}
                  <form action={setArtistLink}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="kind" value="youtube" />
                    <input name="value" defaultValue={x?.youtube ?? ""} placeholder="https://www.youtube.com/@name" aria-label={`YouTube channel for ${a.name}`} required /> <button className="button ghost small-button">Save</button></form>
                </td>
                <td className="small">{x?.approved ?? 0} live, {x?.pending ?? 0} waiting
                  <form action={recheckVideos}><input type="hidden" name="id" value={a.id} /><button className="button ghost small-button">Look up again</button></form>
                </td>
                <td>{a.pinned && <form action={pinArtist}><input type="hidden" name="slug" value={a.slug} /><input type="hidden" name="pinned" value="false" /><button className="button ghost small-button">Unpin</button></form>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Videos waiting for your approval ({videos.length})</h2>
      <p className="muted small">Nothing here shows on the site until you approve it. Check that the channel really is the artist&apos;s own, above all when it was found by a name search.</p>
      {[...byArtist.entries()].map(([artistId, list]) => (
        <section key={artistId}>
          <h3><a href={`/artists/${list[0].slug}`}>{list[0].artist}</a> <span className="muted small">channel: {list[0].channel_title}. {list[0].videos_note}</span></h3>
          <form action={decideVideo}><input type="hidden" name="artist_id" value={artistId} /><input type="hidden" name="decision" value="approve" /><button className="button small-button">Approve all {list.length}</button></form>
          <table className="admin-table">
            <thead><tr><th>Video</th><th>Year</th><th>Views</th><th>Text shown beside it</th><th></th></tr></thead>
            <tbody>
              {list.map((v) => (
                <tr key={v.id}>
                  <td><a href={`https://www.youtube.com/watch?v=${v.video_id}`} rel="noopener nofollow" target="_blank">{v.title}</a></td>
                  <td>{v.published_year ?? "–"}</td><td>{v.view_count?.toLocaleString("en-IN") ?? "–"}</td><td className="small">{v.blurb}</td>
                  <td>
                    <form action={decideVideo}><input type="hidden" name="id" value={v.id} /><input type="hidden" name="decision" value="approve" /><button className="button small-button">Approve</button></form>
                    <form action={decideVideo}><input type="hidden" name="id" value={v.id} /><input type="hidden" name="decision" value="reject" /><button className="button ghost small-button">Reject</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <h2>Release notes on artist pages ({updates.filter((u) => !u.hidden).length})</h2>
      <table className="admin-table">
        <thead><tr><th>Artist</th><th>Posted</th><th>Our line</th><th>Post</th><th></th></tr></thead>
        <tbody>
          {updates.map((u) => (
            <tr key={u.id} className={u.hidden ? "muted" : undefined}>
              <td><a href={`/artists/${u.slug}`}>{u.artist}</a></td><td className="small">{ist(u.posted_at)}</td><td>{u.update_text}</td>
              <td><a href={u.post_url} rel="noopener nofollow" target="_blank">open</a></td>
              <td><form action={toggleUpdate}><input type="hidden" name="id" value={u.id} /><button className="button ghost small-button">{u.hidden ? "Show" : "Hide"}</button></form></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Posts read recently</h2>
      <table className="admin-table">
        <thead><tr><th>Artist</th><th>Posted</th><th>Judged</th><th>Why</th><th>Post</th></tr></thead>
        <tbody>
          {posts.map((p) => (
            <tr key={p.id} className={p.label === "other" ? "muted" : undefined}>
              <td>{p.artist}</td><td className="small">{ist(p.posted_at)}</td><td className="small">{LABEL[p.label] ?? p.label}{p.confidence ? ` (${Number(p.confidence).toFixed(2)})` : ""}</td>
              <td className="small">{p.reason}</td><td><a href={p.post_url} rel="noopener nofollow" target="_blank">open</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
