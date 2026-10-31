import { useEffect, useRef, useState } from 'react';
import { getTripKey } from './api';

// ASK — talk to the trip. Every answer is grounded in the live plan (the
// server assembles a snapshot per question), so this is the phone-side way to
// ask "where should I sleep tonight" without the laptop. Streams as it writes.

type Msg = { role: 'user' | 'assistant'; content: string; at: number };
const STORE = 'grimey-ask-history-v1';
const QUICK = [
  'Where should I sleep tonight?',
  'What do the next two days look like?',
  'Am I on pace for Nov 12?',
  'Where are the bed gaps ahead?',
  'Best wi-fi stop in the next 40 miles?',
  'What warnings are ahead of me?',
];

function load(): Msg[] { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; } }
function save(m: Msg[]) { try { localStorage.setItem(STORE, JSON.stringify(m.slice(-40))); } catch { /* private mode */ } }

export default function Ask({ curDay }: { curDay: number | null }) {
  const [msgs, setMsgs] = useState<Msg[]>(load);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { save(msgs); endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setErr(null); setText('');
    const history = msgs.slice(-8).map((m) => ({ role: m.role, content: m.content }));
    const next = [...msgs, { role: 'user' as const, content: question, at: Date.now() }, { role: 'assistant' as const, content: '', at: Date.now() }];
    setMsgs(next);
    setBusy(true);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'x-trip-key': getTripKey() },
        body: JSON.stringify({ question, history, dayNumber: curDay ?? undefined }),
      });
      if (!res.ok) {
        let m = `HTTP ${res.status}`;
        try { m = (await res.json()).error || m; } catch { /* keep */ }
        throw new Error(m);
      }
      const reader = res.body!.getReader(); const dec = new TextDecoder();
      let acc = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setMsgs((cur) => { const c = cur.slice(); c[c.length - 1] = { ...c[c.length - 1], content: acc }; return c; });
      }
    } catch (e) {
      const m = (e as Error).name === 'AbortError' ? 'stopped' : String((e as Error).message ?? e);
      setErr(m);
      setMsgs((cur) => cur[cur.length - 1]?.content === '' ? cur.slice(0, -1) : cur);
    }
    setBusy(false); abortRef.current = null;
  };

  return (
    <div className="ask">
      <div className="ask-head">
        <div className="stamp-box small"><b>ASK</b></div>
        <div className="ask-sub">Talk to the trip. It reads today's plan, the beds and wi-fi ahead, the warnings and your pace — right now, from the live data.</div>
      </div>
      {msgs.length === 0 && (
        <div className="ask-quick">
          {QUICK.map((q) => <button key={q} className="chip" onClick={() => send(q)}>{q}</button>)}
        </div>
      )}
      <div className="ask-log">
        {msgs.map((m, i) => (
          <div key={i} className={`ask-msg ${m.role}`}>
            {m.role === 'assistant' && m.content === '' && busy ? <span className="ask-typing">thinking…</span> : m.content}
          </div>
        ))}
        {err && <div className="err ask-err">{err.includes('not configured') ? 'The assistant isn\'t switched on yet — the site needs an Anthropic API key.' : err}</div>}
        <div ref={endRef} />
      </div>
      {msgs.length > 0 && (
        <div className="ask-quick compact">
          {QUICK.slice(0, 3).map((q) => <button key={q} className="chip" disabled={busy} onClick={() => send(q)}>{q}</button>)}
          <button className="linkish" onClick={() => { setMsgs([]); setErr(null); }}>clear</button>
        </div>
      )}
      <form className="ask-input" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input type="text" value={text} placeholder="ask about today, tonight, the next few days…" onChange={(e) => setText(e.target.value)} disabled={busy} autoComplete="off" />
        {busy
          ? <button type="button" className="ghost" onClick={() => abortRef.current?.abort()}>stop</button>
          : <button type="submit" className="primary" disabled={!text.trim()}>Ask</button>}
      </form>
    </div>
  );
}
