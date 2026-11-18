import { handles, suggestedHandles } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import { approveHandle, dismissHandle, updateHandle } from "../actions";
import { Msg, ist } from "../components";

export const metadata = { title: "Handles" };

const TYPES = ["venue", "organiser", "artist", "promoter", "college", "cultural_body", "cafe", "comedy_club", "community"];

export default async function HandlesPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  const [suggested, list] = await Promise.all([suggestedHandles(), handles()]);
  const active = list.filter((h) => h.active).length;
  return (
    <>
      <h1>Handles</h1>
      <Msg msg={msg} />
      <h2>Suggested ({suggested.length})</h2>
      <p className="muted small">Accounts tagged or credited in event posts. Tier A is checked daily, tier B weekly. Open the profile before approving.</p>
      <table className="admin-table">
        <thead><tr><th>Handle</th><th>Seen</th><th>Why</th><th>Add as</th><th></th></tr></thead>
        <tbody>
          {suggested.map((s) => (
            <tr key={s.id}>
              <td><a href={`https://www.instagram.com/${s.handle}/`} rel="noopener nofollow" target="_blank">@{s.handle}</a><span className="block muted small">{s.city ?? ""} · {ist(s.created_at)}</span></td>
              <td>{s.seen_count}</td>
              <td className="small">{s.reason}{s.first_seen_post && <> · <a href={`https://www.instagram.com/p/${s.first_seen_post}/`} rel="noopener nofollow" target="_blank">post</a></>}</td>
              <td>
                <form action={approveHandle} className="inline">
                  <input type="hidden" name="id" value={s.id} />
                  <select name="type" aria-label="Type" defaultValue="venue">{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
                  <select name="tier" aria-label="Tier" defaultValue="B"><option>A</option><option>B</option></select>
                  <button className="button small-button">Approve</button>
                </form>
              </td>
              <td><form action={dismissHandle}><input type="hidden" name="id" value={s.id} /><button className="button ghost small-button">Dismiss</button></form></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Handle list ({active} active of {list.length})</h2>
      <table className="admin-table">
        <thead><tr><th>Handle</th><th>Type</th><th>City</th><th>Last checked</th><th>Tier and status</th></tr></thead>
        <tbody>
          {list.map((h) => (
            <tr key={h.id} className={h.active ? undefined : "muted"}>
              <td><a href={`https://www.instagram.com/${h.handle}/`} rel="noopener nofollow" target="_blank">@{h.handle}</a></td>
              <td>{h.handle_type}</td><td>{h.city}</td><td className="small">{ist(h.last_checked_at)}</td>
              <td>
                <form action={updateHandle} className="inline">
                  <input type="hidden" name="id" value={h.id} />
                  <select name="tier" aria-label={`Tier for ${h.handle}`} defaultValue={h.tier}><option>A</option><option>B</option></select>
                  <label className="small"><input type="checkbox" name="active" defaultChecked={h.active} /> active</label>
                  <button className="button ghost small-button">Save</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
