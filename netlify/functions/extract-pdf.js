/* ============================================================
   Terräng — extract-pdf
   Tolkar en fastighetsportfölj-PDF och extraherar objekt till
   Terrängs datamodell. Modell: Claude Sonnet 4.6 (vision).
   API-nyckel och promptlogik hålls serverside (IP-skydd).
   ============================================================ */

const MODEL = 'claude-sonnet-4-6';

const SYSTEM = `Du är en extraktionsmotor för svensk kommersiell fastighetsanalys. Du läser ett portfölj-/projektdokument (PDF, ofta med kartor, flygfoton och detaljplanekartor) och extraherar varje enskild fastighet till strukturerad JSON.

ABSOLUTA REGLER:
- Extrahera ENDAST det som faktiskt står i dokumentet. Hitta ALDRIG på värden. Saknas ett fält → använd "" (tom sträng) eller [] (tom lista). Gissa inte byggrätt, år eller andelar.
- Ett objekt per namngiven fastighet/projekt. Översiktssidor (kartor med numrerade listor) ger inte egna objekt — de hjälper dig bara koppla nummer till ort.
- Behåll svenska beteckningar exakt som de står (t.ex. "Smältaren 5-7", "Växjö 13:21", "Gränna 8:4 m fl").
- Sätt "ort" till den ort/stad rubriken anger (Växjö, Värnamo, Älmhult, Gränna …). "kommun" sätts om det framgår, annars samma som ort om rimligt, annars "".
- För medgiven användning: extrahera planbeteckningarna som de står som en lista av koder, t.ex. ["B","C"], ["S","B","H","K"], ["Industri"]. "drivmedelsförsäljning" → behåll som egen post om den nämns.
- byggnadshöjd anges i meter utan enhet (t.ex. "28"). vaningar som intervall/tal som det står (t.ex. "3-5", "12").
- DP-status: "gallande" om en gällande/lagakraftvunnen detaljplan beskrivs; "pagaende" om planarbete pågår/revideras/beräknas antas; "saknas" om fastigheten uttryckligen inte är detaljplanelagd.
- Vid pågående DP: fyll pagaende.skede ("Uppstart"/"Samråd"/"Granskning"/"Inför antagande" om det framgår, annars ""), pagaende.forvantatAntagande (t.ex. "hösten 2026", "2028"), och pagaende.syfte (vad planen ska möjliggöra).
- Ägarstruktur: typ "delagt" ENDAST om dokumentet uttryckligen nämner delägande/JV-bolag (t.ex. "ägs av X AB där GBJ bygg är delägare"). Fyll då bolag, andel (om angiven, t.ex. "ca 23 %") och ovrigaDelagare. Annars "helagt".

KVALITETSFLAGGOR (mycket viktigt):
- Lägg in en sträng i "_extractFlags" när du upptäcker något som bör verifieras, särskilt:
  • Om ett objekts läges-/DP-text verkar vara felkopierad från ett ANNAT objekt (t.ex. en Värnamo-fastighet vars DP-text beskriver ett område i Växjö). Skriv vilken text som ser felklistrad ut.
  • Om en bildtext/uppgift verkar matcha fel objekt.
  • Om uppgifter är motsägelsefulla eller otydliga.
- Hitta inte på flaggor; flagga bara verkliga inkonsistenser du ser i materialet.

Svara med ENBART giltig JSON, ingen inledning, ingen förklaring, inga markdown-backticks. Format:
{
  "objekt": [
    {
      "beteckning": "",
      "ort": "",
      "kommun": "",
      "lage": "",
      "agarstruktur": { "typ": "helagt", "bolag": "", "andel": "", "ovrigaDelagare": "" },
      "dp": {
        "status": "gallande",
        "lagaKraftAr": "",
        "medgivenAnvandning": [],
        "byggratt": { "vaningar": "", "byggnadshojd": "", "etal": "", "bta": "" },
        "pagaende": { "skede": "", "forvantatAntagande": "", "syfte": "" }
      },
      "befintligBebyggelse": "",
      "areal": "",
      "taxeringsvarde": "",
      "_extractFlags": []
    }
  ]
}`;

const USER = `Extrahera samtliga fastigheter ur det bifogade portföljdokumentet till JSON enligt schemat i systeminstruktionen. Var noggrann med att koppla rätt ort till rätt fastighet och att flagga eventuella felkopierade texter mellan objekt. Svara med enbart JSON.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return resp(405, { error: 'Endast POST.' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key)
    return resp(500, { error: 'ANTHROPIC_API_KEY saknas i Netlify-miljövariablerna.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return resp(400, { error: 'Ogiltig JSON i anropet.' }); }

  const { pdfBase64 } = body;
  if (!pdfBase64) return resp(400, { error: 'pdfBase64 saknas.' });

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
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: USER }
          ]
        }]
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
    if (!parsed || !Array.isArray(parsed.objekt))
      return resp(502, { error: 'Kunde inte tolka modellens svar som objektlista.' });

    return resp(200, { objekt: parsed.objekt });
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
