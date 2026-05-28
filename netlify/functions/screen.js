/* ============================================================
   Terräng — screen
   Lätt screening av ETT objekt: sätter användningsspår,
   värdebärar-kategori A–E, larm och "varför intressant".
   Ingen webbsök (det hör till djupanalysen, steg 4).
   Modell: Claude Haiku 4.5 (snabb, billig, batch-vänlig).
   ============================================================ */

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = `Du är en screeningsmotor för svensk kommersiell fastighetsanalys. Du får EN fastighet (strukturerad JSON) plus en kort kontextlista över övriga objekt i samma portfölj. Du gör en SNABB klassificering utan webbsök. Du resonerar bara utifrån det som ges — inga externa fakta, inga påhittade siffror.

Klassificera fastigheten på två axlar.

1) ANVÄNDNINGSSPÅR ("spar") — hur fastigheten bör analyseras vidare:
- "bostad": planlagt/avsett främst för bostäder (B). Gapfrågan handlar om bostadssegment.
- "handel": handel/centrum/kontor/service (C, H, K). Gapfrågan handlar om vilken verksamhet som saknas i orten.
- "industri": industri/logistik/verksamhetsmark. Fokus läge, höjd, skyltläge, ev. förorening.
- "ramark": ej planlagd råmark / markreserv där värdet styrs av en framtida trigger (väg, plan).
- "jv": fastigheten ägs via delägt bolag/JV — analysen är bolags- och avtalsdriven snarare än markdriven.

2) VÄRDEBÄRAR-KATEGORI ("kategori") — A–E:
- "A" Likvid byggrätt: lagakraftvunnen DP som medger bostäder — direkt säljbar byggrätt.
- "B" Värdetrigger via planarbete: pågående DP som höjer/ändrar byggrätten; värdet realiseras vid laga kraft.
- "C" JV-andel: ägs via delägt bolag; köparen förvärvar en andel + inträde i partnerskap.
- "D" Verksamhet: industri-/handels-/verksamhetstomt vars värde styrs av läge och verksamhetsbehov.
- "E" Råmarksspekulation: ej planlagd mark vars uppsida hänger på en framtida infrastruktur-/plantrigger.
Prioritetsordning vid tvekan: om delägt → C går före övrigt. Annars välj den kategori som bäst fångar VARFÖR fastigheten är värd pengar.

LARM ("larm") — lista regelbaserade flaggor (typ + kort text). Sätt larm när något av detta gäller:
- "gammal_dp": gällande DP äldre än ca 20 år i centralt/attraktivt läge → utred outnyttjad byggrätt.
- "jv_avtal": delägt bolag → kräver granskning av aktieägaravtal, hembud/förköp, samtyckesrätt.
- "fororening": industri på äldre plan eller intill industriverksamhet → utred föroreningsrisk.
- "plan_risk": pågående DP i tidigt skede / centralt läge → tids- och överklaganderisk.
- "ingen_dp": ej planlagd → värdet förutsätter framtida planläggning.
Hitta inte på larm; sätt bara de som följer av indata. Tom lista om inga.

"varforIntressant": EN mening (max ~30 ord) på svenska som fångar affärspoängen. Nyktert, konkret, ingen säljhype.

Svara med ENBART giltig JSON, ingen inledning, inga backticks:
{ "spar":"", "kategori":"", "larm":[{"typ":"","text":""}], "varforIntressant":"" }`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return resp(405, { error: 'Endast POST.' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return resp(500, { error: 'ANTHROPIC_API_KEY saknas i Netlify-miljövariablerna.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return resp(400, { error: 'Ogiltig JSON i anropet.' }); }

  const { objekt, kontext } = body;
  if (!objekt) return resp(400, { error: 'objekt saknas.' });

  const userText =
    'FASTIGHET ATT SCREENA:\n' + JSON.stringify(objekt, null, 2) +
    '\n\nÖVRIGA OBJEKT I PORTFÖLJEN (endast kontext):\n' +
    JSON.stringify(kontext || [], null, 2) +
    '\n\nKlassificera fastigheten enligt instruktionen. Svara med enbart JSON.';

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{ role: 'user', content: userText }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || 'Claude API-fel.';
      return resp(r.status, { error: msg });
    }

    const text = (data.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n');

    const parsed = parseJson(text);
    if (!parsed || !parsed.spar)
      return resp(502, { error: 'Kunde inte tolka screeningsvaret.' });

    // normalisera
    const out = {
      spar: ['bostad','handel','industri','ramark','jv'].includes(parsed.spar) ? parsed.spar : 'handel',
      kategori: ['A','B','C','D','E'].includes(parsed.kategori) ? parsed.kategori : 'D',
      larm: Array.isArray(parsed.larm) ? parsed.larm.map(l => ({
        typ: (l && l.typ) || '', text: (l && (l.text || l)) || ''
      })) : [],
      varforIntressant: parsed.varforIntressant || ''
    };
    return resp(200, out);
  } catch (err) {
    return resp(500, { error: 'Serverfel: ' + (err.message || String(err)) });
  }
};

function parseJson(text) {
  let t = (text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try { return JSON.parse(t); } catch {}
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e !== -1 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return null;
}
function resp(status, obj) {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
