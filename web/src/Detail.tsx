import { fullAddress, appleMapsUrl, googleMapsUrl } from './format';

// Resource detail card: everything we legitimately know about a stop, plus
// deep links out to Apple/Google Maps for turn-by-turn and to Google for
// photos/reviews/live hours. We never scrape those — the user's device does
// the looking, in the provider's own app, under the provider's own terms.

const CAT_LABEL: Record<string, string> = {
  wifi_work: 'Wi-Fi / Work', campground: 'Campground', hotel: 'Hotel / Motel',
};
const CAT_COLOR: Record<string, string> = {
  wifi_work: '#d97706', campground: '#059669', hotel: '#7c3aed',
};
const WIFI_TEXT: Record<string, string> = {
  confirmed: 'Wi-Fi documented in OSM',
  likely: 'Wi-Fi likely for this type of place (unverified)',
  unknown: 'Wi-Fi unknown',
  none: 'Wi-Fi reported unavailable',
};
const ATTR_LABEL: Record<string, string> = {
  shower: 'showers', drinking_water: 'water', toilets: 'restrooms',
  tents: 'tents', fee: 'fee', reservation: 'reservation',
  internet_access: 'internet', cuisine: 'cuisine', opening_hours: 'hours',
};

export interface ResourceInfo {
  id: string; category: string; name: string; brand?: string | null;
  routeMile: number; offRouteMi: number | null; milesAhead?: number;
  wifiStatus?: string | null; website?: string | null; hours?: string | null;
  address?: string | null; phone?: string | null;
  attributes?: string | null; sources?: string | null; lastVerified?: string | null;
  lat: number; lng: number;
  town?: string | null; state?: string | null;
}

export default function ResourceDetail({ r, onClose }: { r: ResourceInfo; onClose: () => void }) {
  let attrs: Record<string, string> = {};
  try { attrs = JSON.parse(r.attributes ?? '{}'); } catch { /* absent on ride items */ }
  const addr = fullAddress(r);
  const q = encodeURIComponent([r.name, addr].filter(Boolean).join(' '));
  const osmSrc = (r.sources ?? '').split(',').find((s) => s.startsWith('osm:'));
  const osmUrl = osmSrc ? `https://www.openstreetmap.org/${osmSrc.slice(4)}` : null;

  return (
    <div className="detail" style={{ borderTopColor: CAT_COLOR[r.category] ?? '#94a3b8' }}>
      <div className="detail-head">
        <div>
          <div className="detail-name">{r.name}</div>
          <div className="dim">
            {CAT_LABEL[r.category] ?? r.category}{r.brand && r.brand !== r.name ? ` · ${r.brand}` : ''}
          </div>
        </div>
        <button className="detail-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="detail-facts">
        <div>
          <b>Mile {r.routeMile}</b>
          {r.offRouteMi != null && <> · {r.offRouteMi} mi off route</>}
          {r.milesAhead != null && <> · <b>{r.milesAhead} mi ahead</b></>}
        </div>
        {r.wifiStatus && <div className="badge">{WIFI_TEXT[r.wifiStatus] ?? r.wifiStatus}</div>}
        {r.hours && <div className="dim">Hours: {r.hours}</div>}
        {addr && <div className="addr-line">{addr}</div>}
        {Object.keys(attrs).length > 0 && (
          <div className="attr-chips">
            {Object.entries(attrs).map(([k, v]) => (
              <span key={k} className="attr-chip">
                {ATTR_LABEL[k] ?? k}{v !== 'yes' ? `: ${v}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="detail-actions">
        <a className="act" target="_blank" rel="noreferrer"
          href={appleMapsUrl(r.lat, r.lng, r)}>Apple Maps</a>
        <a className="act" target="_blank" rel="noreferrer"
          href={googleMapsUrl(r.lat, r.lng)}>🚲 Google Maps</a>
        <a className="act" target="_blank" rel="noreferrer"
          href={`https://www.google.com/search?q=${q}`}>🔎 Google</a>
        {r.website && <a className="act" target="_blank" rel="noreferrer" href={r.website}>🌐 Website</a>}
        {r.phone && <a className="act" href={`tel:${r.phone}`}>📞 {r.phone}</a>}
      </div>

      <div className="detail-src dim">
        {r.sources && <>Source: {r.sources}{r.lastVerified ? ` · retrieved ${String(r.lastVerified).slice(0, 10)}` : ''}. </>}
        {osmUrl && <a href={osmUrl} target="_blank" rel="noreferrer">View on OSM</a>}
        <div>Hours, Wi-Fi, and existence can change — the map links above show live info.</div>
      </div>
    </div>
  );
}
